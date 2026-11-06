import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from './setup.js';
import { bearer, createUser, getApp } from './helpers/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('settings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns defaults for a new account', async () => {
    const user = await createUser({ username: 'defaults' });
    const app = await getApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: bearer(user.token),
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.displayMode).toBe('system');
    expect(data.accentColor).toBe('violet');
    expect(data.newsOrder).toEqual(['trending', 'ai', 'security', 'leaders', 'india']);
    expect(data.eventsOrder).toEqual(['hackathons', 'contests', 'ctf']);
    expect(data.notificationPrefs.account.email).toBe(true);
    expect(data.notificationPrefs.social.email).toBe(false);
  });

  it('persists preferences across sessions', async () => {
    const user = await createUser({ username: 'persisted' });
    const app = await getApp();

    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: {
        displayMode: 'dark',
        accentColor: 'teal',
        newsOrder: ['security', 'ai', 'trending', 'leaders', 'india'],
        eventsOrder: ['ctf', 'contests', 'hackathons'],
        trendingOrder: ['podcasts', 'papers', 'datasets', 'models', 'repositories', 'youtube'],
        notificationPrefs: { social: { email: true } },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.displayMode).toBe('dark');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'persisted', password: user.password },
    });
    const secondSession = login.headers['set-cookie'];
    expect(secondSession).toBeTruthy();

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: bearer(user.token),
    });
    expect(read.json().data.displayMode).toBe('dark');
    expect(read.json().data.accentColor).toBe('teal');
    expect(read.json().data.newsOrder[0]).toBe('security');
    expect(read.json().data.notificationPrefs.social.email).toBe(true);
    expect(read.json().data.notificationPrefs.social.onPlatform).toBe(true);
  });

  it('rejects invalid section orders', async () => {
    const user = await createUser({ username: 'invalidorder' });
    const app = await getApp();

    const duplicates = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: { newsOrder: ['trending', 'trending', 'ai', 'security', 'leaders'] },
    });
    expect(duplicates.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: { eventsOrder: ['hackathons'] },
    });
    expect(missing.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: { trendingOrder: ['youtube', 'nope', 'models', 'datasets', 'papers', 'podcasts'] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('uses the saved news order when listing sections', async () => {
    const user = await createUser({ username: 'ordered' });
    const app = await getApp();

    await prisma.externalItem.createMany({
      data: [
        {
          sourceKey: 'theverge',
          kind: 'NEWS',
          section: 'trending',
          externalId: 'theverge:1',
          title: 'Trending story',
          url: 'https://example.com/1',
          publishedAt: new Date(),
        },
        {
          sourceKey: 'bleepingcomputer',
          kind: 'NEWS',
          section: 'security',
          externalId: 'bleepingcomputer:1',
          title: 'Security story',
          url: 'https://example.com/2',
          publishedAt: new Date(),
        },
      ],
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: { newsOrder: ['security', 'ai', 'trending', 'leaders', 'india'] },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/news',
      headers: bearer(user.token),
    });

    const sections = response.json().data.sections as Array<{ section: string }>;
    expect(sections.map((entry) => entry.section)).toEqual(['security', 'trending']);
  });
});
