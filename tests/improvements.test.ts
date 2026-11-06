import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, cookiesFrom, createPost, createUser, getApp } from './helpers/app.js';
import {
  openAiModerationProvider,
  setModerationProviderForTests,
  type ModerationProvider,
  type ModerationVerdict,
} from '../src/modules/moderation/provider.js';
import {
  categoryThresholds,
  decideModeration,
  defaultThreshold,
} from '../src/modules/moderation/policy.js';
import {
  createReport,
  expireModerationAppeals,
  purgeResolvedModerationCases,
} from '../src/modules/moderation/service.js';
import { REPORT_DAILY_LIMIT } from '../src/config/constants.js';
import { sectionLimitFor } from '../src/modules/external/service.js';
import { sliceFeedXml } from '../src/modules/external/feed.js';
import { parseIsoDuration } from '../src/modules/external/sources/trending.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { extractTokenFromLink } from './helpers/mailbox.js';

const providerFor = (verdict: ModerationVerdict): ModerationProvider => ({
  name: 'test-provider',
  isConfigured: () => true,
  check: async () => verdict,
});

const clean: ModerationVerdict = { flagged: false, categories: {}, scores: { harassment: 0.05 } };
const flagged: ModerationVerdict = {
  flagged: true,
  categories: { harassment: true },
  scores: { harassment: 0.96 },
};

const loginAdmin = async (username: string, password: string) => {
  const app = await getApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const jar = cookiesFrom(response);
  return {
    cookie: Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
    csrf: jar.bnb_admin_csrf ?? '',
  };
};

describe('moderation policy', () => {
  it('acts on provider-flagged content', () => {
    expect(decideModeration(flagged).flagged).toBe(true);
  });

  it('leaves clearly acceptable content alone', () => {
    expect(decideModeration(clean).flagged).toBe(false);
  });

  it('keeps every threshold strictly below 0.4', () => {
    for (const [category, threshold] of Object.entries(categoryThresholds)) {
      expect(threshold, category).toBeLessThan(0.4);
      expect(threshold, category).toBeGreaterThan(0);
    }
    expect(defaultThreshold).toBeLessThan(0.4);
  });

  it('grades the thresholds by severity', () => {
    expect(categoryThresholds['sexual/minors']).toBeLessThan(
      categoryThresholds['hate/threatening'],
    );
    expect(categoryThresholds['hate/threatening']).toBeLessThan(
      categoryThresholds['harassment/threatening'],
    );
    expect(categoryThresholds['harassment/threatening']).toBeLessThan(
      categoryThresholds['violence/graphic'],
    );
    expect(categoryThresholds['violence/graphic']).toBeLessThan(categoryThresholds.harassment);
    expect(categoryThresholds.harassment).toBeLessThan(defaultThreshold);
  });

  it('ignores scores just under a category threshold', () => {
    const decision = decideModeration({
      flagged: false,
      categories: {},
      scores: { harassment: 0.35 },
    });
    expect(decision.flagged).toBe(false);
  });

  it('acts on harassment at its threshold', () => {
    const decision = decideModeration({
      flagged: false,
      categories: {},
      scores: { harassment: 0.36 },
    });
    expect(decision.flagged).toBe(true);
    expect(decision.categories).toContain('harassment');
  });

  it('applies the default threshold to categories without their own entry', () => {
    expect(
      decideModeration({ flagged: false, categories: {}, scores: { sexual: 0.37 } }).flagged,
    ).toBe(false);
    expect(
      decideModeration({ flagged: false, categories: {}, scores: { sexual: 0.38 } }).flagged,
    ).toBe(true);
  });

  it('acts earlier on the most severe categories', () => {
    const decision = decideModeration({
      flagged: false,
      categories: {},
      scores: { 'sexual/minors': 0.15 },
    });
    expect(decision.flagged).toBe(true);
    expect(
      decideModeration({ flagged: false, categories: {}, scores: { 'sexual/minors': 0.14 } })
        .flagged,
    ).toBe(false);
  });
});

describe('report-driven moderation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('publishes a new post without checking it', async () => {
    setModerationProviderForTests(providerFor(flagged));
    const app = await getApp();
    const author = await createUser({ username: 'unchecked' });

    const post = await createPost(app, author.token, { title: 'Unchecked post', text: 'body' });

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('VISIBLE');
    expect(await prisma.moderationCase.count({ where: { postId: post.id } })).toBe(0);
  });

  it('keeps a reported post public and leaves no trace when it passes', async () => {
    setModerationProviderForTests(providerFor(clean));
    const app = await getApp();
    const author = await createUser({ username: 'reviewed' });
    const reporter = await createUser({ username: 'concerned' });

    const post = await createPost(app, author.token, { title: 'Reviewed post', text: 'fine' });

    const report = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });
    expect(report.statusCode).toBe(202);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('VISIBLE');

    // No case survives, so the admin console never learns the post was reported.
    expect(await prisma.moderationCase.count({ where: { postId: post.id } })).toBe(0);
    expect(await prisma.report.count({ where: { postId: post.id } })).toBe(0);

    // Neither the author nor anyone else is told anything.
    expect(await prisma.notification.count({ where: { userId: author.id } })).toBe(0);

    for (const token of [reporter.token, author.token]) {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/posts/${post.id}`,
        headers: bearer(token),
      });
      expect(detail.json().data.moderation).toBeNull();
    }
  });

  it('hides a flagged post and opens a seven-day appeal', async () => {
    setModerationProviderForTests(providerFor(flagged));
    const app = await getApp();
    const author = await createUser({ username: 'flaggedauthor' });
    const reporter = await createUser({ username: 'flaggingreporter' });

    const post = await createPost(app, author.token, { title: 'Bad post', text: 'bad content' });

    const beforeReport = await prisma.post.findUnique({ where: { id: post.id } });
    expect(beforeReport?.visibility).toBe('VISIBLE');

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'HARASSMENT' },
    });

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('HIDDEN');

    const moderationCase = await prisma.moderationCase.findFirst({ where: { postId: post.id } });
    expect(moderationCase?.status).toBe('AWAITING_APPEAL');
    expect(moderationCase?.appealExpiresAt).toBeTruthy();

    const notification = await prisma.notification.findFirst({
      where: { userId: author.id, type: 'moderation' },
    });
    expect(notification).toBeTruthy();

    const feed = await app.inject({ method: 'GET', url: '/api/v1/feed' });
    expect(feed.json().data).toHaveLength(0);
  });
});

describe('re-reporting edited posts', () => {
  beforeEach(async () => {
    await resetDatabase();
    setModerationProviderForTests(providerFor(clean));
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('ignores repeat reports on the same revision while it is cooling down', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'authorone' });
    const reporter = await createUser({ username: 'reporterone' });
    const post = await createPost(app, author.token, { title: 'Stable post', text: 'body' });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });
    expect(first.statusCode).toBe(202);

    // The check passed, every trace was removed, and the revision is now left alone.
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });
    expect(second.statusCode).toBe(202);

    expect(await prisma.report.count({ where: { postId: post.id } })).toBe(0);
    expect(await prisma.moderationCase.count({ where: { postId: post.id } })).toBe(0);

    const marker = await prisma.rateCounter.findUnique({
      where: { key: `moderation:cooldown:${post.id}:0` },
    });
    expect(marker?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('calls the provider once while a revision is cooling down', async () => {
    let calls = 0;
    setModerationProviderForTests({
      name: 'counting',
      isConfigured: () => true,
      check: async () => {
        calls += 1;
        return clean;
      },
    });

    const app = await getApp();
    const author = await createUser({ username: 'coolauthor' });
    const firstReporter = await createUser({ username: 'coolreporterone' });
    const secondReporter = await createUser({ username: 'coolreportertwo' });
    const post = await createPost(app, author.token, { title: 'Cooling down', text: 'body' });

    for (const reporter of [firstReporter, secondReporter]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${post.id}/report`,
        headers: bearer(reporter.token),
        payload: { reason: 'SPAM' },
      });
      expect(response.statusCode).toBe(202);
    }

    // A second account cannot force a second provider call on the same revision.
    expect(calls).toBe(1);
  });

  it('checks the same revision again once the cooldown has passed', async () => {
    let calls = 0;
    setModerationProviderForTests({
      name: 'counting',
      isConfigured: () => true,
      check: async () => {
        calls += 1;
        return clean;
      },
    });

    const app = await getApp();
    const author = await createUser({ username: 'recheckauthor' });
    const reporter = await createUser({ username: 'recheckreporter' });
    const post = await createPost(app, author.token, { title: 'Rechecked', text: 'body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });

    await prisma.rateCounter.update({
      where: { key: `moderation:cooldown:${post.id}:0` },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });
    expect(again.statusCode).toBe(202);
    expect(calls).toBe(2);
  });

  it('caps how many reports one account can submit per day', async () => {
    setModerationProviderForTests(providerFor(clean));
    const author = await createUser({ username: 'capauthor' });
    const reporter = await createUser({ username: 'capreporter' });
    const post = await prisma.post.create({
      data: { authorId: author.id, title: 'Cap host', excerpt: '' },
    });

    for (let index = 0; index < REPORT_DAILY_LIMIT; index += 1) {
      await createReport({ postId: post.id, reporterId: reporter.id, reason: 'SPAM' });
    }

    await expect(
      createReport({ postId: post.id, reporterId: reporter.id, reason: 'SPAM' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('allows a new report after the post is edited', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'authortwo' });
    const reporter = await createUser({ username: 'reportertwo' });
    const post = await createPost(app, author.token, { title: 'Editable', text: 'first' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(author.token),
      payload: {
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second version' }] }],
        },
      },
    });
    expect(edit.statusCode).toBe(200);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.version).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });
    expect(again.statusCode).toBe(202);
  });
});

describe('moderation case retention', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('deletes expired cases together with their audit entries', async () => {
    const author = await createUser({ username: 'retention' });
    const post = await prisma.post.create({
      data: { authorId: author.id, title: 'Case host', excerpt: '' },
    });

    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

    const oldKept = await prisma.moderationCase.create({
      data: {
        postId: post.id,
        status: 'RESOLVED_KEPT',
        decidedAt: daysAgo(40),
        createdAt: daysAgo(45),
      },
    });
    const oldRemoved = await prisma.moderationCase.create({
      data: {
        postId: post.id,
        status: 'RESOLVED_REMOVED',
        decidedAt: daysAgo(40),
        createdAt: daysAgo(45),
      },
    });
    const recent = await prisma.moderationCase.create({
      data: {
        postId: post.id,
        status: 'RESOLVED_KEPT',
        decidedAt: daysAgo(5),
        createdAt: daysAgo(6),
      },
    });
    const open = await prisma.moderationCase.create({
      data: { postId: post.id, status: 'AWAITING_APPEAL', createdAt: daysAgo(45) },
    });

    const reporter = await createUser({ username: 'retentionreporter' });
    await prisma.report.createMany({
      data: [
        {
          postId: post.id,
          reporterId: reporter.id,
          postVersion: 0,
          reason: 'SPAM',
          caseId: oldKept.id,
        },
        {
          postId: post.id,
          reporterId: reporter.id,
          postVersion: 1,
          reason: 'SPAM',
          caseId: oldRemoved.id,
        },
        {
          postId: post.id,
          reporterId: reporter.id,
          postVersion: 2,
          reason: 'SPAM',
          caseId: recent.id,
        },
      ],
    });

    await prisma.auditLog.createMany({
      data: [
        {
          actorType: 'ADMIN',
          action: 'moderation.appeal_accepted',
          targetType: 'ModerationCase',
          targetId: oldKept.id,
        },
        {
          actorType: 'ADMIN',
          action: 'moderation.appeal_rejected',
          targetType: 'ModerationCase',
          targetId: oldRemoved.id,
        },
        {
          actorType: 'ADMIN',
          action: 'moderation.appeal_submitted',
          targetType: 'ModerationCase',
          targetId: recent.id,
        },
        { actorType: 'SYSTEM', action: 'admin.bootstrap' },
      ],
    });

    const purged = await purgeResolvedModerationCases();
    expect(purged).toBe(2);

    const remaining = await prisma.moderationCase.findMany({ select: { id: true, status: true } });
    expect(remaining.map((entry) => entry.id).sort()).toEqual([recent.id, open.id].sort());

    // Reports die with their case; the open case keeps its report.
    const reports = await prisma.report.findMany({ select: { caseId: true } });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.caseId).toBe(recent.id);

    // Logs for the deleted cases are gone; unrelated and recent entries are kept.
    const logs = await prisma.auditLog.findMany({ select: { action: true } });
    expect(logs.map((entry) => entry.action).sort()).toEqual([
      'admin.bootstrap',
      'moderation.appeal_submitted',
    ]);
  });
});

describe('permanent removal', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('removes the post and its reposts when an appeal window expires', async () => {
    setModerationProviderForTests(providerFor(flagged));
    const app = await getApp();
    const author = await createUser({ username: 'removedauthor' });
    const reposter = await createUser({ username: 'removedreposter' });
    const reporter = await createUser({ username: 'removedreporter' });

    const original = await createPost(app, author.token, {
      title: 'Removed original',
      text: 'bad content',
    });
    const repost = await createPost(app, reposter.token, {
      title: 'Quoting the original',
      repostOfId: original.id,
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${original.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'HARASSMENT' },
    });

    await prisma.moderationCase.updateMany({
      where: { postId: original.id },
      data: { appealExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await expireModerationAppeals()).toBe(1);

    // Content and its derivatives are gone.
    expect(await prisma.post.findUnique({ where: { id: original.id } })).toBeNull();
    expect(await prisma.post.findUnique({ where: { id: repost.id } })).toBeNull();

    // No moderator was involved, so no case is kept. The warning is the record.
    expect(await prisma.moderationCase.count({ where: { postTitle: 'Removed original' } })).toBe(0);
    expect(await prisma.warning.count({ where: { userId: author.id } })).toBe(1);
  });
});

describe('post counts', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('excludes deleted posts from profile statistics', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'counter' });

    const kept = await createPost(app, author.token, { title: 'Kept', text: 'a' });
    const removed = await createPost(app, author.token, { title: 'Removed', text: 'b' });
    expect(kept.id).toBeTruthy();

    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${removed.id}`,
      headers: bearer(author.token),
    });
    expect(deletion.statusCode).toBe(200);

    const profile = await app.inject({ method: 'GET', url: '/api/v1/users/counter' });
    expect(profile.json().data.stats.posts).toBe(1);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(author.token),
    });
    expect(me.json().data.stats.posts).toBe(1);
  });
});

describe('external content rules', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('keeps fifty news items per section and twenty-five podcasts', () => {
    expect(sectionLimitFor('NEWS')).toBe(50);
    expect(sectionLimitFor('PODCAST')).toBe(25);
  });

  it('parses ISO-8601 video durations', () => {
    expect(parseIsoDuration('PT4M59S')).toBe(299);
    expect(parseIsoDuration('PT5M')).toBe(300);
    expect(parseIsoDuration('PT1H2M10S')).toBe(3730);
    expect(parseIsoDuration('P1DT1S')).toBe(86_401);
    expect(parseIsoDuration('not-a-duration')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it('trims a feed document to the newest entries', () => {
    const xml = `<rss><channel>
      <item><title>One</title></item>
      <item><title>Two</title></item>
      <item><title>Three</title></item>
    </channel></rss>`;
    const sliced = sliceFeedXml(xml, 2);
    expect((sliced.match(/<item>/g) ?? []).length).toBe(2);
    expect(sliced).not.toContain('Three');
  });

  it('serves podcasts separately from trending', async () => {
    const app = await getApp();
    await prisma.externalItem.createMany({
      data: [
        {
          sourceKey: 'podcast-changelog',
          kind: 'PODCAST',
          section: 'changelog',
          externalId: 'podcast-changelog:1',
          title: 'Episode one',
          url: 'https://changelog.com/podcast/1',
          publishedAt: new Date(),
        },
        {
          sourceKey: 'github-repositories',
          kind: 'TRENDING',
          section: 'repositories',
          externalId: 'github-repositories:1',
          title: 'owner/repo',
          url: 'https://github.com/owner/repo',
          publishedAt: new Date(),
        },
      ],
    });

    const podcasts = await app.inject({ method: 'GET', url: '/api/v1/podcasts' });
    expect(podcasts.statusCode).toBe(200);
    const podcastSections = podcasts
      .json()
      .data.sections.map((section: { section: string }) => section.section);
    expect(podcastSections).toEqual(['changelog']);

    const trending = await app.inject({ method: 'GET', url: '/api/v1/trending' });
    const trendingSections = trending
      .json()
      .data.sections.map((section: { section: string }) => section.section);
    expect(trendingSections).not.toContain('podcasts');

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/podcasts/nope' });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('admin visibility of moderation cases', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('only shows cases the author appealed', async () => {
    setModerationProviderForTests(providerFor(flagged));
    const app = await getApp();
    const author = await createUser({ username: 'appealvis' });
    const reporter = await createUser({ username: 'appealvisrep' });

    await prisma.adminUser.create({
      data: { username: 'caseadmin', passwordHash: await hashPassword('admin-password-123') },
    });
    const session = await loginAdmin('caseadmin', 'admin-password-123');

    const post = await createPost(app, author.token, { title: 'Flagged post', text: 'body' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'HARASSMENT' },
    });

    // Automated decision, no appeal yet: the admin console must not see it at all.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/moderation/cases',
      headers: { cookie: session.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toHaveLength(0);

    const overviewBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: session.cookie },
    });
    expect(overviewBefore.json().data.reportsReviewed).toBe(0);
    expect(overviewBefore.json().data.openAppeals).toBe(0);

    // The author appeals. Only now does it become a human decision.
    const token = extractTokenFromLink('appealvis@example.com', '/appeals');
    expect(token).toBeTruthy();

    const appeal = await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      headers: bearer(author.token),
      payload: { message: 'Please take another look.' },
    });
    expect(appeal.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/moderation/cases',
      headers: { cookie: session.cookie },
    });
    expect(after.json().data).toHaveLength(1);
    expect(after.json().data[0].status).toBe('APPEALED');

    const overviewAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: session.cookie },
    });
    expect(overviewAfter.json().data.reportsReviewed).toBe(1);
    expect(overviewAfter.json().data.openAppeals).toBe(1);
  });
});

describe('admin audit log clearing', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('deletes stored entries and records the clear', async () => {
    const app = await getApp();
    await prisma.adminUser.create({
      data: { username: 'logadmin', passwordHash: await hashPassword('admin-password-123') },
    });
    const session = await loginAdmin('logadmin', 'admin-password-123');

    await prisma.auditLog.createMany({
      data: [
        { actorType: 'SYSTEM', action: 'moderation.appeal_expired' },
        { actorType: 'SYSTEM', action: 'moderation.appeal_submitted' },
        { actorType: 'SYSTEM', action: 'admin.source_refresh' },
      ],
    });

    const cleared = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/audit-logs',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(cleared.statusCode).toBe(200);
    // Admin login writes its own audit entry, so the count is whatever exists at this point.
    expect(cleared.json().data.deleted).toBeGreaterThanOrEqual(3);

    const remaining = await prisma.auditLog.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.action).toBe('admin.audit_logs_cleared');
  });
});

describe('user search for mentions', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('matches usernames and display names', async () => {
    const app = await getApp();
    await createUser({ username: 'grace', displayName: 'Grace Hopper' });
    await createUser({ username: 'ada', displayName: 'Ada Lovelace' });

    const byUsername = await app.inject({ method: 'GET', url: '/api/v1/users/search?q=gra' });
    expect(byUsername.statusCode).toBe(200);
    expect(byUsername.json().data.map((user: { username: string }) => user.username)).toEqual([
      'grace',
    ]);

    const byName = await app.inject({ method: 'GET', url: '/api/v1/users/search?q=Lovelace' });
    expect(byName.json().data.map((user: { username: string }) => user.username)).toEqual(['ada']);
  });
});
