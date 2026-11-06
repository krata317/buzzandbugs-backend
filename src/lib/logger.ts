import pino from 'pino';
import { env } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.otp',
  '*.code',
  '*.token',
  '*.tokenHash',
  '*.sessionToken',
  '*.resetToken',
  '*.apiKey',
  '*.SMTP_PASSWORD',
  '*.OPENAI_API_KEY',
];

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'buzz-and-bugs-api' },
  transport:
    env.isProduction || env.isTest
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
});

export type Logger = typeof logger;
