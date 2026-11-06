import Fastify from 'fastify';
import pino from 'pino';
import type { AppInstance } from './types.js';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { API_PREFIX, MAX_AVATAR_INPUT_BYTES } from './config/constants.js';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './lib/http.js';
import { registerAuth } from './plugins/auth.js';
import { registerAdminAuth } from './plugins/admin-auth.js';
import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { postRoutes } from './modules/posts/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { appealRoutes } from './modules/moderation/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { externalRoutes } from './modules/external/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { mediaRoutes } from './modules/storage/routes.js';
import { AppError } from './lib/errors.js';

export interface BuildAppOptions {
  loggerEnabled?: boolean;
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const buildApp = async (options: BuildAppOptions = {}): Promise<AppInstance> => {
  const appLogger = options.loggerEnabled === false ? pino({ level: 'silent' }) : logger;

  const app = Fastify({
    loggerInstance: appLogger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    ajv: { customOptions: { removeAdditional: false } },
  }) as unknown as AppInstance;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, env.WEB_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token'],
    maxAge: 600,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    allowList: [],
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () =>
      new AppError('RATE_LIMITED', 'Too many requests, please slow down', {
        retryAfterSeconds: 60,
      }),
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_AVATAR_INPUT_BYTES, files: 1 },
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Buzz and Bugs API',
        version: '1.0.0',
        description:
          'REST API for Buzz and Bugs, a developer community platform. All endpoints are versioned under /api/v1.',
      },
      servers: [{ url: env.APP_BASE_URL }],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bnb_session' },
          bearerToken: { type: 'http', scheme: 'bearer' },
          csrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
        },
      },
      tags: [
        { name: 'Authentication' },
        { name: 'Users' },
        { name: 'Social' },
        { name: 'Buzz' },
        { name: 'Moderation' },
        { name: 'News' },
        { name: 'Events' },
        { name: 'Trending' },
        { name: 'Notifications' },
        { name: 'Settings' },
        { name: 'Admin' },
        { name: 'Health' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  registerAuth(app);
  registerAdminAuth(app);
  registerErrorHandler(app);

  app.addHook('onRequest', async (request) => {
    if (!unsafeMethods.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    if (!env.WEB_ORIGINS.includes(origin)) {
      throw new AppError('FORBIDDEN', 'Origin is not allowed');
    }
  });

  await app.register(
    async (instance) => {
      await instance.register(authRoutes);
      await instance.register(userRoutes);
      await instance.register(postRoutes);
      await instance.register(notificationRoutes);
      await instance.register(settingsRoutes);
      await instance.register(appealRoutes);
      await instance.register(healthRoutes);
      await instance.register(externalRoutes);
      await instance.register(adminRoutes);
      await instance.register(mediaRoutes);
    },
    { prefix: API_PREFIX },
  );

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: false,
  });

  app.get('/', async () => ({
    name: 'Buzz and Bugs API',
    version: '1.0.0',
    documentation: '/docs',
    openapi: '/docs/json',
    api: API_PREFIX,
  }));

  return app;
};
