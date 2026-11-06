import { env } from '../../../config/env.js';
import { safeFetch } from '../../../lib/ssrf.js';
import { parseFeed } from '../feed.js';
import {
  parseDate,
  safeUrl,
  stripHtml,
  truncate,
  type RawExternalItem,
  type SourceAdapter,
} from '../types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const getJson = async (url: string) => {
  const response = await safeFetch(url, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return JSON.parse(response.body) as unknown;
};

const youtubeAdapter: SourceAdapter = {
  key: 'youtube',
  name: 'YouTube',
  kind: 'TRENDING',
  section: 'youtube',
  url: 'https://www.googleapis.com/youtube/v3/videos',
  async fetchItems(): Promise<RawExternalItem[]> {
    if (!env.YOUTUBE_API_KEY) {
      throw new Error('YOUTUBE_API_KEY is not configured');
    }

    const endpoint = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&videoCategoryId=28&regionCode=US&key=${encodeURIComponent(
      env.YOUTUBE_API_KEY,
    )}&maxResults=50`;

    const payload = await getJson(endpoint);
    if (!isRecord(payload)) throw new Error('YouTube response is not an object');

    return asArray(payload.items).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = typeof entry.id === 'string' ? entry.id : null;
      const snippet = isRecord(entry.snippet) ? entry.snippet : null;
      if (!id || !snippet) return [];

      const tags = asArray(snippet.tags).filter((tag): tag is string => typeof tag === 'string');
      if (tags.some((tag) => tag.toLowerCase() === 'shorts')) return [];

      const title = typeof snippet.title === 'string' ? snippet.title : null;
      if (!title) return [];

      const thumbnails = isRecord(snippet.thumbnails) ? snippet.thumbnails : null;
      const high = thumbnails && isRecord(thumbnails.high) ? thumbnails.high : null;
      const medium = thumbnails && isRecord(thumbnails.medium) ? thumbnails.medium : null;
      const thumbnail =
        (high && typeof high.url === 'string' ? high.url : null) ??
        (medium && typeof medium.url === 'string' ? medium.url : null);

      const statistics = isRecord(entry.statistics) ? entry.statistics : {};

      return [
        {
          externalId: `youtube:${id}`,
          title: truncate(stripHtml(title), 300),
          url: `https://www.youtube.com/watch?v=${id}`,
          summary:
            typeof snippet.description === 'string'
              ? truncate(stripHtml(snippet.description), 400) || null
              : null,
          imageUrl: thumbnail ? safeUrl(thumbnail) : null,
          author: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : null,
          publishedAt: parseDate(snippet.publishedAt),
          metadata: {
            platform: 'youtube',
            tags,
            views: statistics.viewCount ? Number(statistics.viewCount) : null,
            likes: statistics.likeCount ? Number(statistics.likeCount) : null,
            comments: statistics.commentCount ? Number(statistics.commentCount) : null,
          },
        },
      ];
    });
  },
};

const repositoriesAdapter: SourceAdapter = {
  key: 'github-repositories',
  name: 'GitHub Repositories',
  kind: 'TRENDING',
  section: 'repositories',
  url: 'https://api.github.com/search/repositories?q=stars:%3E1000&sort=stars&order=desc',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);
    if (!isRecord(payload)) throw new Error('GitHub response is not an object');

    return asArray(payload.items).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = Number(entry.id);
      const fullName = typeof entry.full_name === 'string' ? entry.full_name : null;
      const htmlUrl = typeof entry.html_url === 'string' ? entry.html_url : null;
      if (!Number.isFinite(id) || !fullName || !htmlUrl) return [];

      const owner =
        isRecord(entry.owner) && typeof entry.owner.login === 'string'
          ? entry.owner.login
          : (fullName.split('/')[0] ?? null);
      const topics = asArray(entry.topics).filter(
        (topic): topic is string => typeof topic === 'string',
      );

      return [
        {
          externalId: `github-repositories:${id}`,
          title: fullName,
          url: htmlUrl,
          summary:
            typeof entry.description === 'string'
              ? truncate(stripHtml(entry.description), 400) || null
              : null,
          imageUrl: null,
          author: owner,
          publishedAt: parseDate(entry.updated_at),
          metadata: {
            platform: 'github',
            owner,
            name: fullName.split('/')[1] ?? fullName,
            stars: typeof entry.stargazers_count === 'number' ? entry.stargazers_count : null,
            language: typeof entry.language === 'string' ? entry.language : null,
            topics,
          },
        },
      ];
    });
  },
};

const modelsAdapter: SourceAdapter = {
  key: 'huggingface-models',
  name: 'Hugging Face Models',
  kind: 'TRENDING',
  section: 'models',
  url: 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=20',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);

    return asArray(payload).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = typeof entry.id === 'string' ? entry.id : null;
      if (!id) return [];

      return [
        {
          externalId: `huggingface-models:${id}`,
          title: id,
          url: `https://huggingface.co/${id}`,
          summary: null,
          imageUrl: null,
          author: typeof entry.author === 'string' ? entry.author : (id.split('/')[0] ?? null),
          publishedAt: parseDate(entry.lastModified),
          metadata: {
            platform: 'huggingface',
            library: typeof entry.library_name === 'string' ? entry.library_name : null,
            pipelineTag: typeof entry.pipeline_tag === 'string' ? entry.pipeline_tag : null,
            likes: typeof entry.likes === 'number' ? entry.likes : null,
            downloads: typeof entry.downloads === 'number' ? entry.downloads : null,
            tags: asArray(entry.tags).filter((tag): tag is string => typeof tag === 'string'),
          },
        },
      ];
    });
  },
};

const datasetsAdapter: SourceAdapter = {
  key: 'huggingface-datasets',
  name: 'Hugging Face Datasets',
  kind: 'TRENDING',
  section: 'datasets',
  url: 'https://huggingface.co/api/datasets?sort=downloads&direction=-1&limit=20',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);

    return asArray(payload).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = typeof entry.id === 'string' ? entry.id : null;
      if (!id) return [];

      return [
        {
          externalId: `huggingface-datasets:${id}`,
          title: id,
          url: `https://huggingface.co/datasets/${id}`,
          summary: null,
          imageUrl: null,
          author: typeof entry.author === 'string' ? entry.author : (id.split('/')[0] ?? null),
          publishedAt: parseDate(entry.lastModified),
          metadata: {
            platform: 'huggingface',
            likes: typeof entry.likes === 'number' ? entry.likes : null,
            downloads: typeof entry.downloads === 'number' ? entry.downloads : null,
            tags: asArray(entry.tags).filter((tag): tag is string => typeof tag === 'string'),
          },
        },
      ];
    });
  },
};

const papersAdapter: SourceAdapter = {
  key: 'paperswithcode',
  name: 'Papers with Code',
  kind: 'TRENDING',
  section: 'papers',
  url: 'https://paperswithcode.co/api/v1/papers/trending',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);
    const container = isRecord(payload) ? payload : {};
    const entries = asArray(container.results ?? container.papers ?? container.data ?? payload);

    return entries.flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = entry.id ?? entry.paper_id ?? entry.arxiv_id;
      const title = typeof entry.title === 'string' ? entry.title : null;
      const url = safeUrl(entry.url ?? entry.paper_url ?? entry.absolute_url);
      if (id === undefined || !title || !url) return [];

      const authors = asArray(entry.authors)
        .map((author) => {
          if (typeof author === 'string') return author;
          if (isRecord(author) && typeof author.name === 'string') return author.name;
          return null;
        })
        .filter((name): name is string => Boolean(name));

      const repository = isRecord(entry.repository) ? entry.repository : null;
      const repositoryOwner = repository
        ? typeof repository.owner === 'string'
          ? repository.owner
          : null
        : typeof entry.repository_owner === 'string'
          ? entry.repository_owner
          : null;

      const published =
        parseDate(entry.published) ?? parseDate(entry.published_at) ?? parseDate(entry.date);

      return [
        {
          externalId: `paperswithcode:${String(id)}`,
          title: truncate(stripHtml(title), 300),
          url,
          summary:
            typeof entry.abstract === 'string'
              ? truncate(stripHtml(entry.abstract), 400) || null
              : null,
          imageUrl: null,
          author: authors[0] ?? null,
          publishedAt: published,
          metadata: {
            platform: 'paperswithcode',
            authors,
            repositoryOwner,
            repositoryUrl: repository && typeof repository.url === 'string' ? repository.url : null,
          },
        },
      ];
    });
  },
};

const PODCAST_FEEDS = [
  { key: 'changelog', name: 'The Changelog', url: 'https://changelog.com/podcast/feed' },
  { key: 'freecodecamp', name: 'freeCodeCamp', url: 'https://freecodecamp.libsyn.com/rss' },
  {
    key: 'sedaily',
    name: 'Software Engineering Daily',
    url: 'https://softwareengineeringdaily.com/feed/',
  },
  { key: 'syntax', name: 'Syntax', url: 'https://feed.syntax.fm/rss' },
  { key: 'infoq', name: 'InfoQ', url: 'https://feed.infoq.com/' },
];

const podcastAdapters: SourceAdapter[] = PODCAST_FEEDS.map((feed) => ({
  key: `podcast-${feed.key}`,
  name: feed.name,
  kind: 'TRENDING' as const,
  section: 'podcasts',
  url: feed.url,
  async fetchItems(): Promise<RawExternalItem[]> {
    const response = await safeFetch(feed.url, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${feed.name}`);
    const parsed = parseFeed(response.body, `podcast-${feed.key}`);

    return parsed.items.map((item) => ({
      ...item,
      author: item.author ?? parsed.title ?? feed.name,
      metadata: { ...item.metadata, platform: 'podcast', publisher: parsed.title ?? feed.name },
    }));
  },
}));

export const trendingAdapters: SourceAdapter[] = [
  youtubeAdapter,
  repositoriesAdapter,
  modelsAdapter,
  datasetsAdapter,
  papersAdapter,
  ...podcastAdapters,
];
