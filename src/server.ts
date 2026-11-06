import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startBoss, stopBoss } from './jobs/boss.js';
import { ensureSources } from './modules/external/service.js';

const main = async (): Promise<void> => {
  const app = await buildApp();

  await startBoss({ runScheduler: false });

  await ensureSources().catch((error: unknown) => {
    logger.warn({ err: error }, 'could not seed external sources');
  });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(
    { port: env.API_PORT, host: env.API_HOST, docs: `${env.APP_BASE_URL}/docs` },
    'API listening',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down API');
    try {
      await app.close();
      await stopBoss();
      await prisma.$disconnect();
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
});
