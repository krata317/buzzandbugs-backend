import { randomUUID } from 'node:crypto';
import type { OtpPurpose, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { hashEmail, hashIp, hashOtp, numericOtp, randomToken, sha256 } from '../../lib/crypto.js';
import { addDays, addMinutes } from '../../lib/time.js';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  LOGIN_COOLDOWN_MINUTES,
  LOGIN_FAIL_LIMIT,
  LOGIN_FAIL_WINDOW_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_LIMIT,
  OTP_RESEND_WINDOW_MINUTES,
  OTP_TTL_MINUTES,
  PASSWORD_RESET_TTL_MINUTES,
  REGISTRATION_TOKEN_TTL_MINUTES,
} from '../../config/constants.js';
import { consumeRateLimit } from '../../lib/rate-limit.js';
import { sendTransactionalEmail, queueEmail } from '../email/service.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import { createSession, revokeAllSessions } from './session.js';
import { getStorage } from '../storage/index.js';
import { renderBugAvatar } from '../storage/avatar.js';
import { getActiveBan } from '../moderation/penalties.js';

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'deleted',
  'squashedbug',
  'squashed',
  'buzz',
  'bugs',
  'api',
  'system',
  'moderator',
  'staff',
  'official',
  'help',
  'about',
  'settings',
  'login',
  'register',
  'me',
  'users',
  'posts',
  'news',
  'events',
  'trending',
  'notifications',
  'appeals',
  'search',
  'terms',
  'privacy',
]);

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const assertValidUsername = (username: string): void => {
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Usernames must be 3-20 characters and may only contain letters, numbers and underscores',
    );
  }
  if (RESERVED_USERNAMES.has(normalizeUsername(username))) {
    throw new AppError('VALIDATION_ERROR', 'That username is not available');
  }
};

const assertValidPassword = (password: string): void => {
  if (password.length < 8) {
    throw new AppError('VALIDATION_ERROR', 'Passwords must be at least 8 characters');
  }
  if (password.length > 128) {
    throw new AppError('VALIDATION_ERROR', 'Passwords must be at most 128 characters');
  }
};

const invalidateOtps = async (emailNormalized: string, purpose: OtpPurpose): Promise<void> => {
  await prisma.emailOtp.updateMany({
    where: { emailNormalized, purpose, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
};

const issueOtp = async (
  emailNormalized: string,
  purpose: OtpPurpose,
  ip: string | undefined,
): Promise<string> => {
  const code = numericOtp(6);
  await invalidateOtps(emailNormalized, purpose);
  await prisma.emailOtp.create({
    data: {
      emailNormalized,
      purpose,
      codeHash: hashOtp(emailNormalized, purpose, code),
      expiresAt: addMinutes(new Date(), OTP_TTL_MINUTES),
      ipHash: hashIp(ip),
    },
  });
  return code;
};

const enforceOtpRequestLimits = async (
  emailNormalized: string,
  scope: string,
  ip: string | undefined,
): Promise<void> => {
  const perEmail = await consumeRateLimit(
    `otp:${scope}:email:${hashEmail(emailNormalized)}`,
    OTP_RESEND_LIMIT,
    OTP_RESEND_WINDOW_MINUTES * 60,
  );
  if (!perEmail.allowed) {
    throw rateLimited(
      'Too many verification emails requested. Please try again later.',
      perEmail.retryAfterSeconds,
    );
  }

  if (ip) {
    const perIp = await consumeRateLimit(
      `otp:${scope}:ip:${hashIp(ip)}`,
      OTP_RESEND_LIMIT * 2,
      OTP_RESEND_WINDOW_MINUTES * 60,
    );
    if (!perIp.allowed) {
      throw rateLimited(
        'Too many requests from this address. Please try again later.',
        perIp.retryAfterSeconds,
      );
    }
  }
};

interface OtpCheckResult {
  ok: boolean;
  reason?: 'missing' | 'expired' | 'attempts' | 'mismatch';
}

const verifyOtpCode = async (
  emailNormalized: string,
  purpose: OtpPurpose,
  code: string,
): Promise<OtpCheckResult> => {
  const otp = await prisma.emailOtp.findFirst({
    where: {
      emailNormalized,
      purpose,
      consumedAt: null,
      invalidatedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return { ok: false, reason: 'missing' };
  if (otp.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'attempts' };

  if (otp.codeHash !== hashOtp(emailNormalized, purpose, code)) {
    await prisma.emailOtp.update({
      where: { id: otp.id },
      data: {
        attempts: { increment: 1 },
        ...(otp.attempts + 1 >= OTP_MAX_ATTEMPTS ? { invalidatedAt: new Date() } : {}),
      },
    });
    return { ok: false, reason: 'mismatch' };
  }

  await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  return { ok: true };
};

export const requestRegistrationOtp = async (input: {
  email: string;
  ip?: string;
}): Promise<void> => {
  const emailNormalized = normalizeEmail(input.email);
  await enforceOtpRequestLimits(emailNormalized, 'register', input.ip);

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true },
  });
  if (existing) return;

  const restriction = await prisma.emailRestriction.findUnique({
    where: { emailHash: hashEmail(emailNormalized) },
  });
  if (restriction && restriction.expiresAt.getTime() > Date.now()) {
    throw forbidden(
      'This email address cannot be used to create an account right now. Please try again later.',
    );
  }

  const code = await issueOtp(emailNormalized, 'REGISTER', input.ip);
  await sendTransactionalEmail({
    to: emailNormalized,
    template: 'otp-register',
    params: { code, expiresInMinutes: OTP_TTL_MINUTES },
  });
};

export const verifyRegistrationOtp = async (input: {
  email: string;
  code: string;
}): Promise<{ registrationToken: string; expiresAt: Date }> => {
  const emailNormalized = normalizeEmail(input.email);
  const result = await verifyOtpCode(emailNormalized, 'REGISTER', input.code);
  if (!result.ok) {
    if (result.reason === 'attempts') {
      throw new AppError('RATE_LIMITED', 'Too many incorrect codes. Request a new one.');
    }
    throw new AppError('BAD_REQUEST', 'That code is invalid or has expired');
  }

  const token = randomToken(32);
  const expiresAt = addMinutes(new Date(), REGISTRATION_TOKEN_TTL_MINUTES);

  await prisma.pendingRegistration.upsert({
    where: { emailNormalized },
    create: { emailNormalized, tokenHash: sha256(token), expiresAt },
    update: { tokenHash: sha256(token), expiresAt, consumedAt: null, createdAt: new Date() },
  });

  return { registrationToken: token, expiresAt };
};

const createDefaultAvatar = async (username: string): Promise<string | null> => {
  try {
    const svg = renderBugAvatar(username);
    const storage = getStorage();
    const key = `avatars/generated/${randomUUID()}.svg`;
    await storage.put(key, Buffer.from(svg, 'utf8'), 'image/svg+xml');
    const file = await prisma.fileObject.create({
      data: {
        key,
        mimeType: 'image/svg+xml',
        sizeBytes: Buffer.byteLength(svg, 'utf8'),
        width: 512,
        height: 512,
        purpose: 'AVATAR',
      },
      select: { id: true },
    });
    return file.id;
  } catch {
    return null;
  }
};

export interface RegisteredUser {
  user: User;
  sessionToken: string;
}

export const completeRegistration = async (input: {
  registrationToken: string;
  username: string;
  displayName: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<RegisteredUser> => {
  assertValidUsername(input.username);
  assertValidPassword(input.password);

  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 50) {
    throw new AppError('VALIDATION_ERROR', 'Display names must be 1-50 characters');
  }

  const pending = await prisma.pendingRegistration.findUnique({
    where: { tokenHash: sha256(input.registrationToken) },
  });
  if (!pending || pending.consumedAt || pending.expiresAt.getTime() <= Date.now()) {
    throw new AppError('BAD_REQUEST', 'Your registration session has expired. Please start again.');
  }

  const emailNormalized = pending.emailNormalized;
  const restriction = await prisma.emailRestriction.findUnique({
    where: { emailHash: hashEmail(emailNormalized) },
  });
  if (restriction && restriction.expiresAt.getTime() > Date.now()) {
    throw forbidden('This email address cannot be used to create an account right now.');
  }

  const [emailTaken, usernameTaken] = await Promise.all([
    prisma.user.findUnique({ where: { emailNormalized }, select: { id: true } }),
    prisma.user.findUnique({
      where: { usernameLower: normalizeUsername(input.username) },
      select: { id: true },
    }),
  ]);
  if (emailTaken) throw conflict('An account already exists for this email address');
  if (usernameTaken) throw conflict('That username is already taken');

  const passwordHash = await hashPassword(input.password);
  const avatarFileId = await createDefaultAvatar(input.username);

  let user: User;
  try {
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: emailNormalized,
          emailNormalized,
          username: input.username,
          usernameLower: normalizeUsername(input.username),
          displayName,
          passwordHash,
          avatarFileId,
          settings: { create: {} },
        },
      });
      await tx.pendingRegistration.update({
        where: { id: pending.id },
        data: { consumedAt: new Date() },
      });
      return created;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw conflict('That username or email address is already taken');
    }
    throw error;
  }

  if (avatarFileId) {
    await prisma.fileObject.update({ where: { id: avatarFileId }, data: { ownerId: user.id } });
  }

  const session = await createSession(user.id, { ip: input.ip, userAgent: input.userAgent });

  await queueEmail({
    to: user.email,
    template: 'welcome',
    params: { displayName: user.displayName, username: user.username },
    userId: user.id,
  });

  return { user, sessionToken: session.token };
};

const identifierHashFor = (identifier: string): string => hashEmail(normalizeEmail(identifier));

const findUserByIdentifier = async (identifier: string): Promise<User | null> => {
  const value = identifier.trim();
  if (value.includes('@')) {
    return prisma.user.findUnique({ where: { emailNormalized: normalizeEmail(value) } });
  }
  return prisma.user.findUnique({ where: { usernameLower: normalizeUsername(value) } });
};

export interface LoginResult {
  user: User;
  sessionToken: string;
}

export const login = async (input: {
  identifier: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<LoginResult> => {
  const identifierHash = identifierHashFor(input.identifier);
  const ipHash = hashIp(input.ip);
  const now = new Date();

  const attempt = await prisma.loginAttempt.findUnique({
    where: { identifierHash_ipHash: { identifierHash, ipHash } },
  });

  if (attempt?.lockedUntil && attempt.lockedUntil.getTime() > now.getTime()) {
    const retryAfter = Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 1000);
    throw rateLimited('Too many failed sign-in attempts. Please try again later.', retryAfter);
  }

  const ipLimit = await consumeRateLimit(`login-ip:${ipHash}`, 60, 15 * 60);
  if (!ipLimit.allowed) {
    throw rateLimited('Too many sign-in attempts from this address.', ipLimit.retryAfterSeconds);
  }

  const user = await findUserByIdentifier(input.identifier);
  const passwordOk = user
    ? await verifyPassword(user.passwordHash, input.password)
    : await verifyPassword(await dummyPasswordHash(), input.password);

  if (!user || !passwordOk) {
    await recordFailedLogin(identifierHash, ipHash, attempt, now);
    throw new AppError('UNAUTHORIZED', 'Invalid credentials');
  }

  if (attempt) {
    await prisma.loginAttempt.deleteMany({ where: { identifierHash, ipHash } });
  }

  const session = await createSession(user.id, { ip: input.ip, userAgent: input.userAgent });
  return { user, sessionToken: session.token };
};

const recordFailedLogin = async (
  identifierHash: string,
  ipHash: string,
  attempt: { id: string; failCount: number; windowStart: Date } | null,
  now: Date,
): Promise<void> => {
  const windowMs = LOGIN_FAIL_WINDOW_MINUTES * 60 * 1000;

  if (!attempt) {
    await prisma.loginAttempt.create({
      data: { identifierHash, ipHash, failCount: 1, windowStart: now },
    });
    return;
  }

  const windowExpired = now.getTime() - attempt.windowStart.getTime() > windowMs;
  const failCount = windowExpired ? 1 : attempt.failCount + 1;
  const lockedUntil =
    failCount >= LOGIN_FAIL_LIMIT ? addMinutes(now, LOGIN_COOLDOWN_MINUTES) : null;

  await prisma.loginAttempt.update({
    where: { id: attempt.id },
    data: {
      failCount,
      windowStart: windowExpired ? now : attempt.windowStart,
      lockedUntil,
    },
  });
};

export const changePassword = async (input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  confirmSessionRevocation: boolean;
}): Promise<{ revokedSessions: number }> => {
  assertValidPassword(input.newPassword);

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw notFound('User not found');

  const ok = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!ok) throw new AppError('UNAUTHORIZED', 'Your current password is incorrect');

  if (!input.confirmSessionRevocation) {
    const active = await prisma.session.count({
      where: { userId: input.userId, expiresAt: { gt: new Date() } },
    });
    throw new AppError(
      'BAD_REQUEST',
      `Changing your password signs you out of all ${active} active session(s). Confirm to continue.`,
      { details: { activeSessions: active, requiresConfirmation: true } },
    );
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: input.userId }, data: { passwordHash } });
  const revoked = await revokeAllSessions(input.userId);

  await queueEmail({
    to: user.email,
    template: 'password-changed',
    params: { displayName: user.displayName },
    userId: user.id,
  });

  return { revokedSessions: revoked };
};

export const requestPasswordReset = async (input: {
  email: string;
  ip?: string;
}): Promise<void> => {
  const emailNormalized = normalizeEmail(input.email);
  await enforceOtpRequestLimits(emailNormalized, 'reset', input.ip);

  const user = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true, email: true },
  });
  if (!user) return;

  const code = await issueOtp(emailNormalized, 'PASSWORD_RESET', input.ip);
  await sendTransactionalEmail({
    to: user.email,
    template: 'otp-password-reset',
    params: { code, expiresInMinutes: OTP_TTL_MINUTES },
  });
};

export const verifyPasswordResetOtp = async (input: {
  email: string;
  code: string;
}): Promise<{ resetToken: string; expiresAt: Date }> => {
  const emailNormalized = normalizeEmail(input.email);
  const result = await verifyOtpCode(emailNormalized, 'PASSWORD_RESET', input.code);
  if (!result.ok) {
    if (result.reason === 'attempts') {
      throw new AppError('RATE_LIMITED', 'Too many incorrect codes. Request a new one.');
    }
    throw new AppError('BAD_REQUEST', 'That code is invalid or has expired');
  }

  const user = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true },
  });
  if (!user) throw new AppError('BAD_REQUEST', 'That code is invalid or has expired');

  const token = randomToken(32);
  const expiresAt = addMinutes(new Date(), PASSWORD_RESET_TTL_MINUTES);

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt },
  });

  return { resetToken: token, expiresAt };
};

export const completePasswordReset = async (input: {
  resetToken: string;
  newPassword: string;
}): Promise<{ revokedSessions: number }> => {
  assertValidPassword(input.newPassword);

  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(input.resetToken) },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });

  if (!token || token.consumedAt || token.expiresAt.getTime() <= Date.now()) {
    throw new AppError('BAD_REQUEST', 'This reset link is invalid or has expired');
  }

  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    }),
  ]);

  const revoked = await revokeAllSessions(token.userId);

  await queueEmail({
    to: token.user.email,
    template: 'password-changed',
    params: { displayName: token.user.displayName },
    userId: token.userId,
  });

  return { revokedSessions: revoked };
};

export const requestAccountDeletionOtp = async (input: {
  userId: string;
  password: string;
  ip?: string;
}): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw notFound('User not found');

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) throw new AppError('UNAUTHORIZED', 'Your password is incorrect');

  const limit = await consumeRateLimit(
    `otp:delete:user:${input.userId}`,
    OTP_RESEND_LIMIT,
    OTP_RESEND_WINDOW_MINUTES * 60,
  );
  if (!limit.allowed) {
    throw rateLimited('Too many verification emails requested.', limit.retryAfterSeconds);
  }

  const code = await issueOtp(user.emailNormalized, 'ACCOUNT_DELETION', input.ip);
  await sendTransactionalEmail({
    to: user.email,
    template: 'otp-register',
    params: { code, expiresInMinutes: OTP_TTL_MINUTES, displayName: user.displayName },
  });
};

export const confirmAccountDeletion = async (input: {
  userId: string;
  code: string;
}): Promise<{ scheduledFor: Date }> => {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw notFound('User not found');

  const result = await verifyOtpCode(user.emailNormalized, 'ACCOUNT_DELETION', input.code);
  if (!result.ok) {
    if (result.reason === 'attempts') {
      throw new AppError('RATE_LIMITED', 'Too many incorrect codes. Request a new one.');
    }
    throw new AppError('BAD_REQUEST', 'That code is invalid or has expired');
  }

  const scheduledFor = addDays(new Date(), ACCOUNT_DELETION_GRACE_DAYS);

  await prisma.$transaction(async (tx) => {
    await tx.accountDeletionRequest.upsert({
      where: { userId: user.id },
      create: { userId: user.id, scheduledFor },
      update: { scheduledFor, cancelledAt: null, completedAt: null, requestedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
  });

  await queueEmail({
    to: user.email,
    template: 'account-deletion-scheduled',
    params: {
      displayName: user.displayName,
      deletionDate: scheduledFor.toUTCString(),
    },
    userId: user.id,
  });

  return { scheduledFor };
};

export const cancelAccountDeletion = async (userId: string): Promise<void> => {
  const request = await prisma.accountDeletionRequest.findUnique({ where: { userId } });
  if (!request || request.completedAt || request.cancelledAt) {
    throw notFound('There is no pending deletion for this account');
  }
  if (request.scheduledFor.getTime() <= Date.now()) {
    throw new AppError('BAD_REQUEST', 'The deletion date has already passed');
  }
  await prisma.accountDeletionRequest.update({
    where: { userId },
    data: { cancelledAt: new Date() },
  });
};

export const purgeDeletedAccounts = async (): Promise<number> => {
  const due = await prisma.accountDeletionRequest.findMany({
    where: { scheduledFor: { lte: new Date() }, completedAt: null, cancelledAt: null },
    take: 50,
  });

  for (const request of due) {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) {
      await prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: { completedAt: new Date() },
      });
      continue;
    }

    const ban = await getActiveBan(user.id);
    const emailHash = hashEmail(user.emailNormalized);
    const avatar = user.avatarFileId
      ? await prisma.fileObject.findUnique({
          where: { id: user.avatarFileId },
          select: { id: true, key: true },
        })
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.post.updateMany({
        where: { authorId: user.id },
        data: { authorId: null, authorDeleted: true },
      });
      await tx.reply.updateMany({
        where: { authorId: user.id },
        data: { authorId: null, authorDeleted: true },
      });
      await tx.mention.deleteMany({ where: { userId: user.id } });
      if (avatar) {
        await tx.fileObject.delete({ where: { id: avatar.id } });
      }
      if (ban) {
        const expiresAt = ban.permanent
          ? addDays(new Date(), 3650)
          : (ban.endsAt ?? addDays(new Date(), 1));
        await tx.emailRestriction.upsert({
          where: { emailHash },
          create: {
            emailHash,
            reason: 'account deleted during an active ban',
            expiresAt,
          },
          update: { expiresAt },
        });
      }
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { completedAt: new Date() },
      });
      // Deleting the user releases the username and cascades sessions, votes, follows, blocks.
      await tx.user.delete({ where: { id: user.id } });
    });

    if (avatar) {
      await getStorage()
        .delete(avatar.key)
        .catch(() => undefined);
    }

    await queueEmail({
      to: user.email,
      template: 'account-deleted',
      params: { displayName: user.displayName },
    });
  }

  return due.length;
};

export const expireEmailRestrictions = async (): Promise<number> => {
  const result = await prisma.emailRestriction.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return result.count;
};

export const expirePasswordResets = async (): Promise<number> => {
  const result = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return result.count;
};

export const expireOtps = async (): Promise<number> => {
  const result = await prisma.emailOtp.deleteMany({
    where: { expiresAt: { lt: addMinutes(new Date(), -60) } },
  });
  return result.count;
};
