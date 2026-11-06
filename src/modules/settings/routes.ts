import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sendData } from '../../lib/http.js';
import { requireUser } from '../../plugins/auth.js';
import { parseNotificationPrefs, DEFAULT_NOTIFICATION_PREFS } from '../notifications/service.js';
import { parseProfileVisibility } from '../users/serialize.js';
import { EVENT_SECTIONS, NEWS_SECTIONS, TRENDING_SECTIONS } from '../../config/constants.js';

const permutation = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .refine((items) => new Set(items).size === items.length, 'Sections must be unique')
    .refine(
      (items) => items.length === values.length,
      `All ${values.length} sections must be present`,
    );

const displayModeSchema = z.enum(['light', 'dark', 'system']);
const accentColorSchema = z.enum(['violet', 'blue', 'green', 'amber', 'rose', 'teal', 'slate']);

const notificationPrefsSchema = z.object({
  social: z.object({ onPlatform: z.boolean(), email: z.boolean() }).partial().optional(),
  account: z.object({ onPlatform: z.boolean(), email: z.boolean() }).partial().optional(),
  community: z.object({ onPlatform: z.boolean(), email: z.boolean() }).partial().optional(),
  content: z.object({ onPlatform: z.boolean(), email: z.boolean() }).partial().optional(),
});

const settingsSelect = {
  displayMode: true,
  accentColor: true,
  newsOrder: true,
  eventsOrder: true,
  trendingOrder: true,
  profileVisibility: true,
  notificationPrefs: true,
} as const;

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/settings',
    {
      preHandler: app.authenticate,
      schema: { tags: ['Settings'], summary: 'Read your settings' },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const settings =
        (await prisma.userSettings.findUnique({
          where: { userId: auth.user.id },
          select: settingsSelect,
        })) ?? null;

      return sendData(reply, {
        displayMode: settings?.displayMode ?? 'system',
        accentColor: settings?.accentColor ?? 'violet',
        newsOrder: settings?.newsOrder ?? [...NEWS_SECTIONS],
        eventsOrder: settings?.eventsOrder ?? [...EVENT_SECTIONS],
        trendingOrder: settings?.trendingOrder ?? [...TRENDING_SECTIONS],
        profileVisibility: parseProfileVisibility(settings?.profileVisibility),
        notificationPrefs: parseNotificationPrefs(
          settings?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS,
        ),
      });
    },
  );

  app.patch(
    '/settings',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Settings'],
        summary: 'Update settings',
        body: z.object({
          displayMode: displayModeSchema.optional(),
          accentColor: accentColorSchema.optional(),
          newsOrder: permutation(NEWS_SECTIONS).optional(),
          eventsOrder: permutation(EVENT_SECTIONS).optional(),
          trendingOrder: permutation(TRENDING_SECTIONS).optional(),
          profileVisibility: z
            .object({
              about: z.boolean().optional(),
              socialLinks: z.boolean().optional(),
              followers: z.boolean().optional(),
              following: z.boolean().optional(),
            })
            .optional(),
          notificationPrefs: notificationPrefsSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const current = await prisma.userSettings.findUnique({
        where: { userId: auth.user.id },
        select: settingsSelect,
      });

      const mergedVisibility = {
        ...parseProfileVisibility(current?.profileVisibility),
        ...(request.body.profileVisibility ?? {}),
      };

      const currentPrefs = parseNotificationPrefs(
        current?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS,
      );
      const mergedPrefs = request.body.notificationPrefs
        ? {
            social: { ...currentPrefs.social, ...request.body.notificationPrefs.social },
            account: { ...currentPrefs.account, ...request.body.notificationPrefs.account },
            community: { ...currentPrefs.community, ...request.body.notificationPrefs.community },
            content: { ...currentPrefs.content, ...request.body.notificationPrefs.content },
          }
        : currentPrefs;

      const updated = await prisma.userSettings.upsert({
        where: { userId: auth.user.id },
        create: {
          userId: auth.user.id,
          displayMode: request.body.displayMode ?? 'system',
          accentColor: request.body.accentColor ?? 'violet',
          newsOrder: request.body.newsOrder ?? [...NEWS_SECTIONS],
          eventsOrder: request.body.eventsOrder ?? [...EVENT_SECTIONS],
          trendingOrder: request.body.trendingOrder ?? [...TRENDING_SECTIONS],
          profileVisibility: mergedVisibility,
          notificationPrefs: mergedPrefs as unknown as Prisma.InputJsonValue,
        },
        update: {
          ...(request.body.displayMode ? { displayMode: request.body.displayMode } : {}),
          ...(request.body.accentColor ? { accentColor: request.body.accentColor } : {}),
          ...(request.body.newsOrder ? { newsOrder: request.body.newsOrder } : {}),
          ...(request.body.eventsOrder ? { eventsOrder: request.body.eventsOrder } : {}),
          ...(request.body.trendingOrder ? { trendingOrder: request.body.trendingOrder } : {}),
          profileVisibility: mergedVisibility,
          notificationPrefs: mergedPrefs as unknown as Prisma.InputJsonValue,
        },
        select: settingsSelect,
      });

      return sendData(reply, {
        displayMode: updated.displayMode,
        accentColor: updated.accentColor,
        newsOrder: updated.newsOrder,
        eventsOrder: updated.eventsOrder,
        trendingOrder: updated.trendingOrder,
        profileVisibility: parseProfileVisibility(updated.profileVisibility),
        notificationPrefs: parseNotificationPrefs(updated.notificationPrefs),
      });
    },
  );
};
