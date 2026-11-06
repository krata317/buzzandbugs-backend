import PgBoss from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const QUEUE = {
  emailSend: 'email.send',
  moderationProcess: 'moderation.process',
  moderationExpireAppeals: 'moderation.expire-appeals',
  moderationCaseRetention: 'moderation.case-retention',
  newsRefresh: 'news.refresh',
  eventsRefresh: 'events.refresh',
  trendingRefresh: 'trending.refresh',
  podcastRefresh: 'podcast.refresh',
  accountDeletionPurge: 'account.deletion-purge',
  avatarBackfill: 'user.avatar-backfill',
  notificationCleanup: 'notification.cleanup',
  tokenCleanup: 'token.cleanup',
  emailRestrictionCleanup: 'email.restriction-cleanup',
  workerHeartbeat: 'worker.heartbeat',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

const buildOptions = (runScheduler: boolean): PgBoss.ConstructorOptions => ({
  connectionString: env.DATABASE_URL,
  schema: 'pgboss',
  supervise: runScheduler,
  schedule: runScheduler,
  migrate: true,
  retentionDays: 14,
});

export const startBoss = async (options: { runScheduler: boolean }): Promise<PgBoss> => {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    const instance = new PgBoss(buildOptions(options.runScheduler));
    instance.on('error', (error) => {
      logger.error({ err: error }, 'pg-boss error');
    });
    await instance.start();
    boss = instance;
    logger.info({ runScheduler: options.runScheduler }, 'pg-boss started');
    return instance;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
};

export const getBoss = (): PgBoss => {
  if (!boss) throw new Error('pg-boss has not been started');
  return boss;
};

export const stopBoss = async (): Promise<void> => {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 10_000 });
  boss = null;
};

export const enqueue = async (
  name: QueueName,
  data: Record<string, unknown>,
  options: PgBoss.SendOptions = {},
): Promise<string | null> => {
  const instance = getBoss();
  return instance.send(name, data, {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    ...options,
  });
};
