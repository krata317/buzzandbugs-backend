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

const postJson = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return (await response.json()) as Record<string, unknown>;
};

const getJson = async (url: string, accept = 'application/json') => {
  const response = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, accept });
  if (response.status !== 200)
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return JSON.parse(response.body) as unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const toIsoDate = (value: unknown): Date | null => {
  if (typeof value === 'number') {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseDate(value);
};

const hackathonAdapter: SourceAdapter = {
  key: 'brabble-hackathons',
  name: 'Hackathons',
  kind: 'EVENT',
  section: 'hackathons',
  url: 'https://brabble.ai/rss/hackathons.xml',
  async fetchItems() {
    const response = await safeFetch(this.url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024 });
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from brabble.ai`);
    const parsed = parseFeed(response.body, this.key);
    return parsed.items.map((item) => ({
      ...item,
      metadata: {
        ...item.metadata,
        platform: 'generic',
      },
    }));
  },
};

const leetcodeAdapter: SourceAdapter = {
  key: 'leetcode-contests',
  name: 'LeetCode Contests',
  kind: 'EVENT',
  section: 'contests',
  url: 'https://leetcode.com/graphql',
  async fetchItems(): Promise<RawExternalItem[]> {
    const query = `query contestV2UpcomingContests {
      contestV2UpcomingContests {
        titleSlug
        title
        startTime
        duration
        cardImg
      }
    }`;

    const payload = await postJson(
      'https://leetcode.com/graphql',
      { query, variables: {}, operationName: 'contestV2UpcomingContests' },
      { referer: 'https://leetcode.com' },
    );

    const data = payload.data;
    if (!isRecord(data)) throw new Error('LeetCode response is missing data');
    const contests = asArray(data.contestV2UpcomingContests);

    return contests.flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const titleSlug = typeof entry.titleSlug === 'string' ? entry.titleSlug : null;
      const title = typeof entry.title === 'string' ? entry.title : titleSlug;
      const startSeconds = Number(entry.startTime);
      if (!titleSlug || !title || !Number.isFinite(startSeconds)) return [];

      const durationSeconds = Number.isFinite(Number(entry.duration))
        ? Number(entry.duration)
        : 5400;
      const start = new Date(startSeconds * 1000);
      const end = new Date((startSeconds + durationSeconds) * 1000);
      const url = `https://leetcode.com/contest/${titleSlug}`;

      return [
        {
          externalId: `leetcode-contests:${titleSlug}`,
          title: truncate(title, 300),
          url,
          summary: null,
          imageUrl: typeof entry.cardImg === 'string' ? safeUrl(entry.cardImg) : null,
          publishedAt: null,
          startsAt: start,
          endsAt: end,
          metadata: { platform: 'leetcode', durationSeconds },
        },
      ];
    });
  },
};

const codechefAdapter: SourceAdapter = {
  key: 'codechef-contests',
  name: 'CodeChef Contests',
  kind: 'EVENT',
  section: 'contests',
  url: 'https://www.codechef.com/api/list/contests/all?sort_by=START&sorting_order=asc&offset=0&mode=all',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);
    if (!isRecord(payload)) throw new Error('CodeChef response is not an object');

    const collect = (value: unknown): RawExternalItem[] =>
      asArray(value).flatMap<RawExternalItem>((entry) => {
        if (!isRecord(entry)) return [];
        const name = typeof entry.contest_name === 'string' ? entry.contest_name : null;
        const code = typeof entry.contest_code === 'string' ? entry.contest_code : null;
        const start = parseDate(entry.contest_start_date_iso);
        const end = parseDate(entry.contest_end_date_iso);
        if (!name || !code || !start || !end) return [];

        return [
          {
            externalId: `codechef-contests:${code}`,
            title: truncate(name, 300),
            url: `https://www.codechef.com/${code}`,
            summary: null,
            imageUrl: null,
            publishedAt: null,
            startsAt: start,
            endsAt: end,
            metadata: { platform: 'codechef' },
          },
        ];
      });

    return [...collect(payload.present_contests), ...collect(payload.future_contests)];
  },
};

const codeforcesAdapter: SourceAdapter = {
  key: 'codeforces-contests',
  name: 'Codeforces Contests',
  kind: 'EVENT',
  section: 'contests',
  url: 'https://codeforces.com/api/contest.list?gym=false',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);
    if (!isRecord(payload)) throw new Error('Codeforces response is not an object');
    if (payload.status !== 'OK') throw new Error('Codeforces API returned a non-OK status');

    return asArray(payload.result).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const phase = entry.phase;
      if (phase !== 'BEFORE' && phase !== 'CODING') return [];

      const id = Number(entry.id);
      const name = typeof entry.name === 'string' ? entry.name : null;
      const startSeconds = Number(entry.startTimeSeconds);
      if (!Number.isFinite(id) || !name || !Number.isFinite(startSeconds)) return [];

      const durationSeconds = Number.isFinite(Number(entry.durationSeconds))
        ? Number(entry.durationSeconds)
        : 7200;

      return [
        {
          externalId: `codeforces-contests:${id}`,
          title: truncate(name, 300),
          url: `https://codeforces.com/contest/${id}`,
          summary: null,
          imageUrl: null,
          publishedAt: null,
          startsAt: new Date(startSeconds * 1000),
          endsAt: new Date((startSeconds + durationSeconds) * 1000),
          metadata: { platform: 'codeforces', durationSeconds },
        },
      ];
    });
  },
};

const ctftimeAdapter: SourceAdapter = {
  key: 'ctftime',
  name: 'CTFtime',
  kind: 'EVENT',
  section: 'ctf',
  url: 'https://ctftime.org/api/v1/events/?limit=20',
  async fetchItems(): Promise<RawExternalItem[]> {
    const payload = await getJson(this.url);
    return asArray(payload).flatMap<RawExternalItem>((entry) => {
      if (!isRecord(entry)) return [];
      const id = Number(entry.id);
      const title = typeof entry.title === 'string' ? entry.title : null;
      const start = toIsoDate(entry.start);
      const end = toIsoDate(entry.finish);
      if (!Number.isFinite(id) || !title || !start || !end) return [];

      const organizers = asArray(entry.organizers)
        .map((organizer) =>
          isRecord(organizer) && typeof organizer.name === 'string' ? organizer.name : null,
        )
        .filter((name): name is string => Boolean(name));

      return [
        {
          externalId: `ctftime:${id}`,
          title: truncate(title, 300),
          url: `https://ctftime.org/event/${id}`,
          summary:
            typeof entry.description === 'string'
              ? truncate(stripHtml(entry.description), 500)
              : null,
          imageUrl: typeof entry.logo === 'string' ? safeUrl(entry.logo) : null,
          author: organizers[0] ?? null,
          publishedAt: null,
          startsAt: start,
          endsAt: end,
          metadata: {
            platform: 'ctftime',
            format: typeof entry.format === 'string' ? entry.format : null,
            weight: typeof entry.weight === 'number' ? entry.weight : null,
            organizers,
          },
        },
      ];
    });
  },
};

export const eventAdapters: SourceAdapter[] = [
  hackathonAdapter,
  leetcodeAdapter,
  codechefAdapter,
  codeforcesAdapter,
  ctftimeAdapter,
];
