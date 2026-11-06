import { prisma } from '../../lib/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { enforceRateLimit } from '../../lib/rate-limit.js';
import { createNotification } from '../notifications/service.js';

export const getBlockedUserIds = async (userId: string): Promise<string[]> => {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set<string>();
  for (const block of blocks) {
    ids.add(block.blockerId === userId ? block.blockedId : block.blockerId);
  }
  return [...ids];
};

export const isBlockedBetween = async (a: string, b: string): Promise<boolean> => {
  if (a === b) return false;
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { id: true },
  });
  return Boolean(block);
};

export const assertNotBlocked = async (actorId: string, targetId: string): Promise<void> => {
  if (await isBlockedBetween(actorId, targetId)) {
    throw forbidden('You cannot interact with this user');
  }
};

export const followUser = async (followerId: string, targetUsername: string): Promise<void> => {
  await enforceRateLimit(
    `follow:${followerId}`,
    60,
    3600,
    'Too many follow actions. Try again later.',
  );

  const target = await prisma.user.findUnique({
    where: { usernameLower: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('User not found');
  if (target.id === followerId) throw new AppError('BAD_REQUEST', 'You cannot follow yourself');

  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: target.id, blockedId: followerId },
        { blockerId: followerId, blockedId: target.id },
      ],
    },
    select: { id: true },
  });
  if (blocked) throw forbidden('You cannot follow this user');

  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId: target.id } },
  });
  if (existing) return;

  await prisma.follow.create({ data: { followerId, followingId: target.id } });

  await createNotification({
    userId: target.id,
    type: 'follow',
    category: 'SOCIAL',
    title: 'New follower',
    body: 'Someone started following you.',
    data: { followerId },
    aggregateKey: `follow:${followerId}`,
  });
};

export const unfollowUser = async (followerId: string, targetUsername: string): Promise<void> => {
  await enforceRateLimit(
    `follow:${followerId}`,
    60,
    3600,
    'Too many follow actions. Try again later.',
  );

  const target = await prisma.user.findUnique({
    where: { usernameLower: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('User not found');

  await prisma.follow.deleteMany({ where: { followerId, followingId: target.id } });
};

export const blockUser = async (blockerId: string, targetUsername: string): Promise<void> => {
  await enforceRateLimit(
    `block:${blockerId}`,
    30,
    3600,
    'Too many block actions. Try again later.',
  );

  const target = await prisma.user.findUnique({
    where: { usernameLower: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('User not found');
  if (target.id === blockerId) throw new AppError('BAD_REQUEST', 'You cannot block yourself');

  await prisma.$transaction(async (tx) => {
    await tx.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId: target.id } },
      create: { blockerId, blockedId: target.id },
      update: {},
    });
    // Blocking removes existing follows in both directions. Unblocking never restores them.
    await tx.follow.deleteMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: target.id },
          { followerId: target.id, followingId: blockerId },
        ],
      },
    });
  });
};

export const unblockUser = async (blockerId: string, targetUsername: string): Promise<void> => {
  await enforceRateLimit(
    `block:${blockerId}`,
    30,
    3600,
    'Too many block actions. Try again later.',
  );

  const target = await prisma.user.findUnique({
    where: { usernameLower: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('User not found');

  await prisma.block.deleteMany({ where: { blockerId, blockedId: target.id } });
};

export const listBlockedUsers = async (blockerId: string) => {
  const blocks = await prisma.block.findMany({
    where: { blockerId },
    orderBy: { createdAt: 'desc' },
    include: {
      blocked: {
        select: { id: true, username: true, displayName: true, avatarFileId: true },
      },
    },
  });
  return blocks.map((block) => block.blocked);
};
