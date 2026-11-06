import { defineConfig } from 'vitest/config';

const baseUrl = process.env.DATABASE_URL ?? 'postgresql://bnb:bnbtest123@localhost:5432/bnb?schema=public';

const derived = new URL(baseUrl);
derived.pathname = '/bnb_test';
const configuredTestUrl = process.env.TEST_DATABASE_URL?.trim();
const testDatabaseUrl =
  configuredTestUrl && configuredTestUrl.length > 0 ? configuredTestUrl : derived.toString();

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
      EMAIL_HASH_SECRET: 'test-email-hash-secret-0123456789abcdef',
      EMAIL_TRANSPORT: 'json',
      MAIL_FROM_ADDRESS: 'no-reply@test.local',
      MAIL_FROM_NAME: 'Buzz and Bugs',
      APP_BASE_URL: 'http://localhost:4000',
      WEB_ORIGINS: 'http://localhost:3000',
      STORAGE_DIR: './var/test-uploads',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000',
    },
  },
});
