import type { FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
} from '../../config/constants.js';
import { randomToken } from '../../lib/crypto.js';

const maxAgeSeconds = SESSION_TTL_DAYS * 24 * 60 * 60;

export const setSessionCookies = (reply: FastifyReply, token: string): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  reply.setCookie(CSRF_COOKIE, randomToken(24), {
    httpOnly: false,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
};

export const clearSessionCookies = (reply: FastifyReply): void => {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
};

export const readCsrfCookie = (cookies: Record<string, string | undefined>): string | undefined =>
  cookies[CSRF_COOKIE];

export const CSRF_HEADER_NAME = CSRF_HEADER;
