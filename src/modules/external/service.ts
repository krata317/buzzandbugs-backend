import type { ExternalItem, SourceKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import {
  EVENT_ITEMS_PER_SECTION,
  NEWS_ITEMS_PER_SECTION,
  PODCAST_ITEMS_PER_SECTION,
  TRENDING_ITEMS_PER_SECTION,
} from '../../config/constants.js';
import { adaptersForKind, allAdapters } from './registry.js';
import {
  enrichItemsWithPreviews,
  getLinkPreview,
  isLinkPreviewConfigured,
} from './link-preview.js';
import type { RawExternalItem, SourceAdapter } from './types.js';

const RETRY_DELAY_MS = 30 * 60 * 1000;
/** Feeds can be very large; only the newest slice is worth storing for a 25-40 item cache. */
const MAX_ITEMS_PER_SOURCE = 60;

export const sectionLimitFor = (kind: SourceKind): number => {
  if (kind === 'NEWS') return NEWS_ITEMS_PER_SECTION;
  if (kind === 'EVENT') return EVENT_ITEMS_PER_SECTION;
  if (kind === 'PODCAST') return PODCAST_ITEMS_PER_SECTION;
  return TRENDING_ITEMS_PER_SECTION;
};

/** Seeds the ExternalSource table so health information exists before the first refresh. */
export const ensureSources = async (): Promise<void> => {
  for (const adapter of allAdapters) {
    await prisma.externalSource.upsert({
      where: { key: adapter.key },
      create: {
        key: adapter.key,
        name: adapter.name,
        kind: adapter.kind,
        section: adapter.section,
        url: adapter.url,
      },
      update: {
        name: adapter.name,
        kind: adapter.kind,
        section: adapter.section,
        url: adapter.url,
      },
    });
  }
};

const isUsable = (item: { title: string; url: string }): boolean =>
  item.title.trim().length > 0 && item.url.startsWith('http');

export interface SourceRefreshResult {
  key: string;
  status: 'ok' | 'failed' | 'skipped';
  itemCount: number;
  error?: string;
}

export const refreshSource = async (
  adapter: SourceAdapter,
  options: { force?: boolean } = {},
): Promise<SourceRefreshResult> => {
  const source = await prisma.externalSource.upsert({
    where: { key: adapter.key },
    create: {
      key: adapter.key,
      name: adapter.name,
      kind: adapter.kind,
      section: adapter.section,
      url: adapter.url,
    },
    update: {},
  });

  if (!options.force && source.nextRetryAt && source.nextRetryAt.getTime() > Date.now()) {
    return { key: adapter.key, status: 'skipped', itemCount: 0 };
  }

  const startedAt = Date.now();
  await prisma.externalSource.update({
    where: { key: adapter.key },
    data: { lastAttemptAt: new Date() },
  });

  try {
    let items: RawExternalItem[] = (await adapter.fetchItems())
      .filter(isUsable)
      .slice(0, MAX_ITEMS_PER_SOURCE);

    // News only: feeds stay the primary source of metadata, previews fill in what is missing.
    if (adapter.kind === 'NEWS' && isLinkPreviewConfigured()) {
      items = await enrichItemsWithPreviews(items, getLinkPreview);
    }

    for (const item of items) {
      await prisma.externalItem.upsert({
        where: { sourceKey_externalId: { sourceKey: adapter.key, externalId: item.externalId } },
        create: {
          sourceKey: adapter.key,
          kind: adapter.kind,
          section: adapter.section,
          externalId: item.externalId,
          title: item.title,
          url: item.url,
          summary: item.summary ?? null,
          imageUrl: item.imageUrl ?? null,
          author: item.author ?? null,
          publishedAt: item.publishedAt ?? null,
          startsAt: item.startsAt ?? null,
          endsAt: item.endsAt ?? null,
          metadata: item.metadata ? (item.metadata as object) : undefined,
          fetchedAt: new Date(),
        },
        update: {
          title: item.title,
          url: item.url,
          summary: item.summary ?? null,
          imageUrl: item.imageUrl ?? null,
          author: item.author ?? null,
          publishedAt: item.publishedAt ?? null,
          startsAt: item.startsAt ?? null,
          endsAt: item.endsAt ?? null,
          metadata: item.metadata ? (item.metadata as object) : undefined,
          fetchedAt: new Date(),
        },
      });
    }

    await prisma.externalSource.update({
      where: { key: adapter.key },
      data: {
        lastSuccessAt: new Date(),
        responseTimeMs: Date.now() - startedAt,
        consecutiveFailures: 0,
        lastError: null,
        nextRetryAt: null,
      },
    });

    await pruneSection(adapter.kind, adapter.section);

    return { key: adapter.key, status: 'ok', itemCount: items.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    await prisma.externalSource.update({
      where: { key: adapter.key },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: message.slice(0, 500),
        responseTimeMs: Date.now() - startedAt,
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS),
      },
    });
    logger.warn({ source: adapter.key, err: error }, 'external source refresh failed');
    return { key: adapter.key, status: 'failed', itemCount: 0, error: message };
  }
};

const pruneSection = async (kind: SourceKind, section: string): Promise<void> => {
  const limit = sectionLimitFor(kind);

  if (kind === 'EVENT') {
    await prisma.externalItem.deleteMany({
      where: { kind, section, endsAt: { lt: new Date() } },
    });
    const upcoming = await prisma.externalItem.findMany({
      where: { kind, section },
      orderBy: [{ startsAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (upcoming.length === 0) return;
    await prisma.externalItem.deleteMany({
      where: { kind, section, id: { notIn: upcoming.map((item) => item.id) } },
    });
    return;
  }

  const keep = await prisma.externalItem.findMany({
    where: { kind, section },
    orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { fetchedAt: 'desc' }],
    take: limit,
    select: { id: true },
  });
  if (keep.length === 0) return;

  await prisma.externalItem.deleteMany({
    where: { kind, section, id: { notIn: keep.map((item) => item.id) } },
  });
};

export const refreshKind = async (kind: SourceKind): Promise<SourceRefreshResult[]> => {
  const adapters = adaptersForKind(kind);
  const results: SourceRefreshResult[] = [];

  for (const adapter of adapters) {
    results.push(await refreshSource(adapter));
  }

  const sections = [...new Set(adapters.map((adapter) => adapter.section))];
  for (const section of sections) {
    await pruneSection(kind, section);
  }

  return results;
};

export const refreshSection = async (
  kind: SourceKind,
  section: string,
): Promise<SourceRefreshResult[]> => {
  const adapters = adaptersForKind(kind).filter((adapter) => adapter.section === section);
  const results: SourceRefreshResult[] = [];
  for (const adapter of adapters) {
    results.push(await refreshSource(adapter, { force: true }));
  }
  await pruneSection(kind, section);
  return results;
};

export const itemToDto = (item: ExternalItem) => ({
  id: item.id,
  source: item.sourceKey,
  section: item.section,
  title: item.title,
  url: item.url,
  summary: item.summary,
  imageUrl: item.imageUrl,
  author: item.author,
  publishedAt: item.publishedAt?.toISOString() ?? null,
  startsAt: item.startsAt?.toISOString() ?? null,
  endsAt: item.endsAt?.toISOString() ?? null,
  metadata: item.metadata,
});

export const loadSectionItems = async (
  kind: SourceKind,
  section: string,
): Promise<ExternalItem[]> => {
  if (kind === 'EVENT') {
    return prisma.externalItem.findMany({
      where: {
        kind,
        section,
        OR: [{ endsAt: { gt: new Date() } }, { endsAt: null }],
      },
      orderBy: [{ startsAt: 'asc' }],
    });
  }

  return prisma.externalItem.findMany({
    where: { kind, section },
    orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { fetchedAt: 'desc' }],
  });
};

const orderEvents = (items: ExternalItem[]): ExternalItem[] => {
  const now = Date.now();
  const ongoing: ExternalItem[] = [];
  const upcoming: ExternalItem[] = [];

  for (const item of items) {
    const starts = item.startsAt?.getTime() ?? null;
    const ends = item.endsAt?.getTime() ?? null;
    if (ends !== null && ends <= now) continue;
    if (starts !== null && starts <= now) ongoing.push(item);
    else upcoming.push(item);
  }

  ongoing.sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
  upcoming.sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
  return [...ongoing, ...upcoming];
};

export interface SectionPage {
  items: ReturnType<typeof itemToDto>[];
  total: number;
  hasMore: boolean;
}

/**
 * Sections are ordered once, by the worker, and served in that same order until the next
 * refresh. Nothing is shuffled per request, so a reader sees a stable list across reloads.
 */
export const paginateSection = async (options: {
  kind: SourceKind;
  section: string;
  offset: number;
  limit: number;
}): Promise<SectionPage> => {
  const loaded = await loadSectionItems(options.kind, options.section);
  const ordered = options.kind === 'EVENT' ? orderEvents(loaded) : loaded;
  const slice = ordered.slice(options.offset, options.offset + options.limit);

  return {
    items: slice.map(itemToDto),
    total: ordered.length,
    hasMore: options.offset + options.limit < ordered.length,
  };
};
