import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { sendData, sendPage } from '../../lib/http.js';
import { requireUser } from '../../plugins/auth.js';
import { notFound } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';

export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/notifications',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: 'List notifications',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(512).optional(),
          unreadOnly: z.coerce.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const cursor = decodeCursor(request.query.cursor);
      const cursorDate = typeof cursor?.c === 'string' ? new Date(cursor.c) : null;
      const cursorId = typeof cursor?.i === 'string' ? cursor.i : null;

      const rows = await prisma.notification.findMany({
        where: {
          userId: auth.user.id,
          expiresAt: { gt: new Date() },
          ...(request.query.unreadOnly ? { readAt: null } : {}),
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
        page.map((notification) => ({
          id: notification.id,
          type: notification.type,
          category: notification.category,
          title: notification.title,
          body: notification.body,
          data: notification.data,
          read: notification.readAt !== null,
          createdAt: notification.createdAt.toISOString(),
          expiresAt: notification.expiresAt.toISOString(),
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

  app.get(
    '/notifications/unread-count',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Notifications'], summary: 'Unread notification count' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const count = await prisma.notification.count({
        where: { userId: auth.user.id, readAt: null, expiresAt: { gt: new Date() } },
      });
      return sendData(reply, { count });
    },
  );

  app.post(
    '/notifications/:id/read',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: 'Mark one notification as read',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const updated = await prisma.notification.updateMany({
        where: { id: request.params.id, userId: auth.user.id },
        data: { readAt: new Date() },
      });
      if (updated.count === 0) throw notFound('Notification not found');
      return sendData(reply, { status: 'read' });
    },
  );

  app.post(
    '/notifications/read-all',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Notifications'], summary: 'Mark every notification as read' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const updated = await prisma.notification.updateMany({
        where: { userId: auth.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return sendData(reply, { updated: updated.count });
    },
  );

  app.delete(
    '/notifications/:id',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notifications'],
        summary: 'Delete a notification',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const deleted = await prisma.notification.deleteMany({
        where: { id: request.params.id, userId: auth.user.id },
      });
      if (deleted.count === 0) throw notFound('Notification not found');
      return sendData(reply, { status: 'deleted' });
    },
  );
};
