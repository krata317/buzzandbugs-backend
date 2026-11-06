import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { enqueue, QUEUE, startBoss, stopBoss } from '../src/jobs/boss.js';
import {
  registerQueues,
  registerSchedules,
  registerWorkers,
  writeHeartbeat,
  WORKER_ID,
} from '../src/jobs/worker.js';
import { deliverQueuedEmail } from '../src/modules/email/service.js';
import { cleanupExpiredNotifications } from '../src/modules/notifications/service.js';
import { expireOtps, expirePasswordResets } from '../src/modules/auth/service.js';
import { processModerationCase } from '../src/modules/moderation/service.js';
import {
  setModerationProviderForTests,
  openAiModerationProvider,
} from '../src/modules/moderation/provider.js';
import { createPost, createUser } from './helpers/app.js';
import { getApp } from './helpers/app.js';
import { mailbox, resetMailbox } from './helpers/mailbox.js';
import type PgBoss from 'pg-boss';

let boss: PgBoss;

describe('background jobs', () => {
  beforeAll(async () => {
    boss = await startBoss({ runScheduler: false });
    await registerQueues(boss);
  });

  afterAll(async () => {
    await stopBoss();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetMailbox();
  });

  it('registers every queue and schedule', async () => {
    await registerSchedules(boss);
    await registerSchedules(boss);

    const schedules = await boss.getSchedules();
    const names = schedules.map((schedule) => schedule.name);

    const scheduledQueues = [
      QUEUE.newsRefresh,
      QUEUE.eventsRefresh,
      QUEUE.trendingRefresh,
      QUEUE.moderationExpireAppeals,
      QUEUE.accountDeletionPurge,
      QUEUE.notificationCleanup,
      QUEUE.tokenCleanup,
      QUEUE.emailRestrictionCleanup,
      QUEUE.workerHeartbeat,
    ];

    for (const queue of scheduledQueues) {
      expect(names).toContain(queue);
    }

    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it('persists a job and exposes it to a consumer', async () => {
    const jobId = await enqueue(QUEUE.emailSend, { deliveryId: 'test-delivery' });
    expect(jobId).toBeTruthy();

    const fetched = await boss.fetch<{ deliveryId: string }>(QUEUE.emailSend);
    const job = fetched.find((entry) => entry.id === jobId);
    expect(job?.data.deliveryId).toBe('test-delivery');

    if (job) await boss.complete(QUEUE.emailSend, job.id);
  });

  it('keeps queued jobs across a worker restart', async () => {
    const jobId = await enqueue(QUEUE.notificationCleanup, { marker: 'survives' });
    expect(jobId).toBeTruthy();

    await stopBoss();
    boss = await startBoss({ runScheduler: false });

    const fetched = await boss.fetch<{ marker: string }>(QUEUE.notificationCleanup);
    const job = fetched.find((entry) => entry.id === jobId);
    expect(job?.data.marker).toBe('survives');

    if (job) await boss.complete(QUEUE.notificationCleanup, job.id);
  });

  it('registers workers without throwing', async () => {
    await expect(registerWorkers(boss)).resolves.toBeUndefined();
  });

  it('delivers a queued email once even when retried', async () => {
    const delivery = await prisma.emailDelivery.create({
      data: {
        toEmail: 'queued@example.com',
        template: 'welcome',
        payload: { template: 'welcome', params: { username: 'queued' } },
      },
    });

    await deliverQueuedEmail(delivery.id);
    await deliverQueuedEmail(delivery.id);

    const messages = mailbox.filter((message) => message.to === 'queued@example.com');
    expect(messages.length).toBe(1);

    const stored = await prisma.emailDelivery.findUnique({ where: { id: delivery.id } });
    expect(stored?.status).toBe('SIMULATED');
    expect(stored?.attempts).toBe(1);
  });

  it('records a failed delivery instead of silently dropping it', async () => {
    const delivery = await prisma.emailDelivery.create({
      data: {
        toEmail: 'broken@example.com',
        template: 'welcome',
        payload: { template: 'welcome', params: {} },
      },
    });

    const { setTransporterForTests } = await import('../src/modules/email/service.js');
    setTransporterForTests({
      sendMail: async () => {
        throw new Error('smtp is down');
      },
    } as never);

    await expect(deliverQueuedEmail(delivery.id)).rejects.toThrow();

    const stored = await prisma.emailDelivery.findUnique({ where: { id: delivery.id } });
    expect(stored?.status).toBe('FAILED');
    expect(stored?.lastError).toContain('smtp is down');

    const { testTransporter } = await import('./helpers/mailbox.js');
    setTransporterForTests(testTransporter);
  });

  it('removes expired notifications', async () => {
    const user = await createUser({ username: 'cleanup' });

    await prisma.notification.createMany({
      data: [
        {
          userId: user.id,
          type: 'reply',
          category: 'SOCIAL',
          title: 'Expired',
          body: 'old',
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          userId: user.id,
          type: 'reply',
          category: 'SOCIAL',
          title: 'Fresh',
          body: 'new',
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    const removed = await cleanupExpiredNotifications();
    expect(removed).toBe(1);

    const remaining = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.title).toBe('Fresh');
  });

  it('removes expired OTPs and reset tokens', async () => {
    await prisma.emailOtp.create({
      data: {
        emailNormalized: 'old@example.com',
        purpose: 'REGISTER',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });

    const user = await createUser({ username: 'tokenuser' });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: 'expired-hash',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    expect(await expireOtps()).toBe(1);
    expect(await expirePasswordResets()).toBe(1);
  });

  it('writes a single heartbeat row per worker', async () => {
    await writeHeartbeat();
    await writeHeartbeat();

    const heartbeats = await prisma.workerHeartbeat.findMany({ where: { workerId: WORKER_ID } });
    expect(heartbeats.length).toBe(1);
    expect(Date.now() - heartbeats[0]!.lastSeenAt.getTime()).toBeLessThan(5000);
  });

  it('retries a failed moderation case without duplicating side effects', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'retryauthor' });
    const post = await createPost(app, author.token, { title: 'Retry', text: 'Body' });

    const moderationCase = await prisma.moderationCase.create({
      data: { postId: post.id, status: 'PENDING_PROVIDER' },
    });

    setModerationProviderForTests({
      name: 'flaky',
      isConfigured: () => true,
      check: async () => {
        throw new Error('temporary outage');
      },
    });

    await expect(processModerationCase(moderationCase.id)).rejects.toThrow();
    await expect(processModerationCase(moderationCase.id)).rejects.toThrow();

    const stored = await prisma.moderationCase.findUnique({ where: { id: moderationCase.id } });
    expect(stored?.status).toBe('PROVIDER_FAILED');
    expect(stored?.attempts).toBe(2);

    const postRow = await prisma.post.findUnique({ where: { id: post.id } });
    expect(postRow?.visibility).toBe('VISIBLE');
    expect(await prisma.warning.count({ where: { userId: author.id } })).toBe(0);

    setModerationProviderForTests(openAiModerationProvider);
  });
});
