import type { Post, Prisma, Reply } from '@prisma/client';
import { env } from '../../config/env.js';
import { hydrateMentions, type RichTextNode } from '../../lib/rich-text.js';
import { toPublicAuthor, type PublicAuthor } from '../users/serialize.js';

export const postInclude = {
  author: {
    select: { id: true, username: true, displayName: true, avatarFileId: true },
  },
  repostOf: {
    include: {
      author: { select: { id: true, username: true, displayName: true, avatarFileId: true } },
    },
  },
} satisfies Prisma.PostInclude;

export type PostWithRelations = Prisma.PostGetPayload<{ include: typeof postInclude }>;

export const postUrl = (id: string): string => `${env.APP_BASE_URL.replace(/\/$/, '')}/posts/${id}`;

const collectMentionIds = (doc: unknown, into: Set<string>): void => {
  if (!doc || typeof doc !== 'object') return;
  const node = doc as { type?: string; attrs?: { id?: unknown }; content?: unknown };
  if (node.type === 'mention' && typeof node.attrs?.id === 'string') {
    into.add(node.attrs.id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectMentionIds(child, into);
  }
};

export const mentionIdsIn = (doc: unknown): string[] => {
  const ids = new Set<string>();
  collectMentionIds(doc, ids);
  return [...ids];
};

export type MentionResolver = (
  userId: string,
) => { displayName: string; username: string | null } | null;

export interface RepostTarget {
  id: string;
  title: string;
  excerpt: string;
  author: PublicAuthor;
  available: boolean;
  url: string;
}

export interface PostSummary {
  id: string;
  title: string;
  excerpt: string;
  kind: 'POST' | 'REPOST';
  score: number;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  isEdited: boolean;
  url: string;
  author: PublicAuthor;
  viewerVote: number;
  repostOf: RepostTarget | null;
}

export interface PostDetail extends Omit<PostSummary, 'repostOf'> {
  content: RichTextNode | null;
  repostOf: (RepostTarget & { content: RichTextNode | null }) | null;
  moderation: { status: string; appealDeadline: string | null } | null;
}

const summarizeRepostTarget = (post: PostWithRelations['repostOf']): RepostTarget | null => {
  if (!post) return null;
  const available = post.visibility === 'VISIBLE' && !post.deletedAt;
  return {
    id: post.id,
    title: available ? post.title : '',
    excerpt: available ? post.excerpt : '',
    author: toPublicAuthor(post.author, post.authorDeleted || !post.author),
    available,
    url: postUrl(post.id),
  };
};

export const toPostSummary = (post: PostWithRelations, viewerVote: number | null): PostSummary => ({
  id: post.id,
  title: post.title,
  excerpt: post.excerpt,
  kind: post.kind,
  score: post.score,
  replyCount: post.replyCount,
  createdAt: post.createdAt.toISOString(),
  updatedAt: post.updatedAt.toISOString(),
  isEdited: post.isEdited,
  url: postUrl(post.id),
  author: toPublicAuthor(post.author, post.authorDeleted || !post.author),
  viewerVote: viewerVote ?? 0,
  repostOf: summarizeRepostTarget(post.repostOf),
});

export const toPostDetail = (
  post: PostWithRelations,
  viewerVote: number | null,
  resolveMention: MentionResolver,
  moderation?: { status: string; appealExpiresAt: Date | null } | null,
): PostDetail => {
  const summary = toPostSummary(post, viewerVote);
  const content = hydrateMentions(post.content as RichTextNode | null, resolveMention);

  const repostBase = summarizeRepostTarget(post.repostOf);
  const repostTarget =
    repostBase && post.repostOf
      ? {
          ...repostBase,
          content:
            post.repostOf.visibility === 'VISIBLE' && !post.repostOf.deletedAt
              ? hydrateMentions(post.repostOf.content as RichTextNode | null, resolveMention)
              : null,
        }
      : null;

  return {
    ...summary,
    content,
    repostOf: repostTarget,
    moderation: moderation
      ? {
          status: moderation.status,
          appealDeadline: moderation.appealExpiresAt?.toISOString() ?? null,
        }
      : null,
  };
};

export const replyAuthorInclude = {
  author: { select: { id: true, username: true, displayName: true, avatarFileId: true } },
} satisfies Prisma.ReplyInclude;

export type ReplyWithAuthor = Prisma.ReplyGetPayload<{ include: typeof replyAuthorInclude }>;

export interface ReplyDto {
  id: string;
  postId: string;
  parentId: string | null;
  depth: number;
  excerpt: string;
  content: RichTextNode | null;
  createdAt: string;
  deleted: boolean;
  author: PublicAuthor;
}

export const toReplyDto = (
  reply: ReplyWithAuthor & { content?: unknown },
  resolveMention: MentionResolver,
): ReplyDto => {
  const deleted = reply.deletedAt !== null || reply.visibility !== 'VISIBLE';
  return {
    id: reply.id,
    postId: reply.postId,
    parentId: reply.parentId,
    depth: reply.depth,
    excerpt: deleted ? '' : reply.excerpt,
    content: deleted ? null : hydrateMentions(reply.content as RichTextNode | null, resolveMention),
    createdAt: reply.createdAt.toISOString(),
    deleted,
    author: toPublicAuthor(reply.author, reply.authorDeleted || !reply.author),
  };
};

export const userSummarySelect = {
  id: true,
  username: true,
  displayName: true,
  avatarFileId: true,
} satisfies Prisma.UserSelect;

export type UserSummary = Prisma.UserGetPayload<{ select: typeof userSummarySelect }>;

export const buildMentionResolver = (users: UserSummary[]): MentionResolver => {
  const map = new Map(users.map((user) => [user.id, user]));
  return (id) => {
    const user = map.get(id);
    if (!user) return null;
    return { displayName: user.displayName, username: user.username };
  };
};

export type { Post, Reply };
