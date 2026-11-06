import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { ADMIN_SESSION_COOKIE } from '../config/constants.js';
import { randomToken } from '../lib/crypto.js';
import {
  resolveAdminSession,
  revokeAdminSession,
  createAdminSession,
} from '../modules/admin/session.js';
import { safeEqual } from '../lib/crypto.js';

export interface AdminAuthContext {
  admin: { id: string; username: string };
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminAuthContext | null;
  }
  interface FastifyInstance {
    authenticateAdmin: (request: FastifyRequest) => Promise<void>;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const registerAdminAuth = (app: FastifyInstance): void => {
  app.decorateRequest('admin', null);

  app.decorate('authenticateAdmin', async (request: FastifyRequest) => {
    const cookieToken = request.cookies?.[ADMIN_SESSION_COOKIE];
    const header = request.headers.authorization;
    const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
    const token = bearer || cookieToken;

    if (!token) throw new AppError('UNAUTHORIZED', 'Admin authentication required');

    const resolved = await resolveAdminSession(token);
    if (!resolved) throw new AppError('UNAUTHORIZED', 'Admin session expired');

    if (!bearer && UNSAFE_METHODS.has(request.method)) {
      const csrfCookie = request.cookies?.['bnb_admin_csrf'];
      const csrfHeader = request.headers['x-csrf-token'];
      const provided = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
      if (!csrfCookie || !provided || !safeEqual(csrfCookie, provided)) {
        throw new AppError('FORBIDDEN', 'Missing or invalid CSRF token');
      }
    }

    request.admin = { admin: resolved.admin, sessionId: resolved.session.id };
  });
};

export const setAdminCookies = (reply: import('fastify').FastifyReply, token: string): void => {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  reply.setCookie('bnb_admin_csrf', randomToken(24), {
    httpOnly: false,
    secure: env.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
};

export const clearAdminCookies = (reply: import('fastify').FastifyReply): void => {
  reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
  reply.clearCookie('bnb_admin_csrf', { path: '/' });
};

export const requireAdmin = (request: FastifyRequest): AdminAuthContext => {
  if (!request.admin) throw new AppError('UNAUTHORIZED', 'Admin authentication required');
  return request.admin;
};

export { createAdminSession, revokeAdminSession };
