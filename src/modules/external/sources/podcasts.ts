import { PODCAST_ITEMS_PER_FETCH } from '../../../config/constants.js';
import { safeFetch } from '../../../lib/ssrf.js';
import { parseFeed, sliceFeedXml } from '../feed.js';
import type { RawExternalItem, SourceAdapter } from '../types.js';

export interface PodcastSourceConfig {
  key: string;
  section: string;
  name: string;
  url: string;
}

/**
 * One section per publisher. The section slug is derived from the existing source key
 * (`podcast-changelog` -> `changelog`) so stored records migrate without a lookup table.
 */
export const PODCAST_SOURCE_CONFIG: PodcastSourceConfig[] = [
  {
    key: 'podcast-changelog',
    section: 'changelog',
    name: 'The Changelog',
    url: 'https://changelog.com/podcast/feed',
  },
  {
    key: 'podcast-freecodecamp',
    section: 'freecodecamp',
    name: 'freeCodeCamp',
    url: 'https://freecodecamp.libsyn.com/rss',
  },
  {
    key: 'podcast-sedaily',
    section: 'sedaily',
    name: 'Software Engineering Daily',
    url: 'https://softwareengineeringdaily.com/feed/',
  },
  {
    key: 'podcast-infoq',
    section: 'infoq',
    name: 'InfoQ',
    url: 'https://feed.infoq.com/',
  },
  {
    key: 'podcast-syntax',
    section: 'syntax',
    name: 'Syntax',
    url: 'https://feed.syntax.fm/rss',
  },
];

export const podcastAdapters: SourceAdapter[] = PODCAST_SOURCE_CONFIG.map((feed) => ({
  key: feed.key,
  name: feed.name,
  kind: 'PODCAST' as const,
  section: feed.section,
  url: feed.url,

  async fetchItems(): Promise<RawExternalItem[]> {
    // Podcast feeds are large. Reading stops as soon as the newest entries are in hand,
    // and the document is trimmed before parsing so only what we keep is ever processed.
    const response = await safeFetch(feed.url, {
      timeoutMs: 20_000,
      maxBytes: 4 * 1024 * 1024,
      stopAfterItems: PODCAST_ITEMS_PER_FETCH,
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${feed.name}`);

    const parsed = parseFeed(sliceFeedXml(response.body, PODCAST_ITEMS_PER_FETCH), feed.key);

    return parsed.items
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, PODCAST_ITEMS_PER_FETCH)
      .map((item) => ({
        ...item,
        author: item.author ?? parsed.title ?? feed.name,
        metadata: { ...item.metadata, platform: 'podcast', publisher: parsed.title ?? feed.name },
      }));
  },
}));
