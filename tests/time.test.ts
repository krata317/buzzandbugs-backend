import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { consumeRateLimit } from '../src/lib/rate-limit.js';

describe('timestamp handling', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('round-trips timestamps without a timezone offset', async () => {
    const written = new Date();
    const record = await prisma.workerHeartbeat.create({
      data: { workerId: 'tz-worker', startedAt: written, lastSeenAt: written },
    });

    const read = await prisma.workerHeartbeat.findUnique({ where: { id: record.id } });
    expect(Math.abs((read?.startedAt.getTime() ?? 0) - written.getTime())).toBeLessThan(5);
  });

  it('keeps SQL now() aligned with JavaScript time', async () => {
    await prisma.$executeRaw`
      INSERT INTO "RateCounter" ("id", "key", "count", "windowStart", "expiresAt")
      VALUES ('tz-check', 'tz-check', 1, now(), now() + interval '60 seconds')
    `;

    const row = await prisma.rateCounter.findUnique({ where: { key: 'tz-check' } });
    const deltaSeconds = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 1000;
    expect(deltaSeconds).toBeGreaterThan(55);
    expect(deltaSeconds).toBeLessThan(65);
  });

  it('reports a sensible retry delay when a rate limit is exceeded', async () => {
    await consumeRateLimit('window-check', 1, 60);
    const blocked = await consumeRateLimit('window-check', 1, 60);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(50);
    expect(blocked.retryAfterSeconds).toBeLessThan(61);
  });
});
