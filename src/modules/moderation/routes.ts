import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sendData } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { submitAppeal } from '../moderation/service.js';

const tokenParam = z.object({ token: z.string().min(20).max(200) });

export const appealRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/appeals/:token',
    {
      schema: {
        tags: ['Moderation'],
        summary: 'Read the moderation case behind an appeal link',
        params: tokenParam,
      },
    },
    async (request, reply) => {
      const moderationCase = await prisma.moderationCase.findUnique({
        where: { appealTokenHash: sha256(request.params.token) },
        include: {
          post: { select: { id: true, title: true, createdAt: true } },
        },
      });

      if (!moderationCase) throw notFound('Appeal link is invalid');

      const expired =
        !moderationCase.appealExpiresAt || moderationCase.appealExpiresAt.getTime() <= Date.now();

      return sendData(reply, {
        caseId: moderationCase.id,
        status: moderationCase.status,
        postTitle: moderationCase.post?.title ?? moderationCase.postTitle ?? 'Removed post',
        postHiddenAt: moderationCase.updatedAt.toISOString(),
        appealDeadline: moderationCase.appealExpiresAt?.toISOString() ?? null,
        appealUsed: moderationCase.appealUsedAt !== null,
        canAppeal:
          moderationCase.status === 'AWAITING_APPEAL' && !moderationCase.appealUsedAt && !expired,
        providerCategories: moderationCase.providerCategories,
      });
    },
  );

  app.post(
    '/appeals/:token',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Moderation'],
        summary: 'Submit an appeal (single use)',
        params: tokenParam,
        body: z.object({ message: z.string().trim().min(10).max(4000) }),
      },
    },
    async (request, reply) => {
      const result = await submitAppeal(request.params.token, request.body.message);
      return sendData(reply, result, 201);
    },
  );
};
