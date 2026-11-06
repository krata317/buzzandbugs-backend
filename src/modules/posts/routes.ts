import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendData, sendPage } from '../../lib/http.js';
import { requireUser } from '../../plugins/auth.js';
import {
  createPost,
  createReply,
  deletePost,
  deleteReply,
  getPostForViewer,
  listFeed,
  listReplies,
  updatePost,
  voteOnPost,
} from './service.js';
import { createReport } from '../moderation/service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const richText = z.unknown();

const reportReasonSchema = z.enum([
  'SPAM',
  'HARASSMENT',
  'HATE_SPEECH',
  'MISINFORMATION',
  'SEXUAL_CONTENT',
  'VIOLENCE',
  'SELF_HARM',
  'OTHER',
]);

export const postRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/feed',
    {
      preHandler: app.optionalAuthenticate,
      schema: {
        tags: ['Buzz'],
        summary: 'Chronological feed with a boost for followed authors',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(512).optional(),
        }),
      },
    },
    async (request, reply) => {
      const page = await listFeed({
        viewerId: request.auth?.user.id ?? null,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return sendPage(reply, page.items, {
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        limit: request.query.limit,
      });
    },
  );

  app.post(
    '/posts',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Buzz'],
        summary: 'Create a post or repost',
        body: z.object({
          title: z.string().trim().min(1).max(200),
          content: richText.optional(),
          repostOfId: z.string().min(1).max(64).optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const created = await createPost({
        authorId: auth.user.id,
        title: request.body.title,
        content: request.body.content,
        repostOfId: request.body.repostOfId,
      });
      return sendData(reply, created, 201);
    },
  );

  app.get(
    '/posts/:id',
    {
      preHandler: app.optionalAuthenticate,
      schema: { tags: ['Buzz'], summary: 'Post detail', params: idParam },
    },
    async (request, reply) => {
      const post = await getPostForViewer(request.params.id, request.auth?.user.id ?? null);
      return sendData(reply, post);
    },
  );

  app.patch(
    '/posts/:id',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Buzz'],
        summary: 'Edit your own post',
        params: idParam,
        body: z.object({
          title: z.string().trim().min(1).max(200).optional(),
          content: richText.optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await updatePost(request.params.id, auth.user.id, request.body);
      const post = await getPostForViewer(request.params.id, auth.user.id);
      return sendData(reply, post);
    },
  );

  app.delete(
    '/posts/:id',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Buzz'], summary: 'Delete your own post', params: idParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await deletePost(request.params.id, auth.user.id);
      return sendData(reply, { status: 'deleted' });
    },
  );

  app.post(
    '/posts/:id/vote',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Buzz'],
        summary: 'Upvote, downvote or retract a vote',
        params: idParam,
        body: z.object({ value: z.union([z.literal(1), z.literal(0), z.literal(-1)]) }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const result = await voteOnPost(request.params.id, auth.user.id, request.body.value);
      return sendData(reply, result);
    },
  );

  app.get(
    '/posts/:id/replies',
    {
      preHandler: app.optionalAuthenticate,
      schema: { tags: ['Buzz'], summary: 'Nested replies for a post', params: idParam },
    },
    async (request, reply) => {
      const replies = await listReplies(request.params.id, request.auth?.user.id ?? null);
      return sendData(reply, replies);
    },
  );

  app.post(
    '/posts/:id/replies',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Buzz'],
        summary: 'Reply to a post or to another reply',
        params: idParam,
        body: z.object({
          content: richText,
          parentId: z.string().min(1).max(64).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const created = await createReply({
        rootPostId: request.params.id,
        parentId: request.body.parentId ?? null,
        authorId: auth.user.id,
        content: request.body.content,
      });
      return sendData(reply, created, 201);
    },
  );

  app.delete(
    '/replies/:id',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Buzz'], summary: 'Delete your own reply', params: idParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await deleteReply(request.params.id, auth.user.id);
      return sendData(reply, { status: 'deleted' });
    },
  );

  app.post(
    '/posts/:id/report',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['Moderation'],
        summary: 'Report a post',
        params: idParam,
        body: z.object({
          reason: reportReasonSchema,
          details: z.string().max(1000).optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await createReport({
        postId: request.params.id,
        reporterId: auth.user.id,
        reason: request.body.reason,
        details: request.body.details,
      });
      // The outcome of a report is never disclosed to the reporter.
      return sendData(reply, { status: 'received' }, 202);
    },
  );
};
