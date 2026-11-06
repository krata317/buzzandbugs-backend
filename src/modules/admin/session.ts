import type { AdminSession } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { addHours } from '../../lib/time.js';
import { ADMIN_SESSION_TTL_HOURS } from '../../config/constants.js';

export const createAdminSession = async (
  adminId: string,
): Promise<{ token: string; session: AdminSession }> => {
  const token = randomToken(32);
  const session = await prisma.adminSession.create({
    data: {
      adminId,
      tokenHash: sha256(token),
      expiresAt: addHours(new Date(), ADMIN_SESSION_TTL_HOURS),
    },
  });
  return { token, session };
};

export const resolveAdminSession = async (
  token: string,
): Promise<{ session: AdminSession; admin: { id: string; username: string } } | null> => {
  if (!token) return null;
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { admin: { select: { id: true, username: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return { session, admin: session.admin };
};

export const revokeAdminSession = async (sessionId: string): Promise<void> => {
  await prisma.adminSession.deleteMany({ where: { id: sessionId } });
};
