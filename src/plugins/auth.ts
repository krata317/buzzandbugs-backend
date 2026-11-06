import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Session, User } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { resolveSession } from '../modules/auth/session.js';
import { readCsrfCookie, CSRF_HEADER_NAME } from '../modules/auth/cookies.js';
import { SESSION_COOKIE } from '../config/constants.js';
import { safeEqual } from '../lib/crypto.js';

export interface AuthContext {
  user: User;
  session: Session;
  via: 'cookie' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const extractToken = (
  request: FastifyRequest,
): { token: string; via: 'cookie' | 'bearer' } | null => {
  const header = request.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token) return { token, via: 'bearer' };
  }
  const cookieToken = request.cookies?.[SESSION_COOKIE];
  if (cookieToken) return { token: cookieToken, via: 'cookie' };
  return null;
};

const assertCsrf = (request: FastifyRequest): void => {
  if (!UNSAFE_METHODS.has(request.method)) return;
  const cookieToken = readCsrfCookie(request.cookies ?? {});
  const headerToken = request.headers[CSRF_HEADER_NAME];
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (!cookieToken || !provided || !safeEqual(cookieToken, provided)) {
    throw new AppError('FORBIDDEN', 'Missing or invalid CSRF token');
  }
};

export const registerAuth = (app: FastifyInstance): void => {
  app.decorateRequest('auth', null);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const extracted = extractToken(request);
    if (!extracted) {
      throw new AppError('UNAUTHORIZED', 'Authentication required');
    }

    const resolved = await resolveSession(extracted.token);
    if (!resolved) {
      throw new AppError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }

    if (extracted.via === 'cookie') {
      assertCsrf(request);
    }

    request.auth = { user: resolved.user, session: resolved.session, via: extracted.via };
  });

  app.decorate('optionalAuthenticate', async (request: FastifyRequest) => {
    const extracted = extractToken(request);
    if (!extracted) return;
    const resolved = await resolveSession(extracted.token);
    if (!resolved) return;
    if (extracted.via === 'cookie' && UNSAFE_METHODS.has(request.method)) {
      try {
        assertCsrf(request);
      } catch {
        return;
      }
    }
    request.auth = { user: resolved.user, session: resolved.session, via: extracted.via };
  });
};

export const requireUser = (request: FastifyRequest): AuthContext => {
  if (!request.auth) throw new AppError('UNAUTHORIZED', 'Authentication required');
  return request.auth;
};
