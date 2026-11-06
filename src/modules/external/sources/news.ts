import { safeFetch } from '../../../lib/ssrf.js';
import { parseFeed } from '../feed.js';
import type { RawExternalItem, SourceAdapter } from '../types.js';

export interface FeedSourceConfig {
  key: string;
  name: string;
  section: string;
  url: string;
  /** Tried in order when the primary URL fails (for example after a publisher changes it). */
  fallbacks?: string[];
}

export const createFeedAdapter = (config: FeedSourceConfig): SourceAdapter => ({
  key: config.key,
  name: config.name,
  kind: 'NEWS',
  section: config.section,
  url: config.url,
  async fetchItems(): Promise<RawExternalItem[]> {
    const candidates = [config.url, ...(config.fallbacks ?? [])];
    let lastError: Error | null = null;

    for (const url of candidates) {
      try {
        const response = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024 });
        if (response.status !== 200) {
          throw new Error(`${config.name} responded with HTTP ${response.status}`);
        }
        const parsed = parseFeed(response.body, config.key);
        return parsed.items;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error(`${config.name} could not be fetched`);
  },
});

export const NEWS_SOURCE_CONFIG: FeedSourceConfig[] = [
  {
    key: 'theverge',
    name: 'The Verge',
    section: 'trending',
    url: 'https://www.theverge.com/rss/index.xml',
  },
  {
    key: 'techcrunch',
    name: 'TechCrunch',
    section: 'trending',
    url: 'https://techcrunch.com/feed/',
  },
  {
    key: 'theregister',
    name: 'The Register',
    section: 'trending',
    url: 'https://www.theregister.com/headlines.ato',
    // The documented ".ato" path now returns 404; the Atom feed is the same content.
    fallbacks: ['https://www.theregister.com/headlines.atom'],
  },

  {
    key: 'huggingface-blog',
    name: 'Hugging Face Blog',
    section: 'ai',
    url: 'https://huggingface.co/blog/feed.xml',
  },
  {
    key: 'arxiv',
    name: 'arXiv cs.AI',
    section: 'ai',
    url: 'https://rss.arxiv.org/rss/cs.AI+cs.LG+cs.CL+cs.CV',
  },

  {
    key: 'bleepingcomputer',
    name: 'BleepingComputer',
    section: 'security',
    url: 'https://www.bleepingcomputer.com/feed/',
  },
  {
    key: 'thehackernews',
    name: 'The Hacker News',
    section: 'security',
    url: 'https://feeds.feedburner.com/TheHackersNews',
  },

  { key: 'openai', name: 'OpenAI', section: 'leaders', url: 'https://openai.com/news/rss.xml' },
  {
    key: 'googledev',
    name: 'Google Developers',
    section: 'leaders',
    url: 'https://developers.googleblog.com/feeds/posts/default/',
  },
  {
    key: 'msdevblogs',
    name: 'Microsoft DevBlogs',
    section: 'leaders',
    url: 'https://devblogs.microsoft.com/feed/',
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    section: 'leaders',
    url: 'https://blog.cloudflare.com/rss/',
  },
  {
    key: 'aws',
    name: 'AWS What’s New',
    section: 'leaders',
    url: 'https://aws.amazon.com/new/feed/',
  },
  {
    key: 'netflixtech',
    name: 'Netflix TechBlog',
    section: 'leaders',
    url: 'https://netflixtechblog.com/feed',
  },
  {
    key: 'googlecloud',
    name: 'Google Cloud',
    section: 'leaders',
    url: 'https://cloudblog.withgoogle.com/rss/',
  },

  {
    key: 'googlenews-in',
    name: 'Google News India',
    section: 'india',
    url: 'https://news.google.com/rss/search?q=technology&hl=en-IN&gl=IN&ceid=IN:en',
  },
  { key: 'inc42', name: 'Inc42', section: 'india', url: 'https://inc42.com/feed/' },
];

export const newsAdapters: SourceAdapter[] = NEWS_SOURCE_CONFIG.map(createFeedAdapter);
