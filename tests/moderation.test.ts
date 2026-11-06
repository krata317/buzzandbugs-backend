import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, cookiesFrom, createPost, createUser, getApp, vote } from './helpers/app.js';
import {
  openAiModerationProvider,
  setModerationProviderForTests,
  type ModerationProvider,
} from '../src/modules/moderation/provider.js';
import {
  expireModerationAppeals,
  processModerationCase,
} from '../src/modules/moderation/service.js';
import { countActiveWarnings, issueWarning } from '../src/modules/moderation/penalties.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { extractTokenFromLink, lastMessageFor } from './helpers/mailbox.js';

const flaggedProvider: ModerationProvider = {
  name: 'test-flagged',
  isConfigured: () => true,
  check: async () => ({
    flagged: true,
    categories: { harassment: true },
    scores: { harassment: 0.97 },
  }),
};

const cleanProvider: ModerationProvider = {
  name: 'test-clean',
  isConfigured: () => true,
  check: async () => ({ flagged: false, categories: {}, scores: {} }),
};

const failingProvider: ModerationProvider = {
  name: 'test-failing',
  isConfigured: () => true,
  check: async () => {
    throw new Error('provider unavailable');
  },
};

const createAdmin = async (username = 'rootadmin', password = 'admin-password-123') => {
  await prisma.adminUser.create({
    data: { username, passwordHash: await hashPassword(password) },
  });
  return { username, password };
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

describe('moderation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    setModerationProviderForTests(openAiModerationProvider);
  });

  it('attaches multiple reports to one case and hides flagged content', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'flaggedauthor' });
    const reporterOne = await createUser({ username: 'reporter1' });
    const reporterTwo = await createUser({ username: 'reporter2' });

    const post = await createPost(app, author.token, { title: 'Reported', text: 'Bad content' });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporterOne.token),
      payload: { reason: 'HARASSMENT', details: 'Targeted abuse' },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporterTwo.token),
      payload: { reason: 'HARASSMENT' },
    });
    expect(second.statusCode).toBe(202);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporterOne.token),
      payload: { reason: 'SPAM' },
    });
    expect(duplicate.statusCode).toBe(409);

    const cases = await prisma.moderationCase.findMany({ where: { postId: post.id } });
    expect(cases.length).toBe(1);
    expect(cases[0]?.status).toBe('AWAITING_APPEAL');

    const reports = await prisma.report.findMany({ where: { postId: post.id } });
    expect(reports.length).toBe(2);
    expect(reports.every((report) => report.caseId === cases[0]?.id)).toBe(true);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('HIDDEN');

    const publicView = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(publicView.statusCode).toBe(404);

    const authorView = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${post.id}`,
      headers: bearer(author.token),
    });
    expect(authorView.statusCode).toBe(200);

    expect(lastMessageFor('reporter1@example.com')?.subject).toContain('report');
    const appealEmail = lastMessageFor('flaggedauthor@example.com');
    expect(appealEmail?.text).toContain('/appeals/');
  });

  it('leaves the post visible when the moderation provider fails', async () => {
    setModerationProviderForTests(failingProvider);
    const app = await getApp();
    const author = await createUser({ username: 'providerfail' });
    const reporter = await createUser({ username: 'reporterfail' });
    const post = await createPost(app, author.token, { title: 'Maybe bad', text: 'Body' });

    const report = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'OTHER' },
    });
    expect(report.statusCode).toBe(202);

    const moderationCase = await prisma.moderationCase.findFirst({ where: { postId: post.id } });
    expect(moderationCase?.status).toBe('PROVIDER_FAILED');
    expect(moderationCase?.lastError).toBeTruthy();

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('VISIBLE');

    const warnings = await prisma.warning.count({ where: { userId: author.id } });
    expect(warnings).toBe(0);

    // A later successful run resolves the case without duplicating side effects.
    setModerationProviderForTests(cleanProvider);
    await processModerationCase(moderationCase?.id ?? '');
    const resolved = await prisma.moderationCase.findUnique({ where: { id: moderationCase?.id } });
    expect(resolved?.status).toBe('RESOLVED_KEPT');
    expect(resolved?.flagged).toBe(false);
  });

  it('accepts one appeal per link and rejects reuse', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'appealer' });
    const reporter = await createUser({ username: 'appealreporter' });
    const post = await createPost(app, author.token, { title: 'Appealed', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'HARASSMENT' },
    });

    const token = extractTokenFromLink('appealer@example.com', '/appeals');

    const info = await app.inject({ method: 'GET', url: `/api/v1/appeals/${token}` });
    expect(info.statusCode).toBe(200);
    expect(info.json().data.canAppeal).toBe(true);

    const appeal = await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      payload: { message: 'This post was taken out of context, please review.' },
    });
    expect(appeal.statusCode).toBe(201);

    const reuse = await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      payload: { message: 'Trying again with the same link.' },
    });
    expect(reuse.statusCode).toBe(409);

    const stored = await prisma.moderationCase.findFirst({ where: { postId: post.id } });
    expect(stored?.status).toBe('APPEALED');
    expect(stored?.appealMessage).toContain('out of context');
  });

  it('rejects an expired appeal link', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'expiredappeal' });
    const reporter = await createUser({ username: 'expiredreporter' });
    const post = await createPost(app, author.token, { title: 'Expired', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'SPAM' },
    });

    const token = extractTokenFromLink('expiredappeal@example.com', '/appeals');
    await prisma.moderationCase.updateMany({
      where: { postId: post.id },
      data: { appealExpiresAt: new Date(Date.now() - 1000) },
    });

    const info = await app.inject({ method: 'GET', url: `/api/v1/appeals/${token}` });
    expect(info.json().data.canAppeal).toBe(false);

    const appeal = await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      payload: { message: 'Too late, but trying anyway.' },
    });
    expect(appeal.statusCode).toBe(400);
  });

  it('lets the admin accept an appeal and restore the post', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'restored' });
    const reporter = await createUser({ username: 'restorereporter' });
    const post = await createPost(app, author.token, { title: 'Restore me', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'OTHER' },
    });
    const token = extractTokenFromLink('restored@example.com', '/appeals');
    await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      payload: { message: 'Please look at this again, it is fine.' },
    });

    const admin = await createAdmin();
    const session = await loginAdmin(admin.username, admin.password);

    const moderationCase = await prisma.moderationCase.findFirst({ where: { postId: post.id } });
    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/moderation/cases/${moderationCase?.id}/decision`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { decision: 'accept', note: 'No violation found' },
    });
    expect(decision.statusCode).toBe(200);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('VISIBLE');

    const warnings = await prisma.warning.count({ where: { userId: author.id } });
    expect(warnings).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'moderation.appeal_accepted' },
    });
    expect(audit).toBeTruthy();
  });

  it('lets the admin reject an appeal, removing the post and issuing a warning', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'rejectedappeal' });
    const reporter = await createUser({ username: 'rejectreporter' });
    const post = await createPost(app, author.token, { title: 'Reject me', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'HATE_SPEECH' },
    });
    const token = extractTokenFromLink('rejectedappeal@example.com', '/appeals');
    await app.inject({
      method: 'POST',
      url: `/api/v1/appeals/${token}`,
      payload: { message: 'I disagree with this decision entirely.' },
    });

    const admin = await createAdmin();
    const session = await loginAdmin(admin.username, admin.password);
    const moderationCase = await prisma.moderationCase.findFirst({ where: { postId: post.id } });

    const decision = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/moderation/cases/${moderationCase?.id}/decision`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { decision: 'reject', note: 'Confirmed violation' },
    });
    expect(decision.statusCode).toBe(200);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('REMOVED');
    expect(stored?.content).toBeNull();

    const warnings = await prisma.warning.count({ where: { userId: author.id } });
    expect(warnings).toBe(1);
  });

  it('removes the post and warns the author when the appeal deadline passes', async () => {
    setModerationProviderForTests(flaggedProvider);
    const app = await getApp();
    const author = await createUser({ username: 'noappeal' });
    const reporter = await createUser({ username: 'noappealreporter' });
    const post = await createPost(app, author.token, { title: 'No appeal', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(reporter.token),
      payload: { reason: 'VIOLENCE' },
    });

    await prisma.moderationCase.updateMany({
      where: { postId: post.id },
      data: { appealExpiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await expireModerationAppeals();
    expect(expired).toBe(1);

    const stored = await prisma.post.findUnique({ where: { id: post.id } });
    expect(stored?.visibility).toBe('REMOVED');

    const warnings = await prisma.warning.count({ where: { userId: author.id } });
    expect(warnings).toBe(1);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'moderation.appeal_expired' },
    });
    expect(audit).toBeTruthy();
  });

  it('applies the warning progression and ban restrictions', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'repeat' });

    const first = await issueWarning({ userId: author.id, reason: 'first' });
    expect(first.activeWarnings).toBe(1);
    expect(first.ban).toBeNull();

    const second = await issueWarning({ userId: author.id, reason: 'second' });
    expect(second.activeWarnings).toBe(2);
    expect(second.ban?.permanent).toBe(false);
    const banMs = (second.ban?.endsAt?.getTime() ?? 0) - Date.now();
    expect(banMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(banMs).toBeLessThan(25 * 60 * 60 * 1000);

    const blockedPost = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Should fail',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
      },
    });
    expect(blockedPost.statusCode).toBe(403);

    const existingPost = await prisma.post.create({
      data: { authorId: author.id, title: 'Old post', excerpt: 'old', score: 0 },
    });

    const deleteOwn = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${existingPost.id}`,
      headers: bearer(author.token),
    });
    expect(deleteOwn.statusCode).toBe(200);

    for (let index = 0; index < 6; index += 1) {
      await issueWarning({ userId: author.id, reason: `extra ${index}` });
    }
    expect(await countActiveWarnings(author.id)).toBe(8);

    const permanent = await prisma.ban.findFirst({
      where: { userId: author.id, permanent: true, liftedAt: null },
    });
    expect(permanent).toBeTruthy();

    const stillReads = await app.inject({ method: 'GET', url: '/api/v1/feed' });
    expect(stillReads.statusCode).toBe(200);
  });

  it('ignores warnings older than 150 days', async () => {
    const author = await createUser({ username: 'expiredwarnings' });
    const warning = await prisma.warning.create({
      data: {
        userId: author.id,
        reason: 'old',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    expect(await countActiveWarnings(author.id)).toBe(0);

    const fresh = await issueWarning({ userId: author.id, reason: 'new' });
    expect(fresh.activeWarnings).toBe(1);
    expect(fresh.ban).toBeNull();

    const stored = await prisma.warning.findUnique({ where: { id: warning.id } });
    expect(stored).toBeTruthy();
  });

  it('rejects a report from the author and for a missing post', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'selfreport' });
    const post = await createPost(app, author.token, { title: 'Mine', text: 'Body' });

    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${post.id}/report`,
      headers: bearer(author.token),
      payload: { reason: 'SPAM' },
    });
    expect(self.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/does-not-exist/report',
      headers: bearer(author.token),
      payload: { reason: 'SPAM' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('prevents banned users from reacting', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'bannedvoter' });
    const other = await createUser({ username: 'targetauthor' });
    const post = await createPost(app, other.token, { title: 'Target', text: 'Body' });

    await issueWarning({ userId: author.id, reason: 'one' });
    await issueWarning({ userId: author.id, reason: 'two' });

    const reaction = await vote(app, author.token, post.id, 1);
    expect(reaction.statusCode).toBe(403);
  });
});
