import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_PREFIX } from '../../config/constants.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { sendData } from '../../lib/http.js';
import { requireUser } from '../../plugins/auth.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';
import {
  cancelAccountDeletion,
  changePassword,
  completePasswordReset,
  completeRegistration,
  confirmAccountDeletion,
  login,
  requestAccountDeletionOtp,
  requestPasswordReset,
  requestRegistrationOtp,
  verifyPasswordResetOtp,
  verifyRegistrationOtp,
} from './service.js';
import { listSessions, revokeAllSessions, revokeSession } from './session.js';
import { prisma } from '../../lib/prisma.js';
import { toPublicAuthor } from '../users/serialize.js';
import { getBanState } from '../moderation/penalties.js';
import { countVisiblePosts } from '../posts/service.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(8).max(128);

const authResponseSchema = z.object({
  data: z.object({
    user: z.object({
      id: z.string(),
      username: z.string(),
      displayName: z.string(),
      email: z.string(),
      avatarUrl: z.string().nullable(),
      profileUrl: z.string(),
      createdAt: z.string(),
    }),
    pendingDeletion: z.boolean(),
    ban: z.object({
      banned: z.boolean(),
      permanent: z.boolean(),
      until: z.string().nullable(),
    }),
  }),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/register/request-otp',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Request a registration verification code',
        body: z.object({ email: emailSchema }),
        response: {
          202: z.object({ data: z.object({ status: z.literal('sent') }) }),
        },
      },
    },
    async (request, reply) => {
      await requestRegistrationOtp({ email: request.body.email, ip: request.ip });
      return sendData(reply, { status: 'sent' as const }, 202);
    },
  );

  app.post(
    '/auth/register/verify-otp',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Verify a registration code and obtain a registration token',
        body: z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }),
      },
    },
    async (request, reply) => {
      const result = await verifyRegistrationOtp(request.body);
      return sendData(reply, {
        registrationToken: result.registrationToken,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/auth/register/complete',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Create the account after email verification',
        body: z.object({
          registrationToken: z.string().min(20).max(200),
          username: z.string().min(3).max(20),
          displayName: z.string().min(1).max(50),
          password: passwordSchema,
        }),
        response: { 201: authResponseSchema },
      },
    },
    async (request, reply) => {
      const { user, sessionToken } = await completeRegistration({
        ...request.body,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookies(reply, sessionToken);
      const author = toPublicAuthor(user, false);
      return sendData(
        reply,
        {
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            avatarUrl: author.avatarUrl,
            profileUrl: author.profileUrl,
            createdAt: user.createdAt.toISOString(),
          },
          pendingDeletion: false,
          ban: { banned: false, permanent: false, until: null },
        },
        201,
      );
    },
  );

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Sign in with username or email',
        body: z.object({
          identifier: z.string().min(1).max(254),
          password: z.string().min(1).max(128),
        }),
        response: { 200: authResponseSchema },
      },
    },
    async (request, reply) => {
      const { user, sessionToken } = await login({
        identifier: request.body.identifier,
        password: request.body.password,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookies(reply, sessionToken);

      const deletion = await prisma.accountDeletionRequest.findUnique({
        where: { userId: user.id },
      });
      const ban = await getBanState(user.id);
      const author = toPublicAuthor(user, false);

      return sendData(reply, {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          avatarUrl: author.avatarUrl,
          profileUrl: author.profileUrl,
          createdAt: user.createdAt.toISOString(),
        },
        pendingDeletion: Boolean(deletion && !deletion.cancelledAt && !deletion.completedAt),
        ban,
      });
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Authentication'], summary: 'Sign out of the current session' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await revokeSession(auth.session.id, auth.user.id);
      clearSessionCookies(reply);
      return sendData(reply, { status: 'signed_out' });
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Authentication'], summary: 'Current account and session' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const [deletion, ban, settings, counts, postCount] = await Promise.all([
        prisma.accountDeletionRequest.findUnique({ where: { userId: auth.user.id } }),
        getBanState(auth.user.id),
        prisma.userSettings.findUnique({ where: { userId: auth.user.id } }),
        prisma.user.findUnique({
          where: { id: auth.user.id },
          select: { _count: { select: { followers: true, following: true } } },
        }),
        countVisiblePosts(auth.user.id),
      ]);

      const author = toPublicAuthor(auth.user, false);
      return sendData(reply, {
        user: {
          id: auth.user.id,
          username: auth.user.username,
          displayName: auth.user.displayName,
          email: auth.user.email,
          about: auth.user.about,
          socialLinks: auth.user.socialLinks,
          avatarUrl: author.avatarUrl,
          profileUrl: author.profileUrl,
          createdAt: auth.user.createdAt.toISOString(),
        },
        stats: {
          posts: postCount,
          followers: counts?._count.followers ?? 0,
          following: counts?._count.following ?? 0,
        },
        settings: settings
          ? {
              displayMode: settings.displayMode,
              accentColor: settings.accentColor,
              newsOrder: settings.newsOrder,
              eventsOrder: settings.eventsOrder,
              trendingOrder: settings.trendingOrder,
              profileVisibility: settings.profileVisibility,
              notificationPrefs: settings.notificationPrefs,
            }
          : null,
        pendingDeletion:
          deletion && !deletion.cancelledAt && !deletion.completedAt
            ? { scheduledFor: deletion.scheduledFor.toISOString() }
            : null,
        ban,
        session: {
          id: auth.session.id,
          expiresAt: auth.session.expiresAt.toISOString(),
          via: auth.via,
        },
      });
    },
  );

  app.get(
    '/auth/sessions',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Authentication'], summary: 'List active sessions' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const sessions = await listSessions(auth.user.id, auth.session.id);
      return sendData(reply, sessions);
    },
  );

  app.delete(
    '/auth/sessions/:id',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke a specific session',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const revoked = await revokeSession(request.params.id, auth.user.id);
      if (!revoked) throw new AppError('NOT_FOUND', 'Session not found');
      if (request.params.id === auth.session.id) clearSessionCookies(reply);
      return sendData(reply, { status: 'revoked' });
    },
  );

  app.delete(
    '/auth/sessions',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Authentication'],
        summary: 'Revoke every other session',
        querystring: z.object({ includeCurrent: z.coerce.boolean().default(false) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const revoked = await revokeAllSessions(
        auth.user.id,
        request.query.includeCurrent ? undefined : auth.session.id,
      );
      if (request.query.includeCurrent) clearSessionCookies(reply);
      return sendData(reply, { revoked });
    },
  );

  app.post(
    '/auth/password/change',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Change password and revoke all sessions',
        body: z.object({
          currentPassword: z.string().min(1).max(128),
          newPassword: passwordSchema,
          confirmSessionRevocation: z.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const result = await changePassword({
        userId: auth.user.id,
        ...request.body,
      });
      clearSessionCookies(reply);
      return sendData(reply, result);
    },
  );

  app.post(
    '/auth/password/reset/request',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Request a password reset code',
        body: z.object({ email: emailSchema }),
      },
    },
    async (request, reply) => {
      await requestPasswordReset({ email: request.body.email, ip: request.ip });
      return sendData(reply, { status: 'sent' }, 202);
    },
  );

  app.post(
    '/auth/password/reset/verify',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Verify a password reset code',
        body: z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }),
      },
    },
    async (request, reply) => {
      const result = await verifyPasswordResetOtp(request.body);
      return sendData(reply, {
        resetToken: result.resetToken,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/auth/password/reset/complete',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Set a new password using a reset token',
        body: z.object({
          resetToken: z.string().min(20).max(200),
          newPassword: passwordSchema,
        }),
      },
    },
    async (request, reply) => {
      const result = await completePasswordReset(request.body);
      clearSessionCookies(reply);
      return sendData(reply, result);
    },
  );

  app.post(
    '/auth/account-deletion/request',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        tags: ['Authentication'],
        summary: 'Start account deletion (step 1: confirm password)',
        body: z.object({ password: z.string().min(1).max(128) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await requestAccountDeletionOtp({
        userId: auth.user.id,
        password: request.body.password,
        ip: request.ip,
      });
      return sendData(reply, { status: 'sent' }, 202);
    },
  );

  app.post(
    '/auth/account-deletion/confirm',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Authentication'],
        summary: 'Start account deletion (step 2: confirm email code)',
        body: z.object({ code: z.string().regex(/^\d{6}$/) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const result = await confirmAccountDeletion({
        userId: auth.user.id,
        code: request.body.code,
      });
      clearSessionCookies(reply);
      return sendData(reply, {
        scheduledFor: result.scheduledFor.toISOString(),
        graceDays: 7,
      });
    },
  );

  app.post(
    '/auth/account-deletion/cancel',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Authentication'], summary: 'Cancel a scheduled account deletion' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await cancelAccountDeletion(auth.user.id);
      return sendData(reply, { status: 'cancelled' });
    },
  );
};

export const authRoutePrefix = API_PREFIX;

export const ensureAuthenticated = unauthorized;
