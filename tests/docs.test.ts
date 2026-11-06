import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from './setup.js';
import { getApp } from './helpers/app.js';

describe('api surface', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('publishes an OpenAPI document for every module', async () => {
    const app = await getApp();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);

    const document = response.json() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(document.openapi).toMatch(/^3\./);

    const expectedPaths = [
      '/api/v1/auth/register/request-otp',
      '/api/v1/auth/login',
      '/api/v1/auth/sessions',
      '/api/v1/users/{username}',
      '/api/v1/feed',
      '/api/v1/posts',
      '/api/v1/posts/{id}/vote',
      '/api/v1/posts/{id}/replies',
      '/api/v1/posts/{id}/report',
      '/api/v1/appeals/{token}',
      '/api/v1/news',
      '/api/v1/events',
      '/api/v1/trending',
      '/api/v1/notifications',
      '/api/v1/settings',
      '/api/v1/admin/overview',
      '/api/v1/health',
    ];

    for (const path of expectedPaths) {
      expect(Object.keys(document.paths)).toContain(path);
    }

    expect(document.components.securitySchemes).toHaveProperty('sessionCookie');
    expect(document.components.securitySchemes).toHaveProperty('bearerToken');
  });

  it('serves the documentation UI', async () => {
    const app = await getApp();
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('returns a consistent error envelope for unknown routes', async () => {
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /api/v1/does-not-exist not found',
      },
    });
  });

  it('validates request bodies and reports field level errors', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: '', password: '' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('exposes liveness and readiness style health endpoints', async () => {
    const app = await getApp();

    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json().data.status).toBe('ok');

    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.database.status).toBe('up');
  });
});
