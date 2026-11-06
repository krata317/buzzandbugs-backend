import { Prisma, type ModerationCase } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { advisoryLockKey, randomToken, sha256 } from '../../lib/crypto.js';
import { addDays } from '../../lib/time.js';
import { env } from '../../config/env.js';
import { APPEAL_WINDOW_DAYS } from '../../config/constants.js';
import { richTextToPlainText } from '../../lib/rich-text.js';
import { getModerationProvider, ModerationProviderError } from './provider.js';
import { issueWarning } from './penalties.js';
import { createNotification } from '../notifications/service.js';
import { queueEmail } from '../email/service.js';
import { writeAuditLog } from '../admin/audit.js';
import { enqueue, QUEUE } from '../../jobs/boss.js';
import { logger } from '../../lib/logger.js';

const ACTIVE_STATUSES = [
  'PENDING_PROVIDER',
  'PROVIDER_FAILED',
  'AWAITING_APPEAL',
  'APPEALED',
] as const;

export interface CreateReportInput {
  postId: string;
  reporterId: string;
  reason:
    | 'SPAM'
    | 'HARASSMENT'
    | 'HATE_SPEECH'
    | 'MISINFORMATION'
    | 'SEXUAL_CONTENT'
    | 'VIOLENCE'
    | 'SELF_HARM'
    | 'OTHER';
  details?: string;
}

export const createReport = async (input: CreateReportInput): Promise<{ caseId: string }> => {
  const post = await prisma.post.findUnique({
    where: { id: input.postId },
    select: { id: true, authorId: true, title: true, visibility: true, deletedAt: true },
  });

  if (!post || post.deletedAt || post.visibility === 'REMOVED') {
    throw notFound('Post not found');
  }
  if (post.authorId && post.authorId === input.reporterId) {
    throw new AppError('BAD_REQUEST', 'You cannot report your own post');
  }

  let caseId: string;
  try {
    caseId = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(${advisoryLockKey(
        `moderation:${input.postId}`,
      )})) AS lock_acquired`;

      let activeCase = await tx.moderationCase.findFirst({
        where: { postId: input.postId, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: 'desc' },
      });

      const alreadyReported = await tx.report.findUnique({
        where: {
          postId_reporterId: { postId: input.postId, reporterId: input.reporterId },
        },
        select: { id: true },
      });
      if (alreadyReported) {
        throw conflict('You already reported this post');
      }

      if (!activeCase) {
        activeCase = await tx.moderationCase.create({
          data: { postId: input.postId, status: 'PENDING_PROVIDER' },
        });
      }

      await tx.report.create({
        data: {
          postId: input.postId,
          reporterId: input.reporterId,
          reason: input.reason,
          details: input.details ?? null,
          caseId: activeCase.id,
        },
      });

      return activeCase.id;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('You already reported this post');
    }
    throw error;
  }

  const reporter = await prisma.user.findUnique({
    where: { id: input.reporterId },
    select: { email: true, displayName: true },
  });

  if (reporter) {
    await queueEmail({
      to: reporter.email,
      template: 'report-acknowledgement',
      params: { displayName: reporter.displayName, postTitle: post.title },
      userId: input.reporterId,
    });
  }

  try {
    await enqueue(
      QUEUE.moderationProcess,
      { caseId },
      { singletonKey: `moderation:${caseId}`, retryLimit: 5, retryDelay: 60, retryBackoff: true },
    );
  } catch (error) {
    // Without a queue the case is processed inline; a provider failure leaves the post
    // visible and the case in PROVIDER_FAILED, exactly as the queued path would.
    logger.warn({ err: error, caseId }, 'could not enqueue moderation job, running inline');
    try {
      await processModerationCase(caseId);
    } catch (inlineError) {
      logger.warn({ err: inlineError, caseId }, 'inline moderation failed');
    }
  }

  return { caseId };
};

export const processModerationCase = async (caseId: string): Promise<void> => {
  const moderationCase = await prisma.moderationCase.findUnique({
    where: { id: caseId },
    include: {
      post: {
        select: {
          id: true,
          title: true,
          content: true,
          authorId: true,
          visibility: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!moderationCase) {
    logger.warn({ caseId }, 'moderation case not found');
    return;
  }
  if (moderationCase.status !== 'PENDING_PROVIDER' && moderationCase.status !== 'PROVIDER_FAILED') {
    return;
  }

  if (moderationCase.post.deletedAt || moderationCase.post.visibility === 'REMOVED') {
    await prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        status: 'RESOLVED_REMOVED',
        decidedAt: new Date(),
        lastError: 'post already removed',
      },
    });
    return;
  }

  const provider = getModerationProvider();
  const body = richTextToPlainText(moderationCase.post.content);

  let verdict;
  try {
    verdict = await provider.check({ title: moderationCase.post.title, body });
  } catch (error) {
    const message =
      error instanceof ModerationProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'moderation provider failed';

    await prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        status: 'PROVIDER_FAILED',
        attempts: { increment: 1 },
        lastError: message.slice(0, 500),
      },
    });

    logger.warn({ caseId, provider: provider.name, err: error }, 'moderation provider failed');
    // The job is retried with backoff. The post stays visible and no warning is issued.
    throw error;
  }

  if (!verdict.flagged) {
    await prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        status: 'RESOLVED_KEPT',
        flagged: false,
        attempts: { increment: 1 },
        providerCategories: verdict.categories,
        providerScores: verdict.scores,
        decidedAt: new Date(),
        lastError: null,
      },
    });
    return;
  }

  const appealToken = randomToken(32);
  const appealExpiresAt = addDays(new Date(), APPEAL_WINDOW_DAYS);

  await prisma.$transaction([
    prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        status: 'AWAITING_APPEAL',
        flagged: true,
        attempts: { increment: 1 },
        providerCategories: verdict.categories,
        providerScores: verdict.scores,
        appealTokenHash: sha256(appealToken),
        appealExpiresAt,
        lastError: null,
      },
    }),
    prisma.post.update({
      where: { id: moderationCase.postId },
      data: { visibility: 'HIDDEN' },
    }),
  ]);

  if (!moderationCase.post.authorId) return;

  const author = await prisma.user.findUnique({
    where: { id: moderationCase.post.authorId },
    select: { email: true, displayName: true },
  });
  if (!author) return;

  const appealUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/appeals/${appealToken}`;

  await createNotification({
    userId: moderationCase.post.authorId,
    type: 'moderation',
    category: 'ACCOUNT',
    title: 'Your post was hidden pending review',
    body: `"${moderationCase.post.title}" was reported and flagged. You can appeal until ${appealExpiresAt.toISOString()}.`,
    data: { caseId, appealUrl, appealExpiresAt: appealExpiresAt.toISOString() },
  });

  await queueEmail({
    to: author.email,
    template: 'moderation-hidden',
    params: {
      displayName: author.displayName,
      postTitle: moderationCase.post.title,
      appealUrl,
      appealDeadline: appealExpiresAt.toUTCString(),
    },
    userId: moderationCase.post.authorId,
  });
};

const removePostContent = async (postId: string): Promise<void> => {
  await prisma.post.update({
    where: { id: postId },
    data: {
      visibility: 'REMOVED',
      deletedAt: new Date(),
      content: Prisma.DbNull,
      excerpt: '',
      title: '[removed]',
    },
  });
};

export const expireModerationAppeals = async (): Promise<number> => {
  const expired = await prisma.moderationCase.findMany({
    where: { status: 'AWAITING_APPEAL', appealExpiresAt: { lte: new Date() } },
    include: { post: { select: { id: true, title: true, authorId: true } } },
    take: 100,
  });

  for (const moderationCase of expired) {
    await prisma.moderationCase.update({
      where: { id: moderationCase.id },
      data: { status: 'RESOLVED_REMOVED', decidedAt: new Date(), appealTokenHash: null },
    });
    await removePostContent(moderationCase.postId);

    if (moderationCase.post.authorId) {
      await issueWarning({
        userId: moderationCase.post.authorId,
        caseId: moderationCase.id,
        reason: 'Content policy violation (no appeal submitted)',
      });
      const author = await prisma.user.findUnique({
        where: { id: moderationCase.post.authorId },
        select: { email: true, displayName: true },
      });
      if (author) {
        await queueEmail({
          to: author.email,
          template: 'moderation-removed',
          params: { displayName: author.displayName, postTitle: moderationCase.post.title },
          userId: moderationCase.post.authorId,
        });
      }
    }

    await writeAuditLog({
      actorType: 'SYSTEM',
      action: 'moderation.appeal_expired',
      targetType: 'ModerationCase',
      targetId: moderationCase.id,
      metadata: { postId: moderationCase.postId },
    });
  }

  return expired.length;
};

export const submitAppeal = async (
  token: string,
  message: string,
): Promise<{ caseId: string; status: string }> => {
  const moderationCase = await prisma.moderationCase.findUnique({
    where: { appealTokenHash: sha256(token) },
  });

  if (!moderationCase) throw notFound('Appeal link is invalid');
  if (moderationCase.appealUsedAt) throw conflict('This appeal link has already been used');
  if (moderationCase.status !== 'AWAITING_APPEAL') {
    throw conflict('This case is no longer open for appeals');
  }
  if (!moderationCase.appealExpiresAt || moderationCase.appealExpiresAt.getTime() <= Date.now()) {
    throw new AppError('BAD_REQUEST', 'The appeal window has closed');
  }

  await prisma.moderationCase.update({
    where: { id: moderationCase.id },
    data: {
      status: 'APPEALED',
      appealedAt: new Date(),
      appealUsedAt: new Date(),
      appealMessage: message.slice(0, 4000),
    },
  });

  await writeAuditLog({
    actorType: 'SYSTEM',
    action: 'moderation.appeal_submitted',
    targetType: 'ModerationCase',
    targetId: moderationCase.id,
    metadata: { postId: moderationCase.postId },
  });

  return { caseId: moderationCase.id, status: 'APPEALED' };
};

export interface DecideCaseInput {
  caseId: string;
  adminId: string;
  decision: 'accept' | 'reject';
  note?: string;
}

export const decideModerationCase = async (input: DecideCaseInput): Promise<ModerationCase> => {
  const moderationCase = await prisma.moderationCase.findUnique({
    where: { id: input.caseId },
    include: { post: { select: { id: true, title: true, authorId: true } } },
  });

  if (!moderationCase) throw notFound('Moderation case not found');
  if (moderationCase.status !== 'APPEALED' && moderationCase.status !== 'AWAITING_APPEAL') {
    throw conflict('This case has already been decided');
  }

  const accepted = input.decision === 'accept';

  const updated = await prisma.$transaction(async (tx) => {
    if (accepted) {
      await tx.post.update({
        where: { id: moderationCase.postId },
        data: { visibility: 'VISIBLE' },
      });
    } else {
      await tx.post.update({
        where: { id: moderationCase.postId },
        data: {
          visibility: 'REMOVED',
          deletedAt: new Date(),
          content: Prisma.DbNull,
          excerpt: '',
          title: '[removed]',
        },
      });
    }

    return tx.moderationCase.update({
      where: { id: moderationCase.id },
      data: {
        status: accepted ? 'RESOLVED_KEPT' : 'RESOLVED_REMOVED',
        decidedAt: new Date(),
        adminId: input.adminId,
        decisionNote: input.note ?? null,
        appealTokenHash: null,
      },
    });
  });

  if (!accepted && moderationCase.post.authorId) {
    await issueWarning({
      userId: moderationCase.post.authorId,
      caseId: moderationCase.id,
      reason: 'Content policy violation (appeal rejected)',
    });
  }

  if (moderationCase.post.authorId) {
    const author = await prisma.user.findUnique({
      where: { id: moderationCase.post.authorId },
      select: { email: true, displayName: true },
    });

    await createNotification({
      userId: moderationCase.post.authorId,
      type: 'moderation',
      category: 'ACCOUNT',
      title: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
      body: accepted
        ? `"${moderationCase.post.title}" is visible again.`
        : `"${moderationCase.post.title}" was removed and a warning was added.`,
      data: { caseId: moderationCase.id, decision: input.decision },
    });

    if (author) {
      await queueEmail({
        to: author.email,
        template: 'appeal-decision',
        params: {
          displayName: author.displayName,
          postTitle: moderationCase.post.title,
          decision: accepted ? 'accepted' : 'rejected',
        },
        userId: moderationCase.post.authorId,
      });
    }
  }

  await writeAuditLog({
    actorType: 'ADMIN',
    actorId: input.adminId,
    action: accepted ? 'moderation.appeal_accepted' : 'moderation.appeal_rejected',
    targetType: 'ModerationCase',
    targetId: moderationCase.id,
    metadata: { postId: moderationCase.postId, note: input.note ?? null },
  });

  return updated;
};
