import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, cookiesFrom, createPost, createUser, getApp } from './helpers/app.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { writeHeartbeat } from '../src/jobs/worker.js';

const ADMIN_USERNAME = 'operator';
const ADMIN_PASSWORD = 'admin-password-123';

const bootstrapAdmin = async (): Promise<void> => {
  await prisma.adminUser.create({
    data: { username: ADMIN_USERNAME, passwordHash: await hashPassword(ADMIN_PASSWORD) },
  });
};

const loginAdmin = async (password = ADMIN_PASSWORD) => {
  const app = await getApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { username: ADMIN_USERNAME, password },
  });
  const jar = cookiesFrom(response);
  return {
    response,
    cookie: Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
    csrf: jar.bnb_admin_csrf ?? '',
  };
};

describe('admin', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an admin identity outside the users table with an argon2id hash', async () => {
    await bootstrapAdmin();

    const admin = await prisma.adminUser.findUnique({ where: { username: ADMIN_USERNAME } });
    expect(admin).toBeTruthy();
    expect(admin?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(admin?.passwordHash ?? '', ADMIN_PASSWORD)).toBe(true);

    const inUsers = await prisma.user.findFirst({ where: { usernameLower: ADMIN_USERNAME } });
    expect(inUsers).toBeNull();

    const email = (admin as unknown as { email?: string }).email;
    expect(email).toBeUndefined();
  });

  it('signs in with valid credentials and rejects invalid ones', async () => {
    await bootstrapAdmin();

    const invalid = await loginAdmin('wrong-password');
    expect(invalid.response.statusCode).toBe(401);

    const valid = await loginAdmin();
    expect(valid.response.statusCode).toBe(200);
    expect(valid.response.json().data.admin.username).toBe(ADMIN_USERNAME);
    expect(valid.cookie).toContain('bnb_admin_session');

    const session = await prisma.adminSession.count();
    expect(session).toBe(1);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.login' } });
    expect(audit).toBeTruthy();
  });

  it('refuses admin routes to ordinary users and unauthenticated callers', async () => {
    await bootstrapAdmin();
    const user = await createUser({ username: 'normaluser' });
    const app = await getApp();

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    expect(anonymous.statusCode).toBe(401);

    const ordinary = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: bearer(user.token),
    });
    expect(ordinary.statusCode).toBe(401);
  });

  it('requires a CSRF token for cookie-authenticated admin writes', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const withoutCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/moderation/cases/whatever/decision',
      headers: { cookie: session.cookie },
      payload: { decision: 'accept' },
    });
    expect(withoutCsrf.statusCode).toBe(403);
  });

  it('exposes overview statistics', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const author = await createUser({ username: 'statsauthor' });
    await createPost(app, author.token, { title: 'One', text: 'Body' });
    await createPost(app, author.token, { title: 'Two', text: 'Body' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.users).toBe(1);
    expect(data.posts).toBe(2);
    expect(data.openCases).toBe(0);
  });

  it('looks up users without exposing password hashes and audits the access', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const user = await createUser({ username: 'searchable', email: 'searchable@example.com' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?query=searchable',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);

    const results = response.json().data;
    expect(results.length).toBe(1);
    expect(results[0].email).toBe('searchable@example.com');
    expect(JSON.stringify(results)).not.toContain('passwordHash');
    expect(JSON.stringify(results)).not.toContain('$argon2');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${user.id}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.stats.posts).toBe(0);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.user_search' } });
    expect(audit).toBeTruthy();
    expect(audit?.actorType).toBe('ADMIN');
  });

  it('reports source health for every configured adapter', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sources',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    const sources = response.json().data as Array<{ key: string; healthy: boolean }>;
    expect(sources.length).toBeGreaterThan(15);
    expect(sources.some((source) => source.key === 'theverge')).toBe(true);
    expect(sources.some((source) => source.key === 'ctftime')).toBe(true);
    expect(sources.every((source) => typeof source.healthy === 'boolean')).toBe(true);
  });

  it('reports API, database and worker health', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const withoutWorker = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { cookie: session.cookie },
    });
    expect(withoutWorker.statusCode).toBe(200);
    expect(withoutWorker.json().data.database.status).toBe('up');
    expect(withoutWorker.json().data.worker.status).toBe('down');

    await writeHeartbeat();

    const withWorker = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { cookie: session.cookie },
    });
    expect(withWorker.json().data.worker.status).toBe('up');

    const publicHealth = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(publicHealth.statusCode).toBe(200);
    expect(publicHealth.json().data.database.status).toBe('up');
  });

  it('returns background job status', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().data.queues)).toBe(true);
    expect(Array.isArray(response.json().data.recentFailures)).toBe(true);
  });

  it('does not expose an admin password change route', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/password',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { oldPassword: ADMIN_PASSWORD, newPassword: 'something-else-123' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns paginated audit logs', async () => {
    await bootstrapAdmin();
    const app = await getApp();
    const session = await loginAdmin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?limit=10',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.length).toBeGreaterThanOrEqual(1);
    expect(response.json().meta.limit).toBe(10);
  });
});
