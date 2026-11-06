import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from './setup.js';
import { bearer, createPost, createReply, createUser, getApp } from './helpers/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('notifications', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('notifies the author when someone replies', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'notified' });
    const replier = await createUser({ username: 'replieruser' });
    const post = await createPost(app, author.token, { title: 'Notify me', text: 'Body' });

    await createReply(app, replier.token, post.id, 'A reply');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: bearer(author.token),
    });
    expect(list.statusCode).toBe(200);

    const items = list.json().data as Array<{ type: string; title: string; read: boolean }>;
    expect(items.length).toBe(1);
    expect(items[0]?.type).toBe('reply');
    expect(items[0]?.read).toBe(false);

    const unread = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: bearer(author.token),
    });
    expect(unread.json().data.count).toBe(1);

    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${(items[0] as unknown as { id: string }).id}/read`,
      headers: bearer(author.token),
    });
    expect(read.statusCode).toBe(200);

    const afterRead = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: bearer(author.token),
    });
    expect(afterRead.json().data.count).toBe(0);
  });

  it('expires notifications after fourteen days', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'expiry' });
    const replier = await createUser({ username: 'expiryreplier' });
    const post = await createPost(app, author.token, { title: 'Expiry', text: 'Body' });
    await createReply(app, replier.token, post.id, 'Hello');

    const notification = await prisma.notification.findFirst({ where: { userId: author.id } });
    const days = ((notification?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('aggregates repeated reposts into a single notification', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'aggregated' });
    const first = await createUser({ username: 'reposterone' });
    const second = await createUser({ username: 'repostertwo' });

    const post = await createPost(app, author.token, { title: 'Popular', text: 'Body' });

    await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(first.token),
      payload: { title: 'Repost one', repostOfId: post.id },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(second.token),
      payload: { title: 'Repost two', repostOfId: post.id },
    });

    const notifications = await prisma.notification.findMany({
      where: { userId: author.id, type: 'repost' },
    });
    expect(notifications.length).toBe(1);
    expect((notifications[0]?.data as { count?: number })?.count).toBe(2);
  });

  it('respects notification preferences', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'optout' });
    const replier = await createUser({ username: 'optoutreplier' });

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(author.token),
      payload: { notificationPrefs: { social: { onPlatform: false } } },
    });

    const post = await createPost(app, author.token, { title: 'Quiet', text: 'Body' });
    await createReply(app, replier.token, post.id, 'Should not notify');

    const notifications = await prisma.notification.findMany({ where: { userId: author.id } });
    expect(notifications.length).toBe(0);
  });

  it('lets a user delete their own notifications', async () => {
    const app = await getApp();
    const author = await createUser({ username: 'deleter' });
    const replier = await createUser({ username: 'deleterreplier' });
    const post = await createPost(app, author.token, { title: 'Delete', text: 'Body' });
    await createReply(app, replier.token, post.id, 'Hello');

    const notification = await prisma.notification.findFirst({ where: { userId: author.id } });

    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/${notification?.id}`,
      headers: bearer(author.token),
    });
    expect(deletion.statusCode).toBe(200);

    const remaining = await prisma.notification.count({ where: { userId: author.id } });
    expect(remaining).toBe(0);

    const stranger = await createUser({ username: 'strangeruser' });
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/${notification?.id}`,
      headers: bearer(stranger.token),
    });
    expect(forbidden.statusCode).toBe(404);
  });
});
