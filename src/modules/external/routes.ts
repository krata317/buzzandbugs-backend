import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { SourceKind } from '@prisma/client';
import { z } from 'zod';
import { sendData, sendPage } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import {
  EVENT_SECTIONS,
  NEWS_SECTIONS,
  PODCAST_SECTIONS,
  TRENDING_SECTIONS,
} from '../../config/constants.js';
import { paginateSection } from './service.js';
import type { AppInstance } from '../../types.js';

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(40).optional(),
});

type OrderField = 'newsOrder' | 'eventsOrder' | 'trendingOrder';

const sectionOrder = async (
  userId: string | undefined,
  field: OrderField,
  fallback: readonly string[],
): Promise<string[]> => {
  if (!userId) return [...fallback];
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { newsOrder: true, eventsOrder: true, trendingOrder: true },
  });
  const order = settings?.[field];
  if (!order || order.length === 0) return [...fallback];
  const allowed = new Set(fallback);
  const filtered = order.filter((section) => allowed.has(section));
  for (const section of fallback) {
    if (!filtered.includes(section)) filtered.push(section);
  }
  return filtered;
};

const registerSectionRoutes = (
  app: AppInstance,
  options: {
    kind: SourceKind;
    basePath: string;
    tag: string;
    sections: readonly string[];
    initialCount: number;
    orderField?: OrderField;
  },
): void => {
  app.get(
    options.basePath,
    {
      preHandler: app.optionalAuthenticate,
      schema: {
        tags: [options.tag],
        summary: `Cached ${options.tag.toLowerCase()} sections`,
      },
    },
    async (request, reply) => {
      const order = options.orderField
        ? await sectionOrder(request.auth?.user.id, options.orderField, options.sections)
        : [...options.sections];

      const sections = [];
      for (const section of order) {
        const page = await paginateSection({
          kind: options.kind,
          section,
          offset: 0,
          limit: options.initialCount,
        });
        if (page.total === 0) continue;
        sections.push({
          section,
          total: page.total,
          hasMore: page.hasMore,
          items: page.items,
        });
      }

      return sendData(reply, { sections });
    },
  );

  app.get(
    `${options.basePath}/:section`,
    {
      preHandler: app.optionalAuthenticate,
      schema: {
        tags: [options.tag],
        summary: `Paginated ${options.tag.toLowerCase()} items for one section`,
        params: z.object({ section: z.string() }),
        querystring: querySchema,
      },
    },
    async (request, reply) => {
      if (!options.sections.includes(request.params.section)) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Unknown section' },
        });
      }

      const limit = request.query.limit ?? options.initialCount;
      const page = await paginateSection({
        kind: options.kind,
        section: request.params.section,
        offset: request.query.offset,
        limit,
      });

      return sendPage(reply, page.items, {
        total: page.total,
        hasMore: page.hasMore,
        offset: request.query.offset,
        limit,
      });
    },
  );
};

export const externalRoutes: FastifyPluginAsyncZod = async (app) => {
  registerSectionRoutes(app, {
    kind: 'NEWS',
    basePath: '/news',
    tag: 'News',
    sections: NEWS_SECTIONS,
    initialCount: 3,
    orderField: 'newsOrder',
  });

  registerSectionRoutes(app, {
    kind: 'EVENT',
    basePath: '/events',
    tag: 'Events',
    sections: EVENT_SECTIONS,
    initialCount: 5,
    orderField: 'eventsOrder',
  });

  registerSectionRoutes(app, {
    kind: 'TRENDING',
    basePath: '/trending',
    tag: 'Trending',
    sections: TRENDING_SECTIONS,
    initialCount: 4,
    orderField: 'trendingOrder',
  });

  registerSectionRoutes(app, {
    kind: 'PODCAST',
    basePath: '/podcasts',
    tag: 'Podcasts',
    sections: PODCAST_SECTIONS,
    initialCount: 4,
  });
};
