import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sendData } from '../../lib/http.js';
import { env } from '../../config/env.js';

const startedAt = Date.now();

const WORKER_STALE_SECONDS = 120;

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Health'],
        summary: 'Process liveness',
        response: {
          200: z.object({ data: z.object({ status: z.literal('ok') }) }),
        },
      },
    },
    async (_request, reply) => sendData(reply, { status: 'ok' as const }),
  );

  app.get(
    '/health',
    {
      schema: { tags: ['Health'], summary: 'Dependency health for the API, database and worker' },
    },
    async (_request, reply) => {
      const dbStart = Date.now();
      let database: { status: 'up' | 'down'; latencyMs: number | null; error?: string };
      try {
        await prisma.$queryRaw`SELECT 1`;
        database = { status: 'up', latencyMs: Date.now() - dbStart };
      } catch (error) {
        database = {
          status: 'down',
          latencyMs: null,
          error: env.isProduction ? 'unavailable' : String(error),
        };
      }

      const heartbeat = await prisma.workerHeartbeat
        .findFirst({ orderBy: { lastSeenAt: 'desc' } })
        .catch(() => null);

      const workerAgeSeconds = heartbeat
        ? Math.floor((Date.now() - heartbeat.lastSeenAt.getTime()) / 1000)
        : null;

      const worker =
        workerAgeSeconds !== null && workerAgeSeconds <= WORKER_STALE_SECONDS
          ? { status: 'up' as const, lastSeenSecondsAgo: workerAgeSeconds }
          : {
              status: 'down' as const,
              lastSeenSecondsAgo: workerAgeSeconds,
            };

      const healthy = database.status === 'up';

      reply.code(healthy ? 200 : 503);
      return sendData(reply, {
        status: healthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        environment: env.NODE_ENV,
        api: { status: 'up' },
        database,
        worker,
      });
    },
  );
};
