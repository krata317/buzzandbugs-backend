import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, createUser, getApp } from './helpers/app.js';

describe('users and profiles', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates a profile with a generated avatar and default settings', async () => {
    const user = await createUser({ username: 'profile', displayName: 'Profile Person' });
    const app = await getApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/users/profile' });
    expect(response.statusCode).toBe(200);

    const body = response.json().data;
    expect(body.displayName).toBe('Profile Person');
    expect(body.avatarUrl).toMatch(/^\/api\/v1\/media\/avatars\//);
    expect(body.stats.posts).toBe(0);

    const settings = await prisma.userSettings.findUnique({ where: { userId: user.id } });
    expect(settings?.displayMode).toBe('system');
  });

  it('updates the display name, about and social links', async () => {
    const user = await createUser({ username: 'editable' });
    const app = await getApp();

    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(user.token),
      payload: {
        displayName: 'New Display Name',
        about: 'Backend developer',
        socialLinks: { github: 'https://github.com/example', website: 'https://example.com' },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.displayName).toBe('New Display Name');
    expect(update.json().data.socialLinks.github).toBe('https://github.com/example');

    const invalidLink = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(user.token),
      payload: { socialLinks: { github: 'javascript:alert(1)' } },
    });
    expect(invalidLink.statusCode).toBe(400);
  });

  it('does not allow the username to change', async () => {
    const user = await createUser({ username: 'immutable' });
    const app = await getApp();

    const attempt = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(user.token),
      payload: { username: 'renamed', displayName: 'Renamed' },
    });
    expect(attempt.statusCode).toBe(200);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored?.username).toBe('immutable');
    expect(stored?.usernameLower).toBe('immutable');
  });

  it('honours profile visibility preferences', async () => {
    const user = await createUser({ username: 'private' });
    const app = await getApp();

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(user.token),
      payload: { about: 'Secret bio' },
    });

    const hide = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: bearer(user.token),
      payload: { profileVisibility: { about: false, socialLinks: false, followers: false } },
    });
    expect(hide.statusCode).toBe(200);

    const profile = await app.inject({ method: 'GET', url: '/api/v1/users/private' });
    expect(profile.json().data.about).toBeNull();
    expect(profile.json().data.stats.followers).toBeNull();
  });

  it('represents deleted accounts with a generic profile', async () => {
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/users/deleted' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      deleted: true,
      displayName: 'Squashed Bug',
      profileUrl: '/users/deleted',
    });
  });

  it('no longer accepts uploaded profile pictures', async () => {
    const user = await createUser({ username: 'noavatarupload' });
    const app = await getApp();

    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: { ...bearer(user.token), 'content-type': 'application/json' },
      payload: {},
    });

    expect(upload.statusCode).toBe(404);
  });

  it('returns nested reply trees and hides blocked authors', async () => {
    const author = await createUser({ username: 'treeauthor' });
    const blocked = await createUser({ username: 'treeblocked' });
    const app = await getApp();

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: bearer(author.token),
      payload: {
        title: 'Tree',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
      },
    });
    const postId = post.json().data.id as string;

    await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/replies`,
      headers: bearer(blocked.token),
      payload: {
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hidden reply' }] }],
        },
      },
    });

    const before = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}/replies` });
    expect(before.json().data.length).toBe(1);

    await app.inject({
      method: 'POST',
      url: '/api/v1/users/treeblocked/block',
      headers: bearer(author.token),
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/replies`,
      headers: bearer(author.token),
    });
    expect(after.json().data.length).toBe(0);
  });
});
