import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { bearer, createUser, getApp } from './helpers/app.js';

const multipart = (file: Buffer, filename: string, contentType: string) => {
  const boundary = '----buzztestsboundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

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

  it('accepts a valid avatar and re-encodes it to WebP', async () => {
    const user = await createUser({ username: 'avatar' });
    const app = await getApp();

    const png = await sharp({
      create: { width: 900, height: 700, channels: 3, background: { r: 30, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const { body, contentType } = multipart(png, 'me.png', 'image/png');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: { ...bearer(user.token), 'content-type': contentType },
      payload: body,
    });

    expect(upload.statusCode).toBe(201);
    const avatarUrl = upload.json().data.avatarUrl as string;
    expect(avatarUrl).toBeTruthy();

    const fileId = avatarUrl.split('/').pop() ?? '';
    const file = await prisma.fileObject.findUnique({ where: { id: fileId } });
    expect(file?.mimeType).toBe('image/webp');
    expect(file?.width).toBe(512);
    expect(file?.height).toBe(512);

    const served = await app.inject({ method: 'GET', url: avatarUrl });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
  });

  it('rejects files that are not real images', async () => {
    const user = await createUser({ username: 'fakeimage' });
    const app = await getApp();

    const { body, contentType } = multipart(
      Buffer.from('this is definitely not an image'),
      'evil.png',
      'image/png',
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: { ...bearer(user.token), 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(415);
  });

  it('rejects images that are too large or too high resolution', async () => {
    const user = await createUser({ username: 'bigimage' });
    const app = await getApp();

    const tooBig = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(3 * 1024 * 1024, 1),
    ]);
    const bigUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: {
        ...bearer(user.token),
        'content-type': multipart(tooBig, 'big.png', 'image/png').contentType,
      },
      payload: multipart(tooBig, 'big.png', 'image/png').body,
    });
    expect(bigUpload.statusCode).toBe(413);

    const wide = await sharp({
      create: { width: 3000, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const widePart = multipart(wide, 'wide.png', 'image/png');
    const wideUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/avatar',
      headers: { ...bearer(user.token), 'content-type': widePart.contentType },
      payload: widePart.body,
    });
    expect(wideUpload.statusCode).toBe(422);
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
