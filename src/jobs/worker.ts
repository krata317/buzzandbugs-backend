import type PgBoss from 'pg-boss';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { QUEUE } from './boss.js';
import { deliverQueuedEmail } from '../modules/email/service.js';
import {
  processModerationCase,
  expireModerationAppeals,
  purgeResolvedModerationCases,
} from '../modules/moderation/service.js';
import { refreshKind } from '../modules/external/service.js';
import { purgeRemovedPostsWithoutThreads } from '../modules/posts/service.js';
import {
  backfillMissingAvatars,
  expireEmailRestrictions,
  expireOtps,
  expirePasswordResets,
  purgeDeletedAccounts,
} from '../modules/auth/service.js';
import { cleanupExpiredNotifications } from '../modules/notifications/service.js';
import { cleanupRateCounters } from '../lib/rate-limit.js';
import { liftExpiredBans, purgeOldLoginAttempts } from '../modules/moderation/penalties.js';

const QUEUE_OPTIONS: Record<string, PgBoss.Queue> = {
  [QUEUE.emailSend]: { name: QUEUE.emailSend, retryLimit: 5, retryDelay: 60, retryBackoff: true },
  [QUEUE.moderationProcess]: {
    name: QUEUE.moderationProcess,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  [QUEUE.newsRefresh]: {
    name: QUEUE.newsRefresh,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  },
  [QUEUE.eventsRefresh]: {
    name: QUEUE.eventsRefresh,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  },
  [QUEUE.trendingRefresh]: {
    name: QUEUE.trendingRefresh,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  },
  [QUEUE.podcastRefresh]: {
    name: QUEUE.podcastRefresh,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  },
  [QUEUE.moderationCaseRetention]: {
    name: QUEUE.moderationCaseRetention,
    retryLimit: 3,
    retryDelay: 120,
  },
  [QUEUE.moderationExpireAppeals]: {
    name: QUEUE.moderationExpireAppeals,
    retryLimit: 3,
    retryDelay: 120,
  },
  [QUEUE.accountDeletionPurge]: {
    name: QUEUE.accountDeletionPurge,
    retryLimit: 3,
    retryDelay: 120,
  },
  [QUEUE.avatarBackfill]: {
    name: QUEUE.avatarBackfill,
    retryLimit: 3,
    retryDelay: 120,
  },
  [QUEUE.notificationCleanup]: { name: QUEUE.notificationCleanup, retryLimit: 3, retryDelay: 120 },
  [QUEUE.tokenCleanup]: { name: QUEUE.tokenCleanup, retryLimit: 3, retryDelay: 120 },
  [QUEUE.emailRestrictionCleanup]: {
    name: QUEUE.emailRestrictionCleanup,
    retryLimit: 3,
    retryDelay: 120,
  },
  [QUEUE.workerHeartbeat]: { name: QUEUE.workerHeartbeat, retryLimit: 1, retryDelay: 60 },
};

export const registerQueues = async (boss: PgBoss): Promise<void> => {
  for (const queue of Object.values(QUEUE_OPTIONS)) {
    await boss.createQueue(queue.name, queue);
  }
};

const runBatch = async <T>(
  name: string,
  jobs: PgBoss.Job<T>[],
  handler: (data: T) => Promise<void>,
): Promise<void> => {
  for (const job of jobs) {
    try {
      await handler(job.data);
    } catch (error) {
      logger.error({ err: error, queue: name, jobId: job.id }, 'job failed');
      throw error;
    }
  }
};

export const registerWorkers = async (boss: PgBoss): Promise<void> => {
  await boss.work<{ deliveryId: string }>(QUEUE.emailSend, { batchSize: 1 }, async (jobs) =>
    runBatch(QUEUE.emailSend, jobs, (data) => deliverQueuedEmail(data.deliveryId)),
  );

  await boss.work<{ caseId: string }>(QUEUE.moderationProcess, { batchSize: 1 }, async (jobs) =>
    runBatch(QUEUE.moderationProcess, jobs, (data) => processModerationCase(data.caseId)),
  );

  await boss.work(QUEUE.newsRefresh, { batchSize: 1 }, async () => {
    const results = await refreshKind('NEWS');
    logger.info({ results }, 'news refresh finished');
  });

  await boss.work(QUEUE.eventsRefresh, { batchSize: 1 }, async () => {
    const results = await refreshKind('EVENT');
    logger.info({ results }, 'events refresh finished');
  });

  await boss.work(QUEUE.trendingRefresh, { batchSize: 1 }, async () => {
    const results = await refreshKind('TRENDING');
    logger.info({ results }, 'trending refresh finished');
  });

  await boss.work(QUEUE.podcastRefresh, { batchSize: 1 }, async () => {
    const results = await refreshKind('PODCAST');
    logger.info({ results }, 'podcast refresh finished');
  });

  await boss.work(QUEUE.moderationCaseRetention, { batchSize: 1 }, async () => {
    const [cases, posts] = await Promise.all([
      purgeResolvedModerationCases(),
      purgeRemovedPostsWithoutThreads(),
    ]);
    if (cases > 0) logger.info({ cases }, 'resolved moderation cases purged');
    if (posts > 0) logger.info({ posts }, 'removed posts without threads purged');
  });

  await boss.work(QUEUE.moderationExpireAppeals, { batchSize: 1 }, async () => {
    const expired = await expireModerationAppeals();
    if (expired > 0) logger.info({ expired }, 'moderation appeals expired');
  });

  await boss.work(QUEUE.accountDeletionPurge, { batchSize: 1 }, async () => {
    const purged = await purgeDeletedAccounts();
    if (purged > 0) logger.info({ purged }, 'accounts purged');
  });

  await boss.work(QUEUE.avatarBackfill, { batchSize: 1 }, async () => {
    const assigned = await backfillMissingAvatars();
    if (assigned > 0) logger.info({ assigned }, 'bug avatars assigned');
  });

  await boss.work(QUEUE.notificationCleanup, { batchSize: 1 }, async () => {
    const removed = await cleanupExpiredNotifications();
    if (removed > 0) logger.info({ removed }, 'expired notifications removed');
  });

  await boss.work(QUEUE.tokenCleanup, { batchSize: 1 }, async () => {
    const [otps, resets, counters, attempts, bans] = await Promise.all([
      expireOtps(),
      expirePasswordResets(),
      cleanupRateCounters(),
      purgeOldLoginAttempts(),
      liftExpiredBans(),
    ]);
    logger.info({ otps, resets, counters, attempts, bans }, 'token cleanup finished');
  });

  await boss.work(QUEUE.emailRestrictionCleanup, { batchSize: 1 }, async () => {
    const removed = await expireEmailRestrictions();
    if (removed > 0) logger.info({ removed }, 'email restrictions expired');
  });

  await boss.work(QUEUE.workerHeartbeat, { batchSize: 1 }, async () => {
    await writeHeartbeat();
  });
};

export const WORKER_ID = `worker-${process.pid}`;

export const writeHeartbeat = async (): Promise<void> => {
  await prisma.workerHeartbeat.upsert({
    where: { workerId: WORKER_ID },
    create: { workerId: WORKER_ID, startedAt: new Date(), lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
};

export const registerSchedules = async (boss: PgBoss): Promise<void> => {
  const schedules: Array<{ name: string; cron: string }> = [
    { name: QUEUE.newsRefresh, cron: '*/30 * * * *' },
    { name: QUEUE.eventsRefresh, cron: '0 * * * *' },
    { name: QUEUE.trendingRefresh, cron: '5 * * * *' },
    { name: QUEUE.podcastRefresh, cron: '15 * * * *' },
    { name: QUEUE.moderationExpireAppeals, cron: '*/15 * * * *' },
    { name: QUEUE.moderationCaseRetention, cron: '25 3 * * *' },
    { name: QUEUE.accountDeletionPurge, cron: '10 * * * *' },
    { name: QUEUE.avatarBackfill, cron: '50 * * * *' },
    { name: QUEUE.notificationCleanup, cron: '20 * * * *' },
    { name: QUEUE.tokenCleanup, cron: '30 * * * *' },
    { name: QUEUE.emailRestrictionCleanup, cron: '40 * * * *' },
    { name: QUEUE.workerHeartbeat, cron: '* * * * *' },
  ];

  for (const schedule of schedules) {
    await boss.schedule(schedule.name, schedule.cron, {}, { tz: 'UTC' });
  }
};
