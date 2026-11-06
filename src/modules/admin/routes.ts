import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sendData, sendPage } from '../../lib/http.js';
import { AppError, notFound } from '../../lib/errors.js';
import { verifyPassword } from '../auth/password.js';
import {
  clearAdminCookies,
  requireAdmin,
  revokeAdminSession,
  setAdminCookies,
} from '../../plugins/admin-auth.js';
import { createAdminSession } from '../admin/session.js';
import { writeAuditLog } from './audit.js';
import { decideModerationCase } from '../moderation/service.js';
import { refreshSource, ensureSources } from '../external/service.js';
import { adapterByKey } from '../external/registry.js';
import { getBanState, countActiveWarnings } from '../moderation/penalties.js';
import { env } from '../../config/env.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { toPublicAuthor } from '../users/serialize.js';
import { countVisiblePosts } from '../posts/service.js';

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/admin/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        tags: ['Admin'],
        summary: 'Admin sign-in',
        body: z.object({
          username: z.string().min(1).max(64),
          password: z.string().min(1).max(200),
        }),
      },
    },
    async (request, reply) => {
      const admin = await prisma.adminUser.findUnique({
        where: { username: request.body.username },
      });

      const ok = admin
        ? await verifyPassword(admin.passwordHash, request.body.password)
        : await verifyPassword(
            '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            request.body.password,
          ).catch(() => false);

      if (!admin || !ok) {
        request.log.warn({ ip: request.ip }, 'admin login failed');
        throw new AppError('UNAUTHORIZED', 'Invalid credentials');
      }

      const session = await createAdminSession(admin.id);
      await prisma.adminUser.update({
        where: { id: admin.id },
        data: { lastLoginAt: new Date() },
      });
      await writeAuditLog({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.login',
        ip: request.ip,
      });

      setAdminCookies(reply, session.token);
      return sendData(reply, {
        admin: { id: admin.id, username: admin.username },
        expiresAt: session.session.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/admin/auth/logout',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'Admin sign-out' },
    },
    async (request, reply) => {
      const auth = requireAdmin(request);
      await revokeAdminSession(auth.sessionId);
      clearAdminCookies(reply);
      return sendData(reply, { status: 'signed_out' });
    },
  );

  app.get(
    '/admin/auth/me',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'Current admin' },
    },
    async (request, reply) => {
      const auth = requireAdmin(request);
      return sendData(reply, auth.admin);
    },
  );

  app.get(
    '/admin/overview',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'Platform statistics' },
    },
    async (_request, reply) => {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [
        users,
        newUsers,
        posts,
        postsToday,
        replies,
        reports,
        openCases,
        bannedUsers,
        pendingDeletion,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: since7d } } }),
        prisma.post.count({ where: { deletedAt: null, visibility: 'VISIBLE' } }),
        prisma.post.count({
          where: { createdAt: { gte: since24h }, visibility: 'VISIBLE', deletedAt: null },
        }),
        prisma.reply.count({ where: { deletedAt: null, visibility: 'VISIBLE' } }),
        // Only reports that reached a human review: the author appealed the automated decision.
        prisma.report.count({ where: { case: { is: { appealedAt: { not: null } } } } }),
        prisma.moderationCase.count({ where: { status: 'APPEALED' } }),
        prisma.ban.count({
          where: {
            liftedAt: null,
            OR: [{ permanent: true }, { endsAt: { gt: new Date() } }],
          },
        }),
        prisma.accountDeletionRequest.count({ where: { completedAt: null, cancelledAt: null } }),
      ]);

      return sendData(reply, {
        users,
        newUsersLast7Days: newUsers,
        posts,
        postsLast24Hours: postsToday,
        replies,
        reportsReviewed: reports,
        openAppeals: openCases,
        bannedUsers,
        pendingDeletions: pendingDeletion,
      });
    },
  );

  app.get(
    '/admin/users',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Look up users',
        querystring: z.object({
          query: z.string().trim().min(1).max(120),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      },
    },
    async (request, reply) => {
      const query = request.query.query;
      const users = await prisma.user.findMany({
        where: {
          OR: [
            { usernameLower: { contains: query.toLowerCase() } },
            { emailNormalized: { contains: query.toLowerCase() } },
            { displayName: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: request.query.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          createdAt: true,
          _count: { select: { warnings: true } },
        },
      });

      const postCounts = await prisma.post.groupBy({
        by: ['authorId'],
        where: {
          authorId: { in: users.map((user) => user.id) },
          visibility: 'VISIBLE',
          deletedAt: null,
        },
        _count: { _all: true },
      });
      const postCountByAuthor = new Map(
        postCounts.map((entry) => [entry.authorId, entry._count._all]),
      );

      const enriched = await Promise.all(
        users.map(async (user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          createdAt: user.createdAt.toISOString(),
          postCount: postCountByAuthor.get(user.id) ?? 0,
          warningCount: user._count.warnings,
          ban: await getBanState(user.id),
        })),
      );

      await writeAuditLog({
        actorType: 'ADMIN',
        actorId: requireAdmin(request).admin.id,
        action: 'admin.user_search',
        metadata: { query },
        ip: request.ip,
      });

      return sendData(reply, enriched);
    },
  );

  app.get(
    '/admin/users/:id',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'User detail for moderation',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          createdAt: true,
          about: true,
          avatarFileId: true,
          _count: { select: { replies: true, followers: true, following: true } },
        },
      });
      if (!user) throw notFound('User not found');

      const [warnings, bans, activeWarnings, ban, postCount] = await Promise.all([
        prisma.warning.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        prisma.ban.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        countActiveWarnings(user.id),
        getBanState(user.id),
        countVisiblePosts(user.id),
      ]);

      await writeAuditLog({
        actorType: 'ADMIN',
        actorId: requireAdmin(request).admin.id,
        action: 'admin.user_view',
        targetType: 'User',
        targetId: user.id,
        ip: request.ip,
      });

      return sendData(reply, {
        ...toPublicAuthor(user, false),
        email: user.email,
        about: user.about,
        createdAt: user.createdAt.toISOString(),
        stats: {
          posts: postCount,
          replies: user._count.replies,
          followers: user._count.followers,
          following: user._count.following,
        },
        activeWarnings,
        ban,
        warnings: warnings.map((warning) => ({
          id: warning.id,
          reason: warning.reason,
          createdAt: warning.createdAt.toISOString(),
          expiresAt: warning.expiresAt.toISOString(),
          revokedAt: warning.revokedAt?.toISOString() ?? null,
        })),
        bans: bans.map((entry) => ({
          id: entry.id,
          reason: entry.reason,
          startsAt: entry.startsAt.toISOString(),
          endsAt: entry.endsAt?.toISOString() ?? null,
          permanent: entry.permanent,
          liftedAt: entry.liftedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.get(
    '/admin/moderation/cases',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Moderation case queue',
        querystring: z.object({
          status: z.enum(['APPEALED', 'RESOLVED_KEPT', 'RESOLVED_REMOVED']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
      },
    },
    async (request, reply) => {
      // Only cases the author appealed ever reach a moderator. Automated decisions that were
      // accepted, or that expired without an appeal, are deleted before they can appear here.
      const cases = await prisma.moderationCase.findMany({
        where: {
          appealedAt: { not: null },
          ...(request.query.status ? { status: request.query.status } : {}),
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: request.query.limit,
        include: {
          post: {
            select: {
              id: true,
              title: true,
              excerpt: true,
              visibility: true,
              authorId: true,
              author: { select: { id: true, username: true, displayName: true, email: true } },
            },
          },
          _count: { select: { reports: true } },
        },
      });

      return sendData(
        reply,
        cases.map((entry) => ({
          id: entry.id,
          status: entry.status,
          createdAt: entry.createdAt.toISOString(),
          updatedAt: entry.updatedAt.toISOString(),
          appealExpiresAt: entry.appealExpiresAt?.toISOString() ?? null,
          appealMessage: entry.appealMessage,
          reportCount: entry._count.reports,
          providerCategories: entry.providerCategories,
          // The post is detached once it has been removed; the snapshot keeps the record readable.
          postTitle: entry.postTitle,
          post: entry.post
            ? {
                id: entry.post.id,
                title: entry.post.title,
                excerpt: entry.post.excerpt,
                visibility: entry.post.visibility,
                author: entry.post.author
                  ? {
                      id: entry.post.author.id,
                      username: entry.post.author.username,
                      displayName: entry.post.author.displayName,
                      email: entry.post.author.email,
                    }
                  : null,
              }
            : null,
        })),
      );
    },
  );

  app.post(
    '/admin/moderation/cases/:id/decision',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Accept or reject an appeal',
        params: z.object({ id: z.string().min(1).max(64) }),
        body: z.object({
          decision: z.enum(['accept', 'reject']),
          note: z.string().max(2000).optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireAdmin(request);
      const result = await decideModerationCase({
        caseId: request.params.id,
        adminId: auth.admin.id,
        decision: request.body.decision,
        note: request.body.note,
      });
      return sendData(reply, { id: result.id, status: result.status });
    },
  );

  app.get(
    '/admin/sources',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'External source health' },
    },
    async (_request, reply) => {
      await ensureSources();
      const sources = await prisma.externalSource.findMany({
        orderBy: [{ kind: 'asc' }, { section: 'asc' }, { name: 'asc' }],
      });

      const counts = await prisma.externalItem.groupBy({
        by: ['sourceKey'],
        _count: { _all: true },
      });
      const countByKey = new Map(counts.map((entry) => [entry.sourceKey, entry._count._all]));

      return sendData(
        reply,
        sources.map((source) => ({
          key: source.key,
          name: source.name,
          kind: source.kind,
          section: source.section,
          url: source.url,
          enabled: source.enabled,
          lastAttemptAt: source.lastAttemptAt?.toISOString() ?? null,
          lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
          responseTimeMs: source.responseTimeMs,
          consecutiveFailures: source.consecutiveFailures,
          lastError: source.lastError,
          nextRetryAt: source.nextRetryAt?.toISOString() ?? null,
          itemCount: countByKey.get(source.key) ?? 0,
          healthy: source.consecutiveFailures === 0,
        })),
      );
    },
  );

  app.post(
    '/admin/sources/:key/refresh',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Force a refresh of one source',
        params: z.object({ key: z.string().min(1).max(80) }),
      },
    },
    async (request, reply) => {
      const adapter = adapterByKey(request.params.key);
      if (!adapter) throw notFound('Unknown source');
      const result = await refreshSource(adapter, { force: true });
      await writeAuditLog({
        actorType: 'ADMIN',
        actorId: requireAdmin(request).admin.id,
        action: 'admin.source_refresh',
        targetType: 'ExternalSource',
        targetId: request.params.key,
        metadata: { status: result.status, itemCount: result.itemCount },
        ip: request.ip,
      });
      return sendData(reply, result);
    },
  );

  app.get(
    '/admin/health',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'API, database and worker health' },
    },
    async (_request, reply) => {
      const dbStart = Date.now();
      let database: { status: 'up' | 'down'; latencyMs: number | null };
      try {
        await prisma.$queryRaw`SELECT 1`;
        database = { status: 'up', latencyMs: Date.now() - dbStart };
      } catch {
        database = { status: 'down', latencyMs: null };
      }

      const heartbeat = await prisma.workerHeartbeat
        .findFirst({ orderBy: { lastSeenAt: 'desc' } })
        .catch(() => null);
      const workerAge = heartbeat
        ? Math.floor((Date.now() - heartbeat.lastSeenAt.getTime()) / 1000)
        : null;

      return sendData(reply, {
        api: {
          status: 'up',
          environment: env.NODE_ENV,
          uptimeSeconds: Math.floor(process.uptime()),
        },
        database,
        worker: {
          status: workerAge !== null && workerAge <= 120 ? 'up' : 'down',
          lastSeenSecondsAgo: workerAge,
          workerId: heartbeat?.workerId ?? null,
        },
        moderation: { configured: env.moderationConfigured, provider: 'openai' },
        youtube: { configured: env.youtubeConfigured },
        email: { transport: env.EMAIL_TRANSPORT, smtpConfigured: env.smtpConfigured },
        linkPreview: { configured: env.linkPreviewConfigured },
      });
    },
  );

  app.get(
    '/admin/jobs',
    {
      preHandler: app.authenticateAdmin,
      schema: { tags: ['Admin'], summary: 'Background job status' },
    },
    async (_request, reply) => {
      interface JobRow {
        name: string;
        state: string;
        count: bigint;
      }
      interface FailureRow {
        name: string;
        id: string;
        created_on: Date;
        data: unknown;
      }

      let summary: Array<{ name: string; state: string; count: number }> = [];
      let recentFailures: FailureRow[] = [];

      try {
        const rows = await prisma.$queryRaw<JobRow[]>`
          SELECT name, state, count(*)::bigint AS count
          FROM pgboss.job
          WHERE created_on > now() - interval '7 days'
          GROUP BY name, state
          ORDER BY name, state
        `;
        summary = rows.map((row) => ({
          name: row.name,
          state: row.state,
          count: Number(row.count),
        }));

        recentFailures = await prisma.$queryRaw<FailureRow[]>`
          SELECT name, id::text AS id, created_on, data
          FROM pgboss.job
          WHERE state = 'failed'
          ORDER BY created_on DESC
          LIMIT 20
        `;
      } catch {
        summary = [];
        recentFailures = [];
      }

      return sendData(reply, {
        queues: summary,
        recentFailures: recentFailures.map((row) => ({
          queue: row.name,
          id: row.id,
          createdAt: row.created_on.toISOString(),
          data: row.data,
        })),
      });
    },
  );

  app.get(
    '/admin/audit-logs',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Audit log',
        querystring: pageQuery.extend({ action: z.string().max(80).optional() }),
      },
    },
    async (request, reply) => {
      const cursor = decodeCursor(request.query.cursor);
      const cursorDate = typeof cursor?.c === 'string' ? new Date(cursor.c) : null;
      const cursorId = typeof cursor?.i === 'string' ? cursor.i : null;

      const rows = await prisma.auditLog.findMany({
        where: {
          ...(request.query.action ? { action: request.query.action } : {}),
          ...(cursorDate && cursorId
            ? {
                OR: [
                  { createdAt: { lt: cursorDate } },
                  { createdAt: cursorDate, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: request.query.limit + 1,
      });

      const hasMore = rows.length > request.query.limit;
      const page = hasMore ? rows.slice(0, request.query.limit) : rows;
      const last = page[page.length - 1];

      return sendPage(
        reply,
        page.map((entry) => ({
          id: entry.id,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: entry.metadata,
          createdAt: entry.createdAt.toISOString(),
        })),
        {
          hasMore,
          nextCursor:
            hasMore && last ? encodeCursor({ c: last.createdAt.toISOString(), i: last.id }) : null,
          limit: request.query.limit,
        },
      );
    },
  );

  app.delete(
    '/admin/audit-logs',
    {
      preHandler: app.authenticateAdmin,
      schema: {
        tags: ['Admin'],
        summary: 'Delete every audit log entry',
      },
    },
    async (request, reply) => {
      const auth = requireAdmin(request);
      const deleted = await prisma.auditLog.deleteMany({});

      // The clear operation itself is recorded, so the log is never left without a trace
      // of who emptied it.
      await writeAuditLog({
        actorType: 'ADMIN',
        actorId: auth.admin.id,
        action: 'admin.audit_logs_cleared',
        metadata: { deleted: deleted.count },
        ip: request.ip,
      });

      return sendData(reply, { deleted: deleted.count });
    },
  );
};
