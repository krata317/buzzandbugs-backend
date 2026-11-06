import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { AppError } from './errors.js';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

interface CounterRow {
  count: number;
  expiresAt: Date;
}

/**
 * Atomic fixed-window counter backed by PostgreSQL. Safe under concurrency because the
 * increment happens inside a single INSERT ... ON CONFLICT statement.
 */
export const consumeRateLimit = async (
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> => {
  const rows = await prisma.$queryRaw<CounterRow[]>`
    INSERT INTO "RateCounter" ("id", "key", "count", "windowStart", "expiresAt")
    VALUES (${randomUUID()}, ${key}, 1, now(), now() + (${windowSeconds} * interval '1 second'))
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateCounter"."expiresAt" <= now() THEN 1
        ELSE "RateCounter"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateCounter"."expiresAt" <= now() THEN now()
        ELSE "RateCounter"."windowStart"
      END,
      "expiresAt" = CASE
        WHEN "RateCounter"."expiresAt" <= now() THEN now() + (${windowSeconds} * interval '1 second')
        ELSE "RateCounter"."expiresAt"
      END
    RETURNING "count", "expiresAt"
  `;

  const row = rows[0];
  if (!row) {
    return { allowed: true, count: 0, limit, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 1000),
  );

  return {
    allowed: row.count <= limit,
    count: row.count,
    limit,
    retryAfterSeconds,
  };
};

export const enforceRateLimit = async (
  key: string,
  limit: number,
  windowSeconds: number,
  message: string,
): Promise<void> => {
  const result = await consumeRateLimit(key, limit, windowSeconds);
  if (!result.allowed) {
    throw new AppError('RATE_LIMITED', message, {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
};

export const cleanupRateCounters = async (): Promise<number> => {
  const result = await prisma.rateCounter.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
};
