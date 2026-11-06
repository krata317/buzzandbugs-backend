import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashIp } from '../../lib/crypto.js';

export interface AuditLogInput {
  actorType: 'ADMIN' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

export const writeAuditLog = async (input: AuditLogInput): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata,
      ipHash: input.ip ? hashIp(input.ip) : null,
    },
  });
};
