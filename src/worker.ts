import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startBoss, stopBoss } from './jobs/boss.js';
import {
  registerQueues,
  registerSchedules,
  registerWorkers,
  writeHeartbeat,
} from './jobs/worker.js';
import { ensureSources } from './modules/external/service.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

const main = async (): Promise<void> => {
  const boss = await startBoss({ runScheduler: true });

  await registerQueues(boss);
  await registerWorkers(boss);
  await registerSchedules(boss);

  await ensureSources().catch((error: unknown) => {
    logger.warn({ err: error }, 'could not seed external sources');
  });

  await writeHeartbeat();
  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch((error: unknown) => {
      logger.warn({ err: error }, 'worker heartbeat failed');
    });
  }, HEARTBEAT_INTERVAL_MS);

  logger.info('worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down worker');
    clearInterval(heartbeat);
    try {
      await stopBoss();
      await prisma.$disconnect();
    } catch (error) {
      logger.error({ err: error }, 'error during worker shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
