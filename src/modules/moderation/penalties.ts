import type { Ban } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { addDays, addHours } from '../../lib/time.js';
import { BAN_SCHEDULE_DAYS, WARNING_WINDOW_DAYS } from '../../config/constants.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/service.js';

export const countActiveWarnings = async (userId: string): Promise<number> =>
  prisma.warning.count({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

export const getActiveBan = async (userId: string): Promise<Ban | null> =>
  prisma.ban.findFirst({
    where: {
      userId,
      liftedAt: null,
      OR: [{ permanent: true }, { endsAt: { gt: new Date() } }],
    },
    orderBy: [{ permanent: 'desc' }, { endsAt: 'desc' }],
  });

export interface BanState {
  banned: boolean;
  permanent: boolean;
  until: Date | null;
}

export const getBanState = async (userId: string): Promise<BanState> => {
  const ban = await getActiveBan(userId);
  if (!ban) return { banned: false, permanent: false, until: null };
  return { banned: true, permanent: ban.permanent, until: ban.endsAt };
};

export const assertNotBanned = async (userId: string): Promise<void> => {
  const ban = await getActiveBan(userId);
  if (!ban) return;
  if (ban.permanent) {
    throw new AppError('FORBIDDEN', 'Your account is permanently banned from posting.');
  }
  throw new AppError(
    'FORBIDDEN',
    `Your account is banned until ${ban.endsAt?.toISOString() ?? 'further notice'}. You can still read and delete your posts.`,
  );
};

const banDaysForWarningCount = (count: number): number | 'permanent' | 0 => {
  if (count >= 8) return 'permanent';
  const days = BAN_SCHEDULE_DAYS[count];
  return days ?? 0;
};

export interface IssueWarningInput {
  userId: string;
  caseId?: string | null;
  reason: string;
}

export interface IssueWarningResult {
  warningId: string;
  activeWarnings: number;
  ban: Ban | null;
}

export const issueWarning = async (input: IssueWarningInput): Promise<IssueWarningResult> => {
  const warning = await prisma.warning.create({
    data: {
      userId: input.userId,
      caseId: input.caseId ?? null,
      reason: input.reason,
      expiresAt: addDays(new Date(), WARNING_WINDOW_DAYS),
    },
  });

  const activeWarnings = await countActiveWarnings(input.userId);
  const consequence = banDaysForWarningCount(activeWarnings);

  let ban: Ban | null = null;

  if (consequence !== 0) {
    const permanent = consequence === 'permanent';
    const endsAt = permanent ? null : addDays(new Date(), consequence as number);
    const existing = await getActiveBan(input.userId);

    const shouldApply =
      !existing ||
      (permanent && !existing.permanent) ||
      (!permanent &&
        !existing.permanent &&
        existing.endsAt !== null &&
        endsAt !== null &&
        endsAt.getTime() > existing.endsAt.getTime());

    if (shouldApply) {
      if (existing) {
        await prisma.ban.update({
          where: { id: existing.id },
          data: { liftedAt: new Date() },
        });
      }
      ban = await prisma.ban.create({
        data: {
          userId: input.userId,
          reason: input.reason,
          permanent,
          endsAt,
        },
      });
    } else {
      ban = existing;
    }
  }

  await createNotification({
    userId: input.userId,
    type: 'warning',
    category: 'ACCOUNT',
    title: 'A warning was added to your account',
    body: `Reason: ${input.reason}. Active warnings: ${activeWarnings}.`,
    data: { warningId: warning.id, caseId: input.caseId ?? null, activeWarnings },
    email: {
      template: 'warning-issued',
      params: { reason: input.reason, warningCount: activeWarnings },
    },
  });

  if (ban) {
    await createNotification({
      userId: input.userId,
      type: 'ban',
      category: 'ACCOUNT',
      title: ban.permanent ? 'Your account is permanently banned' : 'Your account was banned',
      body: ban.permanent
        ? 'You can still read Buzz and delete your posts.'
        : `Your account is banned until ${ban.endsAt?.toISOString()}.`,
      data: { banId: ban.id },
      email: {
        template: 'ban-applied',
        params: {
          permanent: ban.permanent,
          banDays: consequence === 'permanent' ? undefined : (consequence as number),
        },
      },
    });
  }

  return { warningId: warning.id, activeWarnings, ban };
};

export const liftExpiredBans = async (): Promise<number> => {
  const result = await prisma.ban.updateMany({
    where: { liftedAt: null, permanent: false, endsAt: { lte: new Date() } },
    data: { liftedAt: new Date() },
  });
  return result.count;
};

export const purgeOldLoginAttempts = async (): Promise<number> => {
  const result = await prisma.loginAttempt.deleteMany({
    where: { updatedAt: { lt: addHours(new Date(), -24) } },
  });
  return result.count;
};
