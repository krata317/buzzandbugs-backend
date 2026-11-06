import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, conflict, forbidden, notFound, rateLimited } from '../../lib/errors.js';
import { advisoryLockKey } from '../../lib/crypto.js';
import { addHours } from '../../lib/time.js';
import {
  MAX_REPLIES_PER_ROOT,
  POST_RATE_LIMIT,
  POST_RATE_WINDOW_MINUTES,
} from '../../config/constants.js';
import { buildExcerpt, validateRichText } from '../../lib/rich-text.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { assertNotBanned } from '../moderation/penalties.js';
import { getModerationProvider } from '../moderation/provider.js';
import { createNotification } from '../notifications/service.js';
import { assertNotBlocked, getBlockedUserIds } from '../social/relations.js';
import {
  buildMentionResolver,
  mentionIdsIn,
  postInclude,
  replyAuthorInclude,
  toPostDetail,
  toPostSummary,
  toReplyDto,
  userSummarySelect,
  type MentionResolver,
  type PostWithRelations,
} from './serialize.js';

const TITLE_MAX = 200;

const normalizeTitle = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new AppError('VALIDATION_ERROR', 'A title is required');
  if (trimmed.length > TITLE_MAX) {
    throw new AppError('VALIDATION_ERROR', `Titles must be at most ${TITLE_MAX} characters`);
  }
  return trimmed;
};

const mentionResolverFor = async (docs: unknown[]): Promise<MentionResolver> => {
  const ids = new Set<string>();
  for (const doc of docs) {
    for (const id of mentionIdsIn(doc)) ids.add(id);
  }
  if (ids.size === 0) return () => null;
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: userSummarySelect,
  });
  return buildMentionResolver(users);
};

const viewerVotesFor = async (
  viewerId: string | null,
  postIds: string[],
): Promise<Map<string, number>> => {
  if (!viewerId || postIds.length === 0) return new Map();
  const votes = await prisma.vote.findMany({
    where: { userId: viewerId, postId: { in: postIds } },
    select: { postId: true, value: true },
  });
  return new Map(votes.map((vote) => [vote.postId, vote.value]));
};

const assertMentionsAllowed = async (authorId: string, mentionIds: string[]): Promise<void> => {
  if (mentionIds.length === 0) return;
  const users = await prisma.user.findMany({
    where: { id: { in: mentionIds } },
    select: { id: true },
  });
  if (users.length !== new Set(mentionIds).size) {
    throw new AppError('VALIDATION_ERROR', 'One or more mentioned users do not exist');
  }
  for (const user of users) {
    if (user.id === authorId) continue;
    await assertNotBlocked(authorId, user.id);
  }
};

const syncMentions = async (
  tx: Prisma.TransactionClient,
  target: { postId?: string; replyId?: string },
  mentionIds: string[],
): Promise<void> => {
  if (mentionIds.length === 0) return;
  await tx.mention.createMany({
    data: mentionIds.map((userId) => ({
      userId,
      postId: target.postId ?? null,
      replyId: target.replyId ?? null,
    })),
  });
};

export interface CreatePostInput {
  authorId: string;
  title: string;
  content?: unknown;
  repostOfId?: string;
}

export const createPost = async (input: CreatePostInput): Promise<{ id: string }> => {
  await assertNotBanned(input.authorId);
  const title = normalizeTitle(input.title);

  const hasContent = input.content !== undefined && input.content !== null;
  if (!hasContent && !input.repostOfId) {
    throw new AppError('VALIDATION_ERROR', 'A post requires a body');
  }

  const validated = hasContent ? validateRichText(input.content) : null;
  if (validated) await assertMentionsAllowed(input.authorId, validated.mentionIds);

  let repostTargetId: string | null = null;
  if (input.repostOfId) {
    const target = await prisma.post.findUnique({
      where: { id: input.repostOfId },
      select: {
        id: true,
        authorId: true,
        repostOfId: true,
        visibility: true,
        deletedAt: true,
        title: true,
      },
    });
    if (!target || target.deletedAt || target.visibility !== 'VISIBLE') {
      throw notFound('The post you are trying to repost is not available');
    }
    if (target.authorId) await assertNotBlocked(input.authorId, target.authorId);
    repostTargetId = target.repostOfId ?? target.id;
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(${advisoryLockKey(
      `post-rate:${input.authorId}`,
    )})) AS lock_acquired`;

    const recent = await tx.post.count({
      where: {
        authorId: input.authorId,
        createdAt: { gt: addHours(new Date(), -POST_RATE_WINDOW_MINUTES / 60) },
      },
    });
    if (recent >= POST_RATE_LIMIT) {
      throw rateLimited(
        `You can publish at most ${POST_RATE_LIMIT} posts per hour. Please try again later.`,
        POST_RATE_WINDOW_MINUTES * 60,
      );
    }

    const post = await tx.post.create({
      data: {
        authorId: input.authorId,
        title,
        content: validated ? (validated.doc as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        excerpt: validated ? buildExcerpt(validated.text) : '',
        kind: repostTargetId ? 'REPOST' : 'POST',
        repostOfId: repostTargetId,
      },
      select: { id: true },
    });

    if (validated) await syncMentions(tx, { postId: post.id }, validated.mentionIds);
    return post;
  });

  if (repostTargetId) {
    const original = await prisma.post.findUnique({
      where: { id: repostTargetId },
      select: { authorId: true, title: true },
    });
    if (original?.authorId && original.authorId !== input.authorId) {
      await createNotification({
        userId: original.authorId,
        type: 'repost',
        category: 'SOCIAL',
        title: 'Someone reposted your post',
        body: `Your post "${original.title}" was reposted.`,
        data: { postId: created.id, originalPostId: repostTargetId },
        aggregateKey: `repost:${repostTargetId}`,
      });
    }
  }

  if (validated) {
    await notifyMentions(input.authorId, validated.mentionIds, created.id, title, null);
  }

  return created;
};

const notifyMentions = async (
  authorId: string,
  mentionIds: string[],
  postId: string | null,
  title: string,
  replyId: string | null,
): Promise<void> => {
  const author = await prisma.user.findUnique({
    where: { id: authorId },
    select: { displayName: true },
  });
  for (const userId of new Set(mentionIds)) {
    if (userId === authorId) continue;
    await createNotification({
      userId,
      type: 'mention',
      category: 'SOCIAL',
      title: 'You were mentioned',
      body: `${author?.displayName ?? 'Someone'} mentioned you in "${title}".`,
      data: { postId, replyId },
    });
  }
};

export const updatePost = async (
  postId: string,
  authorId: string,
  input: { title?: string; content?: unknown },
): Promise<void> => {
  await assertNotBanned(authorId);

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      authorId: true,
      kind: true,
      title: true,
      visibility: true,
      deletedAt: true,
    },
  });
  if (!post || post.deletedAt || post.visibility === 'REMOVED') throw notFound('Post not found');
  if (post.authorId !== authorId) throw forbidden('You can only edit your own posts');
  if (post.visibility === 'HIDDEN') {
    throw conflict('This post is hidden pending moderation and cannot be edited');
  }

  const title = input.title !== undefined ? normalizeTitle(input.title) : post.title;
  const validated = input.content !== undefined ? validateRichText(input.content) : null;
  if (validated) await assertMentionsAllowed(authorId, validated.mentionIds);

  const provider = getModerationProvider();
  if (!provider.isConfigured()) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Content checks are unavailable, so this edit cannot be published right now. Please try again later.',
    );
  }

  const verdict = await provider.check({
    title,
    body: validated ? validated.text : '',
  });
  if (verdict.flagged) {
    throw new AppError(
      'UNPROCESSABLE_ENTITY',
      'This edit did not pass the content check and was not saved',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.mention.deleteMany({ where: { postId } });
    await tx.post.update({
      where: { id: postId },
      data: {
        title,
        ...(validated
          ? {
              content: validated.doc as unknown as Prisma.InputJsonValue,
              excerpt: buildExcerpt(validated.text),
            }
          : {}),
        isEdited: true,
      },
    });
    if (validated) await syncMentions(tx, { postId }, validated.mentionIds);
  });

  if (validated) await notifyMentions(authorId, validated.mentionIds, postId, title, null);
};

export const deletePost = async (postId: string, authorId: string): Promise<void> => {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, deletedAt: true, visibility: true },
  });
  if (!post || post.deletedAt || post.visibility === 'REMOVED') throw notFound('Post not found');
  if (post.authorId !== authorId) throw forbidden('You can only delete your own posts');

  await prisma.post.update({
    where: { id: postId },
    data: {
      visibility: 'REMOVED',
      deletedAt: new Date(),
      content: Prisma.DbNull,
      excerpt: '',
      title: '[deleted]',
    },
  });
};

export interface FeedCursor {
  bucket: number;
  followed: boolean;
  millis: number;
  id: string;
}

const parseFeedCursor = (raw: string | undefined): FeedCursor | null => {
  const decoded = decodeCursor(raw);
  if (!decoded) return null;
  const { b, f, t, i } = decoded;
  if (
    typeof b !== 'number' ||
    typeof f !== 'boolean' ||
    typeof t !== 'number' ||
    typeof i !== 'string'
  ) {
    return null;
  }
  return { bucket: b, followed: f, millis: t, id: i };
};

export interface FeedPage {
  items: ReturnType<typeof toPostSummary>[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Keyset pagination over a stable sort key: hour bucket, then followed-author boost, then
 * creation time and id. The bucket keeps the boost local so pages never overlap or skip.
 */
export const listFeed = async (options: {
  viewerId: string | null;
  limit: number;
  cursor?: string;
}): Promise<FeedPage> => {
  const { viewerId, limit } = options;
  const cursor = parseFeedCursor(options.cursor);

  const blockedIds = viewerId ? await getBlockedUserIds(viewerId) : [];
  const blockedClause =
    blockedIds.length > 0
      ? Prisma.sql`AND (p."authorId" IS NULL OR p."authorId" NOT IN (${Prisma.join(blockedIds)}))`
      : Prisma.empty;

  const cursorClause = cursor
    ? Prisma.sql`AND (
        floor(extract(epoch from p."createdAt") / 3600) < ${cursor.bucket}
        OR (floor(extract(epoch from p."createdAt") / 3600) = ${cursor.bucket}
            AND (f."id" IS NOT NULL) < ${cursor.followed})
        OR (floor(extract(epoch from p."createdAt") / 3600) = ${cursor.bucket}
            AND (f."id" IS NOT NULL) = ${cursor.followed}
            AND floor(extract(epoch from p."createdAt") * 1000) < ${cursor.millis})
        OR (floor(extract(epoch from p."createdAt") / 3600) = ${cursor.bucket}
            AND (f."id" IS NOT NULL) = ${cursor.followed}
            AND floor(extract(epoch from p."createdAt") * 1000) = ${cursor.millis}
            AND p."id" < ${cursor.id})
      )`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{ id: string; bucket: bigint; followed: boolean; millis: bigint }>
  >`
    SELECT p."id",
           floor(extract(epoch from p."createdAt") / 3600)::bigint AS bucket,
           floor(extract(epoch from p."createdAt") * 1000)::bigint AS millis,
           (f."id" IS NOT NULL) AS followed
    FROM "Post" p
    LEFT JOIN "Follow" f
      ON f."followingId" = p."authorId" AND f."followerId" = ${viewerId ?? ''}
    WHERE p."visibility" = 'VISIBLE'
      AND p."deletedAt" IS NULL
      ${blockedClause}
      ${cursorClause}
    ORDER BY bucket DESC, followed DESC, p."createdAt" DESC, p."id" DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((row) => row.id);

  if (ids.length === 0) return { items: [], nextCursor: null, hasMore: false };

  const posts = await prisma.post.findMany({ where: { id: { in: ids } }, include: postInclude });
  const byId = new Map(posts.map((post) => [post.id, post]));
  const votes = await viewerVotesFor(viewerId, ids);

  const items = ids
    .map((id) => byId.get(id))
    .filter((post): post is PostWithRelations => Boolean(post))
    .map((post) => toPostSummary(post, votes.get(post.id) ?? null));

  const last = page[page.length - 1];
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            b: Number(last.bucket),
            f: last.followed,
            t: Number(last.millis),
            i: last.id,
          })
        : null,
  };
};

export const listUserPosts = async (options: {
  authorId: string;
  viewerId: string | null;
  limit: number;
  cursor?: string;
}) => {
  const cursor = decodeCursor(options.cursor);
  const cursorDate = typeof cursor?.c === 'string' ? new Date(cursor.c) : null;
  const cursorId = typeof cursor?.i === 'string' ? cursor.i : null;

  const posts = await prisma.post.findMany({
    where: {
      authorId: options.authorId,
      visibility: 'VISIBLE',
      deletedAt: null,
      ...(cursorDate && cursorId
        ? {
            OR: [
              { createdAt: { lt: cursorDate } },
              { createdAt: cursorDate, id: { lt: cursorId } },
            ],
          }
        : {}),
    },
    include: postInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });

  const hasMore = posts.length > options.limit;
  const page = hasMore ? posts.slice(0, options.limit) : posts;
  const votes = await viewerVotesFor(
    options.viewerId,
    page.map((post) => post.id),
  );
  const last = page[page.length - 1];

  return {
    items: page.map((post) => toPostSummary(post, votes.get(post.id) ?? null)),
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor({ c: last.createdAt.toISOString(), i: last.id }) : null,
  };
};

export const getPostForViewer = async (
  postId: string,
  viewerId: string | null,
): Promise<ReturnType<typeof toPostDetail>> => {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      ...postInclude,
      cases: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true, appealExpiresAt: true },
      },
    },
  });

  if (!post || post.visibility === 'REMOVED' || post.deletedAt) {
    throw notFound('Post not found');
  }

  const isAuthor = viewerId !== null && post.authorId === viewerId;
  if (post.visibility === 'HIDDEN' && !isAuthor) {
    throw notFound('Post not found');
  }
  if (post.authorId && viewerId) {
    await assertNotBlocked(viewerId, post.authorId).catch(() => {
      throw notFound('Post not found');
    });
  }

  const votes = await viewerVotesFor(viewerId, [post.id]);
  const resolver = await mentionResolverFor([post.content, post.repostOf?.content]);

  return toPostDetail(post, votes.get(post.id) ?? null, resolver, post.cases[0] ?? null);
};

export const voteOnPost = async (
  postId: string,
  userId: string,
  value: -1 | 0 | 1,
): Promise<{ score: number; viewerVote: number }> => {
  await assertNotBanned(userId);

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, visibility: true, deletedAt: true },
  });
  if (!post || post.deletedAt || post.visibility !== 'VISIBLE') throw notFound('Post not found');
  if (post.authorId && post.authorId !== userId) {
    await assertNotBlocked(userId, post.authorId);
  }

  return prisma.$transaction(async (tx) => {
    // Row lock serialises concurrent votes on the same post so the score cannot drift.
    await tx.$queryRaw`SELECT "id" FROM "Post" WHERE "id" = ${postId} FOR UPDATE`;

    if (value === 0) {
      await tx.vote.deleteMany({ where: { postId, userId } });
    } else {
      await tx.vote.upsert({
        where: { postId_userId: { postId, userId } },
        create: { postId, userId, value },
        update: { value },
      });
    }

    const aggregate = await tx.vote.aggregate({ where: { postId }, _sum: { value: true } });
    const score = aggregate._sum.value ?? 0;

    await tx.post.update({ where: { id: postId }, data: { score } });
    return { score, viewerVote: value };
  });
};

export interface CreateReplyInput {
  rootPostId: string;
  parentId?: string | null;
  authorId: string;
  content: unknown;
}

export const createReply = async (input: CreateReplyInput): Promise<{ id: string }> => {
  await assertNotBanned(input.authorId);

  const rootPost = await prisma.post.findUnique({
    where: { id: input.rootPostId },
    select: { id: true, authorId: true, title: true, visibility: true, deletedAt: true },
  });
  if (!rootPost || rootPost.deletedAt || rootPost.visibility !== 'VISIBLE') {
    throw notFound('Post not found');
  }
  if (rootPost.authorId && rootPost.authorId !== input.authorId) {
    await assertNotBlocked(input.authorId, rootPost.authorId);
  }

  let depth = 1;
  let parentAuthorId: string | null = null;
  if (input.parentId) {
    const parent = await prisma.reply.findUnique({
      where: { id: input.parentId },
      select: {
        id: true,
        postId: true,
        depth: true,
        authorId: true,
        deletedAt: true,
        visibility: true,
      },
    });
    if (!parent || parent.deletedAt || parent.visibility !== 'VISIBLE') {
      throw notFound('The reply you are responding to is not available');
    }
    if (parent.postId !== input.rootPostId) {
      throw new AppError('BAD_REQUEST', 'Replies must belong to the same post');
    }
    if (parent.authorId && parent.authorId !== input.authorId) {
      await assertNotBlocked(input.authorId, parent.authorId);
    }
    depth = parent.depth + 1;
    parentAuthorId = parent.authorId;
  }

  const validated = validateRichText(input.content);
  if (validated.text.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A reply cannot be empty');
  }
  await assertMentionsAllowed(input.authorId, validated.mentionIds);

  const created = await prisma.$transaction(async (tx) => {
    // One lock per (root post, author) pair makes the ten-reply cap safe under concurrency.
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(${advisoryLockKey(
      `reply-limit:${input.rootPostId}:${input.authorId}`,
    )})) AS lock_acquired`;

    const existing = await tx.reply.count({
      where: {
        postId: input.rootPostId,
        authorId: input.authorId,
        deletedAt: null,
        visibility: 'VISIBLE',
      },
    });
    if (existing >= MAX_REPLIES_PER_ROOT) {
      throw new AppError(
        'RATE_LIMITED',
        `You can post at most ${MAX_REPLIES_PER_ROOT} replies on a single post. Delete one to continue.`,
        { retryAfterSeconds: 0 },
      );
    }

    const reply = await tx.reply.create({
      data: {
        postId: input.rootPostId,
        parentId: input.parentId ?? null,
        authorId: input.authorId,
        content: validated.doc as unknown as Prisma.InputJsonValue,
        excerpt: buildExcerpt(validated.text, 200),
        depth,
      },
      select: { id: true },
    });

    await tx.post.update({
      where: { id: input.rootPostId },
      data: { replyCount: { increment: 1 } },
    });

    await syncMentions(tx, { replyId: reply.id }, validated.mentionIds);
    return reply;
  });

  const author = await prisma.user.findUnique({
    where: { id: input.authorId },
    select: { displayName: true },
  });

  if (rootPost.authorId && rootPost.authorId !== input.authorId) {
    await createNotification({
      userId: rootPost.authorId,
      type: 'reply',
      category: 'SOCIAL',
      title: 'New reply',
      body: `${author?.displayName ?? 'Someone'} replied to "${rootPost.title}".`,
      data: { postId: input.rootPostId, replyId: created.id },
    });
  }

  if (parentAuthorId && parentAuthorId !== input.authorId && parentAuthorId !== rootPost.authorId) {
    await createNotification({
      userId: parentAuthorId,
      type: 'reply',
      category: 'SOCIAL',
      title: 'New reply',
      body: `${author?.displayName ?? 'Someone'} replied to your comment.`,
      data: { postId: input.rootPostId, replyId: created.id },
    });
  }

  await notifyMentions(
    input.authorId,
    validated.mentionIds,
    input.rootPostId,
    rootPost.title,
    created.id,
  );

  return created;
};

export const deleteReply = async (replyId: string, authorId: string): Promise<void> => {
  const reply = await prisma.reply.findUnique({
    where: { id: replyId },
    select: { id: true, authorId: true, postId: true, deletedAt: true },
  });
  if (!reply || reply.deletedAt) throw notFound('Reply not found');
  if (reply.authorId !== authorId) throw forbidden('You can only delete your own replies');

  await prisma.$transaction(async (tx) => {
    await tx.reply.update({
      where: { id: replyId },
      data: {
        deletedAt: new Date(),
        visibility: 'REMOVED',
        content: Prisma.JsonNull,
        excerpt: '',
      },
    });
    await tx.post.updateMany({
      where: { id: reply.postId, replyCount: { gt: 0 } },
      data: { replyCount: { decrement: 1 } },
    });
  });
};

export const listReplies = async (
  postId: string,
  viewerId: string | null,
): Promise<ReturnType<typeof toReplyDto>[]> => {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, visibility: true, deletedAt: true },
  });
  if (!post || post.deletedAt || post.visibility === 'REMOVED') throw notFound('Post not found');

  const replies = await prisma.reply.findMany({
    where: { postId, visibility: 'VISIBLE', deletedAt: null },
    include: replyAuthorInclude,
    orderBy: [{ createdAt: 'asc' }],
  });

  const blocked = viewerId ? new Set(await getBlockedUserIds(viewerId)) : new Set<string>();
  const visible = replies.filter((reply) => !reply.authorId || !blocked.has(reply.authorId));
  const resolver = await mentionResolverFor(visible.map((reply) => reply.content));

  return visible.map((reply) => toReplyDto(reply, resolver));
};
