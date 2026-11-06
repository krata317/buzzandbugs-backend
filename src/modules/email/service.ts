import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailStatus, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { enqueue, QUEUE } from '../../jobs/boss.js';
import { renderEmail, type EmailParams, type EmailTemplate } from './templates.js';

export interface SendEmailInput {
  to: string;
  template: EmailTemplate;
  params: EmailParams;
  userId?: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<void>;
}

let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (transporter) return transporter;

  if (env.EMAIL_TRANSPORT === 'json') {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return transporter;
  }

  if (!env.SMTP_HOST) {
    throw new Error('EMAIL_TRANSPORT=smtp requires SMTP_HOST');
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE_MODE === 'ssl',
    requireTLS: env.SMTP_SECURE_MODE === 'starttls',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transporter;
};

const fromAddress = (): string =>
  env.MAIL_FROM_NAME ? `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>` : env.MAIL_FROM_ADDRESS;

const recordDelivery = async (
  input: SendEmailInput,
  status: EmailStatus,
  error?: string,
  payload?: Prisma.InputJsonValue,
): Promise<string> => {
  const delivery = await prisma.emailDelivery.create({
    data: {
      toEmail: input.to,
      template: input.template,
      userId: input.userId ?? null,
      status,
      attempts: status === 'PENDING' ? 0 : 1,
      sentAt: status === 'SENT' ? new Date() : null,
      lastError: error ?? null,
      payload: payload ?? undefined,
    },
    select: { id: true },
  });
  return delivery.id;
};

/**
 * Sends a message immediately. Used for OTP and password-reset mail: the code must never be
 * written to the database or to the job queue, so it cannot be queued for later rendering.
 */
export const sendTransactionalEmail = async (input: SendEmailInput): Promise<void> => {
  const content = renderEmail(input.template, input.params);
  try {
    const info = await getTransporter().sendMail({
      from: fromAddress(),
      to: input.to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    const simulated = env.EMAIL_TRANSPORT === 'json';
    await recordDelivery(input, simulated ? 'SIMULATED' : 'SENT');
    if (simulated) {
      logger.info(
        { template: input.template, messageId: info.messageId },
        'email not delivered: EMAIL_TRANSPORT=json',
      );
    }
  } catch (error) {
    await recordDelivery(
      input,
      'FAILED',
      error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
    );
    logger.error({ err: error, template: input.template }, 'transactional email failed');
    throw serviceUnavailable('We could not send the email right now. Please try again shortly.');
  }
};

/** Queues a non-sensitive message for the worker to render and deliver. */
export const queueEmail = async (input: SendEmailInput): Promise<string> => {
  const payload: Prisma.InputJsonValue = {
    template: input.template,
    params: input.params as unknown as Prisma.InputJsonValue,
  };
  const deliveryId = await recordDelivery(input, 'PENDING', undefined, payload);

  try {
    await enqueue(QUEUE.emailSend, { deliveryId }, { singletonKey: `email:${deliveryId}` });
  } catch (error) {
    // The queue is unavailable (for example while the worker is not running). Deliver now
    // instead of dropping the message; failures are recorded on the delivery row.
    logger.warn({ err: error, deliveryId }, 'could not enqueue email, sending inline');
    try {
      await deliverQueuedEmail(deliveryId);
    } catch (deliveryError) {
      logger.error({ err: deliveryError, deliveryId }, 'inline email delivery failed');
    }
  }

  return deliveryId;
};

/** Called by the worker. Idempotent: already-sent deliveries are skipped. */
export const deliverQueuedEmail = async (deliveryId: string): Promise<void> => {
  const delivery = await prisma.emailDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) {
    logger.warn({ deliveryId }, 'email delivery record not found');
    return;
  }
  if (delivery.status === 'SENT' || delivery.status === 'SIMULATED') return;

  const payload = delivery.payload as { template?: EmailTemplate; params?: EmailParams } | null;
  if (!payload?.template) {
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', lastError: 'missing email payload' },
    });
    return;
  }

  const content = renderEmail(payload.template, payload.params ?? {});
  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: delivery.toEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    const simulated = env.EMAIL_TRANSPORT === 'json';
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: simulated ? 'SIMULATED' : 'SENT',
        attempts: { increment: 1 },
        sentAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', attempts: { increment: 1 }, lastError: message },
    });
    throw error;
  }
};

/** Test seam: replaces the transport factory. */
export const setTransporterForTests = (next: Transporter | null): void => {
  transporter = next;
};
