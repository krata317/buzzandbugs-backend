import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  EMAIL_HASH_SECRET: z.string().min(32, 'EMAIL_HASH_SECRET must be at least 32 characters'),

  EMAIL_TRANSPORT: z.enum(['smtp', 'json']).default('json'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE_MODE: z.enum(['starttls', 'ssl', 'none']).default('starttls'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().default('no-reply@example.com'),
  MAIL_FROM_NAME: z.string().default('Buzz and Bugs'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  YOUTUBE_API_KEY: z.string().optional(),

  LINK_PREVIEW_API_URL: z.string().optional(),
  LINK_PREVIEW_API_KEY: z.string().optional(),
  LINK_PREVIEW_DAILY_LIMIT: z.coerce.number().int().positive().default(100),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_DIR: z.string().default('./var/uploads'),

  ADMIN_BOOTSTRAP_USERNAME: z.string().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),

  COOKIE_SECURE: booleanish,

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map(
    (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
  );
  // Deliberately written to stderr instead of the logger: the logger depends on validated config.
  process.stderr.write(`Invalid environment configuration:\n${issues.join('\n')}\n`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  cookieSecure: raw.COOKIE_SECURE || raw.NODE_ENV === 'production',
  smtpConfigured: raw.EMAIL_TRANSPORT === 'smtp' && Boolean(raw.SMTP_HOST),
  moderationConfigured: Boolean(raw.OPENAI_API_KEY),
  linkPreviewConfigured: Boolean(raw.LINK_PREVIEW_API_KEY),
  youtubeConfigured: Boolean(raw.YOUTUBE_API_KEY),
} as const;

export type Env = typeof env;
