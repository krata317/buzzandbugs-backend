import type { SourceKind } from '@prisma/client';
import { newsAdapters } from './sources/news.js';
import { eventAdapters } from './sources/events.js';
import { trendingAdapters } from './sources/trending.js';
import { podcastAdapters } from './sources/podcasts.js';
import type { SourceAdapter } from './types.js';

export const allAdapters: SourceAdapter[] = [
  ...newsAdapters,
  ...eventAdapters,
  ...trendingAdapters,
  ...podcastAdapters,
];

export const adaptersForKind = (kind: SourceKind): SourceAdapter[] =>
  allAdapters.filter((adapter) => adapter.kind === kind);

export const adapterByKey = (key: string): SourceAdapter | undefined =>
  allAdapters.find((adapter) => adapter.key === key);
