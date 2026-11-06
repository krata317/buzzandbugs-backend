import type { Session, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashIp, randomToken, sha256 } from '../../lib/crypto.js';
import { addDays } from '../../lib/time.js';
import { SESSION_TTL_DAYS } from '../../config/constants.js';

export interface CreatedSession {
  token: string;
  session: Session;
}

export const createSession = async (
  userId: string,
  context: { ip?: string; userAgent?: string },
): Promise<CreatedSession> => {
  const token = randomToken(32);
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: addDays(new Date(), SESSION_TTL_DAYS),
      ipHash: hashIp(context.ip),
      userAgent: context.userAgent?.slice(0, 255) ?? null,
    },
  });
  return { token, session };
};

export interface SessionWithUser {
  session: Session;
  user: User;
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export const resolveSession = async (token: string): Promise<SessionWithUser | null> => {
  if (!token || token.length < 20) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  if (Date.now() - session.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  return { session, user: session.user };
};

export const revokeSession = async (sessionId: string, userId: string): Promise<boolean> => {
  const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
  return result.count > 0;
};

export const revokeAllSessions = async (
  userId: string,
  exceptSessionId?: string,
): Promise<number> => {
  const result = await prisma.session.deleteMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  return result.count;
};

export const listSessions = async (userId: string, currentSessionId?: string) => {
  const sessions = await prisma.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
  return sessions.map((session) => ({
    id: session.id,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent,
    current: session.id === currentSessionId,
  }));
};

export const countActiveSessions = async (userId: string): Promise<number> =>
  prisma.session.count({ where: { userId, expiresAt: { gt: new Date() } } });
