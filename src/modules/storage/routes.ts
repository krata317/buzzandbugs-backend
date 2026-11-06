import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { getStorage } from './index.js';

export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/media/avatars/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Serve an avatar image',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const file = await prisma.fileObject.findUnique({ where: { id: request.params.id } });
      if (!file) throw notFound('Image not found');

      let buffer: Buffer;
      try {
        buffer = await getStorage().get(file.key);
      } catch {
        throw notFound('Image not found');
      }

      return reply
        .header('content-type', file.mimeType)
        .header('cache-control', 'public, max-age=604800, immutable')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .send(buffer);
    },
  );
};
