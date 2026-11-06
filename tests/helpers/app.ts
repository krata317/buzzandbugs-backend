import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createSession } from '../../src/modules/auth/session.js';
import { renderBugAvatar } from '../../src/modules/storage/avatar.js';
import { getStorage } from '../../src/modules/storage/index.js';
import { randomUUID } from 'node:crypto';

let appPromise: Promise<FastifyInstance> | null = null;

export const getApp = async (): Promise<FastifyInstance> => {
  appPromise ??= buildApp({ loggerEnabled: process.env.TEST_LOG === '1' });
  return appPromise;
};

export const closeApp = async (): Promise<void> => {
  if (appPromise) {
    const app = await appPromise;
    await app.close();
    appPromise = null;
  }
};

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  token: string;
}

export const createUser = async (options: {
  username: string;
  email?: string;
  password?: string;
  displayName?: string;
}): Promise<TestUser> => {
  const email = options.email ?? `${options.username}@example.com`;
  const password = options.password ?? 'correct-horse-battery';

  const avatarSvg = renderBugAvatar(options.username);
  const key = `avatars/generated/${randomUUID()}.svg`;
  await getStorage().put(key, Buffer.from(avatarSvg, 'utf8'), 'image/svg+xml');
  const file = await prisma.fileObject.create({
    data: {
      key,
      mimeType: 'image/svg+xml',
      sizeBytes: Buffer.byteLength(avatarSvg, 'utf8'),
      width: 512,
      height: 512,
      purpose: 'AVATAR',
    },
  });

  const user = await prisma.user.create({
    data: {
      email,
      emailNormalized: email.toLowerCase(),
      username: options.username,
      usernameLower: options.username.toLowerCase(),
      displayName: options.displayName ?? options.username,
      passwordHash: await hashPassword(password),
      avatarFileId: file.id,
      settings: { create: {} },
    },
  });

  await prisma.fileObject.update({ where: { id: file.id }, data: { ownerId: user.id } });

  const session = await createSession(user.id, { ip: '127.0.0.1', userAgent: 'vitest' });

  return { id: user.id, username: user.username, email, password, token: session.token };
};

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export const cookiesFrom = (response: LightMyRequestResponse): Record<string, string> => {
  const jar: Record<string, string> = {};
  for (const cookie of response.cookies ?? []) {
    jar[cookie.name] = cookie.value;
  }
  return jar;
};

export const cookieHeader = (jar: Record<string, string>): string =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

export const richDoc = (text: string): Record<string, unknown> => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

export const createPost = async (
  app: FastifyInstance,
  token: string,
  input: { title: string; text?: string; repostOfId?: string },
): Promise<{ id: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/posts',
    headers: bearer(token),
    payload: {
      title: input.title,
      content: input.text ? richDoc(input.text) : undefined,
      repostOfId: input.repostOfId,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Post creation failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().data as { id: string };
};

export const createReply = async (
  app: FastifyInstance,
  token: string,
  postId: string,
  text: string,
  parentId?: string,
): Promise<{ id: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/posts/${postId}/replies`,
    headers: bearer(token),
    payload: { content: richDoc(text), parentId },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Reply creation failed: ${response.statusCode} ${response.body}`);
  }
  return response.json().data as { id: string };
};

export const vote = async (
  app: FastifyInstance,
  token: string,
  postId: string,
  value: 1 | 0 | -1,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: `/api/v1/posts/${postId}/vote`,
    headers: bearer(token),
    payload: { value },
  });
