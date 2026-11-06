import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, cookiesFrom, createPost, createUser, getApp } from './helpers/app.js';
import { purgeDeletedAccounts } from '../src/modules/auth/service.js';
import { issueWarning } from '../src/modules/moderation/penalties.js';
import { extractOtp } from './helpers/mailbox.js';
import { hashEmail } from '../src/lib/crypto.js';

let ipCounter = 0;
const nextIp = (): string => {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

const confirmDeletion = async (token: string, password: string) => {
  const app = await getApp();
  const request = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/account-deletion/request',
    headers: bearer(token),
    payload: { password },
    remoteAddress: nextIp(),
  });
  expect(request.statusCode).toBe(202);

  const code = extractOtp(
    (await prisma.user.findUnique({ where: { usernameLower: 'deleteme' } }))?.email ?? '',
  );

  const confirm = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/account-deletion/confirm',
    headers: bearer(token),
    payload: { code },
  });
  return confirm;
};

describe('account deletion', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('requires the correct password before sending a deletion code', async () => {
    const app = await getApp();
    const user = await createUser({ username: 'deleteme' });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account-deletion/request',
      headers: bearer(user.token),
      payload: { password: 'wrong-password' },
      remoteAddress: nextIp(),
    });
    expect(wrong.statusCode).toBe(401);

    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account-deletion/request',
      headers: bearer(user.token),
      payload: { password: user.password },
      remoteAddress: nextIp(),
    });
    expect(request.statusCode).toBe(202);
  });

  it('schedules deletion seven days ahead and revokes every session', async () => {
    const user = await createUser({ username: 'deleteme' });
    const confirm = await confirmDeletion(user.token, user.password);
    expect(confirm.statusCode).toBe(200);

    const scheduledFor = new Date(confirm.json().data.scheduledFor as string);
    const days = (scheduledFor.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const sessions = await prisma.session.count({ where: { userId: user.id } });
    expect(sessions).toBe(0);

    const app = await getApp();
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: bearer(user.token),
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('lets the user sign in during the recovery period and cancel', async () => {
    const user = await createUser({ username: 'deleteme' });
    await confirmDeletion(user.token, user.password);

    const app = await getApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'deleteme', password: user.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.pendingDeletion).toBe(true);

    const jar = cookiesFrom(login);
    const cancel = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account-deletion/cancel',
      headers: bearer(jar.bnb_session ?? ''),
    });
    expect(cancel.statusCode).toBe(200);

    const request = await prisma.accountDeletionRequest.findUnique({ where: { userId: user.id } });
    expect(request?.cancelledAt).toBeTruthy();

    await purgeDeletedAccounts();
    const stillThere = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stillThere).toBeTruthy();
  });

  it('anonymises content and releases the username after the recovery period', async () => {
    const user = await createUser({ username: 'deleteme', displayName: 'Soon Gone' });
    const app = await getApp();
    const post = await createPost(app, user.token, { title: 'Keep this', text: 'Public content' });

    await confirmDeletion(user.token, user.password);
    await prisma.accountDeletionRequest.updateMany({
      where: { userId: user.id },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });

    const purged = await purgeDeletedAccounts();
    expect(purged).toBe(1);

    const deletedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(deletedUser).toBeNull();

    const storedPost = await prisma.post.findUnique({ where: { id: post.id } });
    expect(storedPost?.authorId).toBeNull();
    expect(storedPost?.authorDeleted).toBe(true);
    expect(storedPost?.title).toBe('Keep this');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.author.displayName).toBe('Squashed Bug');
    expect(detail.json().data.author.id).toBeNull();
    expect(detail.json().data.author.deleted).toBe(true);
    expect(detail.json().data.author.username).toBeNull();

    const reuse = await prisma.user.create({
      data: {
        email: 'new@example.com',
        emailNormalized: 'new@example.com',
        username: 'deleteme',
        usernameLower: 'deleteme',
        displayName: 'New Owner',
        passwordHash: 'irrelevant',
      },
    });
    expect(reuse.username).toBe('deleteme');
  });

  it('restricts the email address when an account is deleted during a ban', async () => {
    const user = await createUser({ username: 'deleteme', email: 'banned@example.com' });
    await issueWarning({ userId: user.id, reason: 'one' });
    await issueWarning({ userId: user.id, reason: 'two' });

    await confirmDeletion(user.token, user.password);
    await prisma.accountDeletionRequest.updateMany({
      where: { userId: user.id },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });

    await purgeDeletedAccounts();

    const restriction = await prisma.emailRestriction.findUnique({
      where: { emailHash: hashEmail('banned@example.com') },
    });
    expect(restriction).toBeTruthy();
    expect(restriction?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const app = await getApp();
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'banned@example.com' },
      remoteAddress: nextIp(),
    });
    expect(register.statusCode).toBe(403);

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/request-otp',
      payload: { email: 'someone-else@example.com' },
      remoteAddress: nextIp(),
    });
    expect(other.statusCode).toBe(202);
  });
});
