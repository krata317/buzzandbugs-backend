import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { sendData, sendPage } from '../../lib/http.js';
import { requireUser } from '../../plugins/auth.js';
import { MAX_AVATAR_INPUT_BYTES } from '../../config/constants.js';
import { getStorage } from '../storage/index.js';
import { processAvatar } from '../storage/image.js';
import {
  avatarUrlFor,
  parseProfileVisibility,
  parseSocialLinks,
  profileVisibilityDefaults,
  socialLinkKeys,
  toPublicAuthor,
} from './serialize.js';
import { listUserPosts } from '../posts/service.js';
import {
  blockUser,
  followUser,
  listBlockedUsers,
  unfollowUser,
  unblockUser,
} from '../social/relations.js';
import { getBanState } from '../moderation/penalties.js';

const usernameParam = z.object({ username: z.string().min(1).max(30) });
const socialLinkSchema = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Links must use http or https',
  });

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/users/deleted',
    {
      schema: {
        tags: ['Users'],
        summary: 'Representation of a deleted account',
        response: {
          200: z.object({
            data: z.object({
              deleted: z.literal(true),
              displayName: z.literal('Squashed Bug'),
              profileUrl: z.literal('/users/deleted'),
            }),
          }),
        },
      },
    },
    async (_request, reply) =>
      sendData(reply, {
        deleted: true as const,
        displayName: 'Squashed Bug' as const,
        profileUrl: '/users/deleted' as const,
      }),
  );

  app.get(
    '/users/:username',
    {
      preHandler: app.optionalAuthenticate,
      schema: {
        tags: ['Users'],
        summary: 'Public profile',
        params: usernameParam,
      },
    },
    async (request, reply) => {
      const viewer = request.auth?.user ?? null;
      const user = await prisma.user.findUnique({
        where: { usernameLower: request.params.username.toLowerCase() },
        include: { settings: true },
      });
      if (!user) throw notFound('User not found');

      if (viewer && viewer.id !== user.id) {
        const blocked = await prisma.block.findFirst({
          where: {
            OR: [
              { blockerId: viewer.id, blockedId: user.id },
              { blockerId: user.id, blockedId: viewer.id },
            ],
          },
          select: { id: true },
        });
        if (blocked) throw notFound('User not found');
      }

      const visibility = parseProfileVisibility(
        user.settings?.profileVisibility ?? profileVisibilityDefaults,
      );

      const [counts, isFollowing, followsYou] = await Promise.all([
        prisma.user.findUnique({
          where: { id: user.id },
          select: { _count: { select: { followers: true, following: true, posts: true } } },
        }),
        viewer
          ? prisma.follow.findUnique({
              where: {
                followerId_followingId: { followerId: viewer.id, followingId: user.id },
              },
              select: { id: true },
            })
          : null,
        viewer
          ? prisma.follow.findUnique({
              where: {
                followerId_followingId: { followerId: user.id, followingId: viewer.id },
              },
              select: { id: true },
            })
          : null,
      ]);

      const author = toPublicAuthor(user, false);
      const ban = viewer?.id === user.id ? await getBanState(user.id) : null;

      return sendData(reply, {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: author.avatarUrl,
        profileUrl: author.profileUrl,
        about: visibility.about ? user.about : null,
        socialLinks: visibility.socialLinks ? parseSocialLinks(user.socialLinks) : {},
        createdAt: user.createdAt.toISOString(),
        stats: {
          posts: counts?._count.posts ?? 0,
          followers: visibility.followers ? (counts?._count.followers ?? 0) : null,
          following: visibility.following ? (counts?._count.following ?? 0) : null,
        },
        viewer: {
          isSelf: viewer?.id === user.id,
          isFollowing: Boolean(isFollowing),
          followsYou: Boolean(followsYou),
        },
        ban,
      });
    },
  );

  app.get(
    '/users/:username/posts',
    {
      preHandler: app.optionalAuthenticate,
      schema: {
        tags: ['Users'],
        summary: 'Posts authored by a user',
        params: usernameParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(512).optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { usernameLower: request.params.username.toLowerCase() },
        select: { id: true },
      });
      if (!user) throw notFound('User not found');

      const page = await listUserPosts({
        authorId: user.id,
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

  app.get(
    '/users/:username/followers',
    {
      schema: {
        tags: ['Users'],
        summary: 'Followers of a user',
        params: usernameParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(512).optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { usernameLower: request.params.username.toLowerCase() },
        select: { id: true },
      });
      if (!user) throw notFound('User not found');

      const rows = await prisma.follow.findMany({
        where: { followingId: user.id },
        orderBy: { createdAt: 'desc' },
        take: request.query.limit + 1,
        ...(request.query.cursor ? { cursor: { id: request.query.cursor }, skip: 1 } : {}),
        include: {
          follower: {
            select: { id: true, username: true, displayName: true, avatarFileId: true },
          },
        },
      });

      const hasMore = rows.length > request.query.limit;
      const page = hasMore ? rows.slice(0, request.query.limit) : rows;
      return sendPage(
        reply,
        page.map((row) => ({
          ...toPublicAuthor(row.follower, false),
          followedAt: row.createdAt.toISOString(),
        })),
        {
          hasMore,
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
          limit: request.query.limit,
        },
      );
    },
  );

  app.get(
    '/users/:username/following',
    {
      schema: {
        tags: ['Users'],
        summary: 'Accounts a user follows',
        params: usernameParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(512).optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { usernameLower: request.params.username.toLowerCase() },
        select: { id: true },
      });
      if (!user) throw notFound('User not found');

      const rows = await prisma.follow.findMany({
        where: { followerId: user.id },
        orderBy: { createdAt: 'desc' },
        take: request.query.limit + 1,
        ...(request.query.cursor ? { cursor: { id: request.query.cursor }, skip: 1 } : {}),
        include: {
          following: {
            select: { id: true, username: true, displayName: true, avatarFileId: true },
          },
        },
      });

      const hasMore = rows.length > request.query.limit;
      const page = hasMore ? rows.slice(0, request.query.limit) : rows;
      return sendPage(
        reply,
        page.map((row) => ({
          ...toPublicAuthor(row.following, false),
          followedAt: row.createdAt.toISOString(),
        })),
        {
          hasMore,
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
          limit: request.query.limit,
        },
      );
    },
  );

  app.patch(
    '/users/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Users'],
        summary: 'Update your profile',
        body: z.object({
          displayName: z.string().trim().min(1).max(50).optional(),
          about: z.string().max(2000).nullable().optional(),
          socialLinks: z
            .object(
              Object.fromEntries(
                socialLinkKeys.map((key) => [key, socialLinkSchema.nullable().optional()]),
              ) as Record<
                (typeof socialLinkKeys)[number],
                z.ZodOptional<z.ZodNullable<typeof socialLinkSchema>>
              >,
            )
            .partial()
            .optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const { displayName, about, socialLinks } = request.body;

      const updated = await prisma.user.update({
        where: { id: auth.user.id },
        data: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(about !== undefined ? { about } : {}),
          ...(socialLinks !== undefined ? { socialLinks: parseSocialLinks(socialLinks) } : {}),
        },
      });

      const author = toPublicAuthor(updated, false);
      return sendData(reply, {
        id: updated.id,
        username: updated.username,
        displayName: updated.displayName,
        about: updated.about,
        socialLinks: parseSocialLinks(updated.socialLinks),
        avatarUrl: author.avatarUrl,
      });
    },
  );

  app.post(
    '/users/me/avatar',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Users'], summary: 'Upload a profile picture' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      if (!request.isMultipart()) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the image as multipart/form-data');
      }

      let part;
      try {
        part = await request.file({ limits: { fileSize: MAX_AVATAR_INPUT_BYTES, files: 1 } });
      } catch {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Images must be at most 2 MB');
      }
      if (!part) throw new AppError('BAD_REQUEST', 'No file was uploaded');

      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Images must be at most 2 MB');
      }
      if (part.file.truncated) {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Images must be at most 2 MB');
      }
      if (buffer.byteLength > MAX_AVATAR_INPUT_BYTES) {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Images must be at most 2 MB');
      }

      const processed = await processAvatar(buffer);
      const key = `avatars/${auth.user.id}/${randomUUID()}.webp`;
      await getStorage().put(key, processed.buffer, processed.mimeType);

      const previousAvatarId = auth.user.avatarFileId;

      const file = await prisma.fileObject.create({
        data: {
          key,
          mimeType: processed.mimeType,
          sizeBytes: processed.buffer.byteLength,
          width: processed.width,
          height: processed.height,
          purpose: 'AVATAR',
          ownerId: auth.user.id,
        },
      });

      await prisma.user.update({
        where: { id: auth.user.id },
        data: { avatarFileId: file.id },
      });

      if (previousAvatarId) {
        const previous = await prisma.fileObject.findUnique({ where: { id: previousAvatarId } });
        if (previous) {
          await prisma.fileObject.delete({ where: { id: previous.id } }).catch(() => undefined);
          await getStorage()
            .delete(previous.key)
            .catch(() => undefined);
        }
      }

      return sendData(reply, { avatarUrl: avatarUrlFor(file.id) }, 201);
    },
  );

  app.post(
    '/users/:username/follow',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Social'], summary: 'Follow a user', params: usernameParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await followUser(auth.user.id, request.params.username);
      return sendData(reply, { following: true });
    },
  );

  app.delete(
    '/users/:username/follow',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Social'], summary: 'Unfollow a user', params: usernameParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await unfollowUser(auth.user.id, request.params.username);
      return sendData(reply, { following: false });
    },
  );

  app.post(
    '/users/:username/block',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Social'], summary: 'Block a user', params: usernameParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await blockUser(auth.user.id, request.params.username);
      return sendData(reply, { blocked: true });
    },
  );

  app.delete(
    '/users/:username/block',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Social'], summary: 'Unblock a user', params: usernameParam },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await unblockUser(auth.user.id, request.params.username);
      return sendData(reply, { blocked: false });
    },
  );

  app.get(
    '/users/me/blocked',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Social'], summary: 'List blocked users' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const blocked = await listBlockedUsers(auth.user.id);
      return sendData(
        reply,
        blocked.map((user) => toPublicAuthor(user, false)),
      );
    },
  );
};
