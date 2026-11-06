import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, cookiesFrom, createUser, getApp } from './helpers/app.js';
import { extractOtp, lastMessageFor, messagesFor } from './helpers/mailbox.js';

const PASSWORD = 'correct-horse-battery';

const registerUser = async (username: string, email: string, password = PASSWORD) => {
  const app = await getApp();

  const requestOtp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register/request-otp',
    payload: { email },
  });
  expect(requestOtp.statusCode).toBe(202);

  const code = extractOtp(email);
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register/verify-otp',
    payload: { email, code },
  });
  expect(verify.statusCode).toBe(200);
  const registrationToken = verify.json().data.registrationToken as string;

  const complete = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register/complete',
    payload: { registrationToken, username, displayName: username, password },
  });

  return complete;
};

describe('authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('registers a user through the OTP flow and issues a session', async () => {
    const complete = await registerUser('ada', 'ada@example.com');
    expect(complete.statusCode).toBe(201);

    const body = complete.json().data;
    expect(body.user.username).toBe('ada');
    expect(body.user.email).toBe('ada@example.com');

    const cookies = cookiesFrom(complete);
    expect(cookies.bnb_session).toBeTruthy();
    expect(cookies.bnb_csrf).toBeTruthy();

    const stored = await prisma.user.findUnique({ where: { usernameLower: 'ada' } });
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.passwordHash).not.toContain(PASSWORD);

    const welcome = messagesFor('ada@example.com').find((message) =>
      message.subject.includes('Welcome'),
    );
    expect(welcome).toBeDefined();
  });

  it('rejects an expired OTP', async () => {
    const app = await getApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'late@example.com' },
    });

    const code = extractOtp('late@example.com');
    await prisma.emailOtp.updateMany({
      where: { emailNormalized: 'late@example.com' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/verify-otp',
      payload: { email: 'late@example.com', code },
    });
    expect(verify.statusCode).toBe(400);
  });

  it('invalidates the previous OTP when a new one is requested', async () => {
    const app = await getApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'resend@example.com' },
    });
    const firstCode = extractOtp('resend@example.com');

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'resend@example.com' },
    });
    const secondCode = extractOtp('resend@example.com');
    expect(secondCode).not.toBe(firstCode);

    const withOldCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/verify-otp',
      payload: { email: 'resend@example.com', code: firstCode },
    });
    expect(withOldCode.statusCode).toBe(400);

    const withNewCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/verify-otp',
      payload: { email: 'resend@example.com', code: secondCode },
    });
    expect(withNewCode.statusCode).toBe(200);
  });

  it('does not reveal whether an email is already registered', async () => {
    await createUser({ username: 'taken', email: 'taken@example.com' });
    const app = await getApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'taken@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(lastMessageFor('taken@example.com')).toBeUndefined();
  });

  it('rejects a duplicate username', async () => {
    await createUser({ username: 'grace', email: 'grace@example.com' });
    const app = await getApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'new@example.com' },
    });
    const code = extractOtp('new@example.com');
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/verify-otp',
      payload: { email: 'new@example.com', code },
    });
    const registrationToken = verify.json().data.registrationToken as string;

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/complete',
      payload: {
        registrationToken,
        username: 'GRACE',
        displayName: 'Grace',
        password: PASSWORD,
      },
    });

    expect(complete.statusCode).toBe(409);
  });

  it('logs in with a username or an email', async () => {
    const user = await createUser({ username: 'linus', email: 'linus@example.com' });
    const app = await getApp();

    const byUsername = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'linus', password: user.password },
    });
    expect(byUsername.statusCode).toBe(200);

    const byEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'LINUS@example.com', password: user.password },
    });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json().data.user.id).toBe(user.id);
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    await createUser({ username: 'ken', email: 'ken@example.com' });
    const app = await getApp();

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'ken', password: 'not-the-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'nobody', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
  });

  it('locks repeated failed logins from the same address', async () => {
    await createUser({ username: 'barbara', email: 'barbara@example.com' });
    const app = await getApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'barbara', password: 'wrong-password' },
        remoteAddress: '203.0.113.10',
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'barbara', password: 'wrong-password' },
      remoteAddress: '203.0.113.10',
    });
    expect(locked.statusCode).toBe(429);

    const fromAnotherAddress = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'barbara', password: 'correct-horse-battery' },
      remoteAddress: '198.51.100.7',
    });
    expect(fromAnotherAddress.statusCode).toBe(200);
  });

  it('revokes a session on logout', async () => {
    const user = await createUser({ username: 'logout', email: 'logout@example.com' });
    const app = await getApp();

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: bearer(user.token),
    });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(after.statusCode).toBe(401);
  });

  it('lists and revokes sessions', async () => {
    const user = await createUser({ username: 'sessions', email: 'sessions@example.com' });
    const app = await getApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'sessions', password: user.password },
    });
    expect(login.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: bearer(user.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBeGreaterThanOrEqual(2);

    const current = (list.json().data as Array<{ id: string; current: boolean }>).find(
      (entry) => entry.current,
    );
    expect(current).toBeDefined();

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${current?.id}`,
      headers: bearer(user.token),
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('requires explicit confirmation before changing a password and revokes every session', async () => {
    const user = await createUser({ username: 'change', email: 'change@example.com' });
    const app = await getApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'change', password: user.password },
    });

    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: bearer(user.token),
      payload: {
        currentPassword: user.password,
        newPassword: 'brand-new-password',
        confirmSessionRevocation: false,
      },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.details.activeSessions).toBeGreaterThanOrEqual(2);

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: bearer(user.token),
      payload: {
        currentPassword: user.password,
        newPassword: 'brand-new-password',
        confirmSessionRevocation: true,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.revokedSessions).toBeGreaterThanOrEqual(2);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(oldSession.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'change', password: 'brand-new-password' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('resets a password with an OTP and a single-use token', async () => {
    const user = await createUser({ username: 'reset', email: 'reset@example.com' });
    const app = await getApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      payload: { email: 'reset@example.com' },
    });
    const code = extractOtp('reset@example.com');

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/verify',
      payload: { email: 'reset@example.com', code },
    });
    expect(verify.statusCode).toBe(200);
    const resetToken = verify.json().data.resetToken as string;

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/complete',
      payload: { resetToken, newPassword: 'another-new-password' },
    });
    expect(complete.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/complete',
      payload: { resetToken, newPassword: 'yet-another-password' },
    });
    expect(reuse.statusCode).toBe(400);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(oldSession.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'reset', password: 'another-new-password' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('enforces CSRF protection for cookie-authenticated writes', async () => {
    const user = await createUser({ username: 'csrf', email: 'csrf@example.com' });
    const app = await getApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'csrf', password: user.password },
    });
    const jar = cookiesFrom(login);
    const cookie = Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    const withoutToken = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { cookie },
      payload: { title: 'Hello', content: { type: 'doc', content: [] } },
    });
    expect(withoutToken.statusCode).toBe(403);

    const withToken = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { cookie, 'x-csrf-token': jar.bnb_csrf ?? '' },
      payload: {
        title: 'Hello',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
        },
      },
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('rejects requests from an origin outside the allowlist', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { identifier: 'nobody', password: 'whatever' },
    });
    expect(response.statusCode).toBe(403);
  });
});
