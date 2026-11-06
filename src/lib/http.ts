import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from './errors.js';
import { env } from '../config/env.js';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const sendData = <T>(reply: FastifyReply, data: T, statusCode = 200): FastifyReply =>
  reply.code(statusCode).send({ data });

export const sendPage = <T>(
  reply: FastifyReply,
  data: T[],
  meta: Record<string, unknown>,
): FastifyReply => reply.code(200).send({ data, meta });

const zodDetails = (error: ZodError): Array<{ path: string; message: string }> =>
  error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'request failed');
      }
      if (error.retryAfterSeconds) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      reply.code(error.statusCode).send(body);
      return;
    }

    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: zodDetails(error),
        },
      } satisfies ApiErrorBody);
      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((entry) => {
        const issue = (entry.params as { issue?: { path?: unknown[]; message?: string } })?.issue;
        const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
        return {
          path: path || (entry.instancePath ? entry.instancePath.replace(/^\//, '') : '(root)'),
          message: issue?.message ?? entry.message ?? 'Invalid value',
        };
      });

      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
        },
      } satisfies ApiErrorBody);
      return;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        reply.code(409).send({
          error: { code: 'CONFLICT', message: 'Resource already exists' },
        } satisfies ApiErrorBody);
        return;
      }
      if (error.code === 'P2025') {
        reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
        } satisfies ApiErrorBody);
        return;
      }
    }

    const candidate = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'Request could not be processed';

    if (statusCode === 429) {
      reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
      } satisfies ApiErrorBody);
      return;
    }

    if (statusCode === 413) {
      reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      } satisfies ApiErrorBody);
      return;
    }

    if (statusCode < 500) {
      reply.code(statusCode).send({
        error: { code: 'BAD_REQUEST', message },
      } satisfies ApiErrorBody);
      return;
    }

    request.log.error({ err: error }, 'unhandled request error');
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        ...(env.isProduction ? {} : { details: message }),
      },
    } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    } satisfies ApiErrorBody);
  });
};
