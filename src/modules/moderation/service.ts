import { Prisma, type ModerationCase } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { advisoryLockKey, randomToken, sha256 } from '../../lib/crypto.js';
import { addDays } from '../../lib/time.js';
import { env } from '../../config/env.js';
import {
  APPEAL_WINDOW_DAYS,
  MODERATION_CASE_RETENTION_DAYS,
  REPORT_DAILY_LIMIT,
  REPORT_RECHECK_COOLDOWN_HOURS,
} from '../../config/constants.js';
import { richTextToPlainText } from '../../lib/rich-text.js';
import { enforceRateLimit } from '../../lib/rate-limit.js';
import { getModerationProvider, ModerationProviderError } from './provider.js';
import { decideModeration } from './policy.js';
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

const cooldownKey = (postId: string, version: number): string =>
  `moderation:cooldown:${postId}:${version}`;

/**
 * True when this exact revision was already checked and passed recently. Reports inside the
 * window are accepted but do nothing: without this, one account could drive a provider call
 * on every request for a post that has already been cleared.
 */
const isCoolingDown = async (postId: string, version: number): Promise<boolean> => {
  const marker = await prisma.rateCounter.findUnique({
    where: { key: cooldownKey(postId, version) },
    select: { expiresAt: true },
  });
  return Boolean(marker && marker.expiresAt.getTime() > Date.now());
};

const startCooldown = async (postId: string, version: number): Promise<void> => {
  const expiresAt = new Date(Date.now() + REPORT_RECHECK_COOLDOWN_HOURS * 3_600_000);
  await prisma.rateCounter.upsert({
    where: { key: cooldownKey(postId, version) },
    create: { key: cooldownKey(postId, version), count: 1, expiresAt },
    update: { count: 1, windowStart: new Date(), expiresAt },
  });
};

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

export interface CreateReportResult {
  caseId: string | null;
  /** True when the report was accepted but no new check was started. */
  suppressed: boolean;
}

export const createReport = async (input: CreateReportInput): Promise<CreateReportResult> => {
  await enforceRateLimit(
    `moderation:report-daily:${input.reporterId}`,
    REPORT_DAILY_LIMIT,
    86_400,
    'You have submitted a lot of reports today. Please try again tomorrow.',
  );

  const post = await prisma.post.findUnique({
    where: { id: input.postId },
    select: {
      id: true,
      authorId: true,
      title: true,
      visibility: true,
      deletedAt: true,
      version: true,
    },
  });

  if (!post || post.deletedAt || post.visibility === 'REMOVED') {
    throw notFound('Post not found');
  }
  if (post.authorId && post.authorId === input.reporterId) {
    throw new AppError('BAD_REQUEST', 'You cannot report your own post');
  }

  // The revision was cleared recently: accept the report without storing or checking it.
  if (await isCoolingDown(post.id, post.version)) {
    return { caseId: null, suppressed: true };
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

      // A report applies to the revision the reporter actually saw. Editing the post
      // creates a new revision, which may be reported again.
      const alreadyReported = await tx.report.findUnique({
        where: {
          postId_reporterId_postVersion: {
            postId: input.postId,
            reporterId: input.reporterId,
            postVersion: post.version,
          },
        },
        select: { id: true },
      });
      if (alreadyReported) {
        throw conflict('You already reported this post');
      }

      if (!activeCase) {
        activeCase = await tx.moderationCase.create({
          data: {
            postId: input.postId,
            postTitle: post.title,
            status: 'PENDING_PROVIDER',
          },
        });
      }

      await tx.report.create({
        data: {
          postId: input.postId,
          reporterId: input.reporterId,
          postVersion: post.version,
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

  return { caseId, suppressed: false };
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
          version: true,
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

  // The post was deleted while the case was queued: there is nothing left to review.
  if (!moderationCase.post) {
    await prisma.moderationCase.delete({ where: { id: caseId } }).catch(() => undefined);
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

  const decision = decideModeration(verdict);

  if (!decision.flagged) {
    // Nothing wrong: the post stays public and every trace of the report is deleted, so
    // neither the author nor an administrator can learn that it was ever made. The revision
    // is then left alone for a while so it cannot be re-checked on demand.
    await discardCase(caseId);
    await startCooldown(moderationCase.post.id, moderationCase.post.version);
    return;
  }

  await hideAndOpenAppeal({
    caseId,
    postId: moderationCase.post.id,
    postTitle: moderationCase.post.title,
    authorId: moderationCase.post.authorId,
    categories: verdict.categories,
    scores: verdict.scores,
  });
};

/** Deletes a case and its reports. Used when the automated check finds nothing wrong. */
const discardCase = async (caseId: string): Promise<void> => {
  try {
    await prisma.$transaction([
      prisma.report.deleteMany({ where: { caseId } }),
      prisma.moderationCase.delete({ where: { id: caseId } }),
    ]);
  } catch (error) {
    // A concurrent run may have discarded it already.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
      throw error;
    }
  }
};

/**
 * Permanently removes content that violates the policy. Replies, votes, mentions, reports and
 * reposts are removed by the database; the moderation case is detached rather than deleted so
 * the record survives until retention expires.
 */
const removePostForPolicy = async (postId: string): Promise<void> => {
  try {
    await prisma.post.delete({ where: { id: postId } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
      throw error;
    }
  }
};

/**
 * Hides a post and opens the author's appeal window. Runs only after a report is upheld.
 */
const hideAndOpenAppeal = async (input: {
  caseId: string;
  postId: string;
  postTitle: string;
  authorId: string | null;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
}): Promise<void> => {
  const appealToken = randomToken(32);
  const appealExpiresAt = addDays(new Date(), APPEAL_WINDOW_DAYS);

  await prisma.$transaction([
    prisma.moderationCase.update({
      where: { id: input.caseId },
      data: {
        status: 'AWAITING_APPEAL',
        flagged: true,
        attempts: { increment: 1 },
        providerCategories: input.categories,
        providerScores: input.scores,
        appealTokenHash: sha256(appealToken),
        appealExpiresAt,
        lastError: null,
      },
    }),
    prisma.post.update({
      where: { id: input.postId },
      data: { visibility: 'HIDDEN' },
    }),
  ]);

  if (!input.authorId) return;

  const author = await prisma.user.findUnique({
    where: { id: input.authorId },
    select: { email: true, displayName: true },
  });
  if (!author) return;

  const appealUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/appeals/${appealToken}`;

  await createNotification({
    userId: input.authorId,
    type: 'moderation',
    category: 'ACCOUNT',
    title: 'Your post was hidden pending review',
    body: `"${input.postTitle}" needs a second look. You can appeal until ${appealExpiresAt.toISOString()}.`,
    data: { caseId: input.caseId, appealUrl, appealExpiresAt: appealExpiresAt.toISOString() },
  });

  await queueEmail({
    to: author.email,
    template: 'moderation-hidden',
    params: {
      displayName: author.displayName,
      postTitle: input.postTitle,
      appealUrl,
      appealDeadline: appealExpiresAt.toUTCString(),
    },
    userId: input.authorId,
  });
};

/**
 * Deletes closed cases after the retention window, together with their reports and audit
 * entries. Open cases are never touched.
 */
export const purgeResolvedModerationCases = async (): Promise<number> => {
  const cutoff = addDays(new Date(), -MODERATION_CASE_RETENTION_DAYS);

  const expired = await prisma.moderationCase.findMany({
    where: {
      status: { in: ['RESOLVED_KEPT', 'RESOLVED_REMOVED'] },
      decidedAt: { lt: cutoff },
    },
    select: { id: true },
    take: 500,
  });

  if (expired.length === 0) return 0;
  const ids = expired.map((entry) => entry.id);

  const [, , deleted] = await prisma.$transaction([
    prisma.report.deleteMany({ where: { caseId: { in: ids } } }),
    prisma.auditLog.deleteMany({
      where: { targetType: 'ModerationCase', targetId: { in: ids } },
    }),
    prisma.moderationCase.deleteMany({ where: { id: { in: ids } } }),
  ]);

  return deleted.count;
};

/**
 * Applies the outcome of an appeal that was never submitted: the content is removed and the
 * author receives a warning and an email.
 */
export const expireModerationAppeals = async (): Promise<number> => {
  const expired = await prisma.moderationCase.findMany({
    where: { status: 'AWAITING_APPEAL', appealExpiresAt: { lte: new Date() } },
    include: { post: { select: { id: true, title: true, authorId: true } } },
    take: 100,
  });

  for (const moderationCase of expired) {
    const title = moderationCase.post?.title ?? moderationCase.postTitle ?? 'your post';
    const authorId = moderationCase.post?.authorId ?? null;

    // The author was told and chose not to appeal, so no moderator was ever involved.
    if (authorId) {
      await issueWarning({
        userId: authorId,
        caseId: moderationCase.id,
        reason: 'Content policy violation (no appeal submitted)',
      });

      const author = await prisma.user.findUnique({
        where: { id: authorId },
        select: { email: true, displayName: true },
      });
      if (author) {
        await queueEmail({
          to: author.email,
          template: 'moderation-removed',
          params: { displayName: author.displayName, postTitle: title },
          userId: authorId,
        });
      }
    }

    // Nobody appealed, so no moderator was involved and no case needs to be kept: the
    // warning is the lasting record. Deleting the case detaches it from the warning.
    await prisma.$transaction([
      prisma.report.deleteMany({ where: { caseId: moderationCase.id } }),
      prisma.moderationCase.delete({ where: { id: moderationCase.id } }),
      ...(moderationCase.postId
        ? [prisma.post.delete({ where: { id: moderationCase.postId } })]
        : []),
    ]);
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
  if (moderationCase.status !== 'APPEALED') {
    throw conflict('This case is not awaiting a decision');
  }

  const accepted = input.decision === 'accept';
  const postId = moderationCase.postId;
  const postTitle = moderationCase.post?.title ?? moderationCase.postTitle ?? 'this post';
  const authorId = moderationCase.post?.authorId ?? null;

  if (accepted && !postId) {
    throw conflict('The post no longer exists, so it cannot be restored');
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (accepted && postId) {
      await tx.post.update({ where: { id: postId }, data: { visibility: 'VISIBLE' } });
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

  // Rejecting removes the content outright. The case is detached by the foreign key and
  // stays readable for the retention window.
  if (!accepted && postId) {
    await removePostForPolicy(postId);
  }

  if (!accepted && authorId) {
    await issueWarning({
      userId: authorId,
      caseId: moderationCase.id,
      reason: 'Content policy violation (appeal rejected)',
    });
  }

  if (authorId) {
    const author = await prisma.user.findUnique({
      where: { id: authorId },
      select: { email: true, displayName: true },
    });

    await createNotification({
      userId: authorId,
      type: 'moderation',
      category: 'ACCOUNT',
      title: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
      body: accepted
        ? `"${postTitle}" is visible again.`
        : `"${postTitle}" was removed and a warning was added.`,
      data: { caseId: moderationCase.id, decision: input.decision },
    });

    if (author) {
      await queueEmail({
        to: author.email,
        template: 'appeal-decision',
        params: {
          displayName: author.displayName,
          postTitle,
          decision: accepted ? 'accepted' : 'rejected',
        },
        userId: authorId,
      });
    }
  }

  await writeAuditLog({
    actorType: 'ADMIN',
    actorId: input.adminId,
    action: accepted ? 'moderation.appeal_accepted' : 'moderation.appeal_rejected',
    targetType: 'ModerationCase',
    targetId: moderationCase.id,
    metadata: { postId, note: input.note ?? null },
  });

  return updated;
};
