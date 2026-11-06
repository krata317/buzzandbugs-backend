import type { NotificationCategory, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { addDays } from '../../lib/time.js';
import { NOTIFICATION_TTL_DAYS } from '../../config/constants.js';
import { queueEmail } from '../email/service.js';
import type { EmailParams, EmailTemplate } from '../email/templates.js';

export interface NotificationPrefs {
  social: { onPlatform: boolean; email: boolean };
  account: { onPlatform: boolean; email: boolean };
  community: { onPlatform: boolean; email: boolean };
  content: { onPlatform: boolean; email: boolean };
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  social: { onPlatform: true, email: false },
  account: { onPlatform: true, email: true },
  community: { onPlatform: false, email: false },
  content: { onPlatform: true, email: false },
};

const CATEGORY_KEY: Record<NotificationCategory, keyof NotificationPrefs> = {
  SOCIAL: 'social',
  ACCOUNT: 'account',
  COMMUNITY: 'community',
  CONTENT: 'content',
};

export const parseNotificationPrefs = (value: unknown): NotificationPrefs => {
  const input = (value ?? {}) as Partial<Record<keyof NotificationPrefs, unknown>>;
  const read = (key: keyof NotificationPrefs) => {
    const entry = input[key] as { onPlatform?: unknown; email?: unknown } | undefined;
    return {
      onPlatform:
        typeof entry?.onPlatform === 'boolean'
          ? entry.onPlatform
          : DEFAULT_NOTIFICATION_PREFS[key].onPlatform,
      email:
        typeof entry?.email === 'boolean' ? entry.email : DEFAULT_NOTIFICATION_PREFS[key].email,
    };
  };
  return {
    social: read('social'),
    account: read('account'),
    community: read('community'),
    content: read('content'),
  };
};

export interface CreateNotificationInput {
  userId: string;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  email?: { template: EmailTemplate; params: EmailParams };
  aggregateKey?: string;
}

const loadPrefs = async (userId: string): Promise<NotificationPrefs> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { notificationPrefs: true },
  });
  return parseNotificationPrefs(settings?.notificationPrefs);
};

export const createNotification = async (input: CreateNotificationInput): Promise<void> => {
  const prefs = await loadPrefs(input.userId);
  const categoryPrefs = prefs[CATEGORY_KEY[input.category]];
  const expiresAt = addDays(new Date(), NOTIFICATION_TTL_DAYS);

  if (categoryPrefs.onPlatform) {
    if (input.aggregateKey) {
      const existing = await prisma.notification.findFirst({
        where: {
          userId: input.userId,
          type: input.type,
          expiresAt: { gt: new Date() },
          data: { path: ['aggregateKey'], equals: input.aggregateKey },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        const data = (existing.data ?? {}) as Record<string, unknown>;
        const count = typeof data.count === 'number' ? data.count + 1 : 2;
        await prisma.notification.update({
          where: { id: existing.id },
          data: {
            title: input.title,
            body: input.body,
            readAt: null,
            createdAt: new Date(),
            expiresAt,
            data: { ...data, count } as Prisma.InputJsonValue,
          },
        });
      } else {
        await prisma.notification.create({
          data: {
            userId: input.userId,
            type: input.type,
            category: input.category,
            title: input.title,
            body: input.body,
            data: { ...(input.data as object), aggregateKey: input.aggregateKey, count: 1 },
            expiresAt,
          },
        });
      }
    } else {
      await prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          category: input.category,
          title: input.title,
          body: input.body,
          data: input.data,
          expiresAt,
        },
      });
    }
  }

  if (input.email && categoryPrefs.email) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    });
    if (user) {
      await queueEmail({
        to: user.email,
        template: input.email.template,
        params: input.email.params,
        userId: input.userId,
      });
    }
  }
};

export const cleanupExpiredNotifications = async (): Promise<number> => {
  const result = await prisma.notification.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
