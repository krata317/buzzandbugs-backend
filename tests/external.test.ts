import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetDatabase } from './setup.js';
import { parseFeed } from '../src/modules/external/feed.js';
import { refreshSource, paginateSection, ensureSources } from '../src/modules/external/service.js';
import { assertPublicHttpUrl } from '../src/lib/ssrf.js';
import { getApp } from './helpers/app.js';
import type { RawExternalItem, SourceAdapter } from '../src/modules/external/types.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First story</title>
      <link>https://example.com/first</link>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
      <pubDate>Tue, 04 Nov 2025 10:00:00 GMT</pubDate>
      <media:content url="https://example.com/first.jpg" type="image/jpeg" />
      <guid>story-1</guid>
    </item>
    <item>
      <title>Second story</title>
      <link>https://example.com/second</link>
      <description>Plain summary</description>
      <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Ada Lovelace</dc:creator>
    </item>
    <item>
      <title>No link here</title>
      <description>Skipped because there is no link</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.org/atom-entry" />
    <id>urn:uuid:1</id>
    <updated>2025-11-03T08:30:00Z</updated>
    <summary>Atom summary</summary>
    <author><name>Grace Hopper</name></author>
  </entry>
</feed>`;

const adapterWith = (items: RawExternalItem[]): SourceAdapter => ({
  key: 'fake-source',
  name: 'Fake source',
  kind: 'NEWS',
  section: 'trending',
  url: 'https://example.com/feed',
  fetchItems: async () => items,
});

describe('external content', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('parses RSS feeds with images, dates and authors', () => {
    const parsed = parseFeed(RSS, 'example');
    expect(parsed.title).toBe('Example Feed');
    expect(parsed.items.length).toBe(2);

    const first = parsed.items[0]!;
    expect(first.title).toBe('First story');
    expect(first.url).toBe('https://example.com/first');
    expect(first.summary).toBe('Hello world');
    expect(first.imageUrl).toBe('https://example.com/first.jpg');
    expect(first.publishedAt?.toISOString()).toBe('2025-11-04T10:00:00.000Z');
    expect(first.externalId).toBe('example:story-1');

    const second = parsed.items[1]!;
    expect(second.author).toBe('Ada Lovelace');
    expect(second.publishedAt).toBeNull();
  });

  it('parses Atom feeds', () => {
    const parsed = parseFeed(ATOM, 'atom');
    expect(parsed.title).toBe('Atom Feed');
    expect(parsed.items.length).toBe(1);

    const entry = parsed.items[0]!;
    expect(entry.url).toBe('https://example.org/atom-entry');
    expect(entry.author).toBe('Grace Hopper');
    expect(entry.publishedAt?.toISOString()).toBe('2025-11-03T08:30:00.000Z');
  });

  it('rejects malformed feeds without throwing raw XML errors', () => {
    expect(() => parseFeed('<<<not xml at all', 'bad')).toThrow();
    expect(() => parseFeed('<html><body>nope</body></html>', 'bad')).toThrow(
      /Unrecognised feed format/,
    );
  });

  it('stores successful refreshes and updates source health', async () => {
    await ensureSources();
    const items: RawExternalItem[] = [
      {
        externalId: 'fake-source:a',
        title: 'Story A',
        url: 'https://example.com/a',
        summary: 'Summary A',
        publishedAt: new Date('2025-11-01T00:00:00Z'),
      },
      {
        externalId: 'fake-source:b',
        title: 'Story B',
        url: 'https://example.com/b',
        publishedAt: null,
      },
    ];

    const result = await refreshSource(adapterWith(items), { force: true });
    expect(result.status).toBe('ok');
    expect(result.itemCount).toBe(2);

    const source = await prisma.externalSource.findUnique({ where: { key: 'fake-source' } });
    expect(source?.consecutiveFailures).toBe(0);
    expect(source?.lastSuccessAt).toBeTruthy();
    expect(source?.nextRetryAt).toBeNull();
    expect(source?.responseTimeMs).toBeGreaterThanOrEqual(0);

    const stored = await prisma.externalItem.count({ where: { sourceKey: 'fake-source' } });
    expect(stored).toBe(2);
  });

  it('isolates a failing source and keeps previously cached items', async () => {
    await ensureSources();
    await refreshSource(
      adapterWith([
        {
          externalId: 'fake-source:keep',
          title: 'Keep me',
          url: 'https://example.com/keep',
        },
      ]),
      { force: true },
    );

    const failing: SourceAdapter = {
      ...adapterWith([]),
      fetchItems: async () => {
        throw new Error('upstream is down');
      },
    };

    const result = await refreshSource(failing, { force: true });
    expect(result.status).toBe('failed');

    const source = await prisma.externalSource.findUnique({ where: { key: 'fake-source' } });
    expect(source?.consecutiveFailures).toBe(1);
    expect(source?.lastError).toContain('upstream is down');
    expect(source?.nextRetryAt).toBeTruthy();
    const retryInMinutes = ((source?.nextRetryAt?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(retryInMinutes).toBeGreaterThan(25);
    expect(retryInMinutes).toBeLessThan(35);

    const cached = await prisma.externalItem.count({ where: { sourceKey: 'fake-source' } });
    expect(cached).toBe(1);

    const skipped = await refreshSource(adapterWith([]));
    expect(skipped.status).toBe('skipped');
  });

  it('resets the failure counter after a later success', async () => {
    await ensureSources();
    const failing: SourceAdapter = {
      ...adapterWith([]),
      fetchItems: async () => {
        throw new Error('boom');
      },
    };
    await refreshSource(failing, { force: true });
    await refreshSource(
      adapterWith([
        {
          externalId: 'fake-source:recovered',
          title: 'Recovered',
          url: 'https://example.com/recovered',
          publishedAt: new Date(),
        },
      ]),
      { force: true },
    );

    const source = await prisma.externalSource.findUnique({ where: { key: 'fake-source' } });
    expect(source?.consecutiveFailures).toBe(0);
    expect(source?.lastError).toBeNull();
  });

  it('replaces the cached items instead of merging them', async () => {
    await ensureSources();

    const first: RawExternalItem[] = [
      {
        externalId: 'fake-source:keep',
        title: 'Keep me',
        url: 'https://example.com/keep',
        publishedAt: new Date(),
      },
      {
        externalId: 'fake-source:drop',
        title: 'Too short, later removed by the adapter',
        url: 'https://example.com/drop',
        publishedAt: new Date(Date.now() - 60_000),
      },
    ];
    await refreshSource(adapterWith(first), { force: true });

    const before = await prisma.externalItem.findMany({
      where: { sourceKey: 'fake-source' },
      select: { externalId: true },
    });
    expect(before).toHaveLength(2);

    await refreshSource(adapterWith([first[0] as RawExternalItem]), { force: true });

    const after = await prisma.externalItem.findMany({
      where: { sourceKey: 'fake-source' },
      select: { externalId: true },
    });
    expect(after.map((item) => item.externalId)).toEqual(['fake-source:keep']);
  });

  it('serves a stable newest-first order without shuffling', async () => {
    await ensureSources();
    const items: RawExternalItem[] = Array.from({ length: 12 }, (_, index) => ({
      externalId: `fake-source:${index}`,
      title: `Story ${index}`,
      url: `https://example.com/${index}`,
      publishedAt: new Date(Date.now() - index * 60_000),
    }));
    await refreshSource(adapterWith(items), { force: true });

    const first = await paginateSection({
      kind: 'NEWS',
      section: 'trending',
      offset: 0,
      limit: 4,
    });
    const again = await paginateSection({
      kind: 'NEWS',
      section: 'trending',
      offset: 0,
      limit: 4,
    });

    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(first.items.map((item) => item.title)).toEqual([
      'Story 0',
      'Story 1',
      'Story 2',
      'Story 3',
    ]);
    expect(first.total).toBe(12);
    expect(first.hasMore).toBe(true);

    const second = await paginateSection({
      kind: 'NEWS',
      section: 'trending',
      offset: 4,
      limit: 4,
    });
    expect(second.items.map((item) => item.title)).toEqual([
      'Story 4',
      'Story 5',
      'Story 6',
      'Story 7',
    ]);
  });

  it('orders events with ongoing first and excludes finished events', async () => {
    const now = Date.now();
    await prisma.externalItem.createMany({
      data: [
        {
          sourceKey: 'ctftime',
          kind: 'EVENT',
          section: 'ctf',
          externalId: 'ctftime:finished',
          title: 'Finished CTF',
          url: 'https://ctftime.org/event/1',
          startsAt: new Date(now - 7200_000),
          endsAt: new Date(now - 3600_000),
        },
        {
          sourceKey: 'ctftime',
          kind: 'EVENT',
          section: 'ctf',
          externalId: 'ctftime:upcoming',
          title: 'Upcoming CTF',
          url: 'https://ctftime.org/event/2',
          startsAt: new Date(now + 86_400_000),
          endsAt: new Date(now + 90_000_000),
        },
        {
          sourceKey: 'ctftime',
          kind: 'EVENT',
          section: 'ctf',
          externalId: 'ctftime:ongoing',
          title: 'Ongoing CTF',
          url: 'https://ctftime.org/event/3',
          startsAt: new Date(now - 3600_000),
          endsAt: new Date(now + 3600_000),
        },
      ],
    });

    const page = await paginateSection({
      kind: 'EVENT',
      section: 'ctf',
      offset: 0,
      limit: 5,
    });

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.title)).toEqual(['Ongoing CTF', 'Upcoming CTF']);
  });

  it('omits sections with no cached items', async () => {
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/news' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.sections).toEqual([]);
  });

  it('returns paginated items for a known section and rejects unknown ones', async () => {
    await prisma.externalItem.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        sourceKey: 'theverge',
        kind: 'NEWS' as const,
        section: 'trending',
        externalId: `theverge:${index}`,
        title: `Article ${index}`,
        url: `https://example.com/article-${index}`,
        publishedAt: new Date(Date.now() - index * 1000),
      })),
    });

    const app = await getApp();
    const list = await app.inject({ method: 'GET', url: '/api/v1/news/trending?limit=3' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(3);
    expect(list.json().meta.total).toBe(6);
    expect(list.json().meta.hasMore).toBe(true);

    const seed = list.json().meta.seed as string;
    const next = await app.inject({
      method: 'GET',
      url: `/api/v1/news/trending?limit=3&offset=3&seed=${seed}`,
    });
    expect(next.statusCode).toBe(200);
    const ids = [...list.json().data, ...next.json().data].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(6);

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/news/nonsense' });
    expect(unknown.statusCode).toBe(404);
  });

  it('blocks private and non-http destinations', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/admin')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://localhost:5432')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://10.0.0.5/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicHttpUrl('https://example.com/ok')).resolves.toBeInstanceOf(URL);
  });

  it('disables link previews when no provider is configured', async () => {
    const { getLinkPreview, isLinkPreviewConfigured } =
      await import('../src/modules/external/link-preview.js');
    expect(isLinkPreviewConfigured()).toBe(false);
    await expect(getLinkPreview('https://example.com/article')).resolves.toBeNull();
  });

  it('fills only missing metadata from link previews', async () => {
    const { enrichItemsWithPreviews } = await import('../src/modules/external/link-preview.js');

    const items: Array<{
      url: string;
      summary: string | null;
      imageUrl: string | null;
      metadata?: Record<string, unknown>;
    }> = [
      {
        url: 'https://complete.example.com/story',
        summary: 'Has summary',
        imageUrl: 'https://img/1.png',
      },
      { url: 'https://bare.example.net/story', summary: null, imageUrl: null },
      { url: 'https://nopreview.example.org/story', summary: null, imageUrl: null },
    ];

    const looked: string[] = [];
    const enriched = await enrichItemsWithPreviews(items, async (url) => {
      looked.push(url);
      if (url.includes('nopreview')) return null;
      return {
        url,
        title: 'Preview title',
        description: 'Preview description',
        imageUrl: 'https://img/preview.png',
        siteName: 'Example',
      };
    });

    // The complete item is never looked up.
    expect(looked).toEqual([
      'https://bare.example.net/story',
      'https://nopreview.example.org/story',
    ]);

    expect(enriched[0]).toEqual(items[0]);
    expect(enriched[1]?.summary).toBe('Preview description');
    expect(enriched[1]?.imageUrl).toBe('https://img/preview.png');
    expect(enriched[1]?.metadata).toEqual({ siteName: 'Example' });
    expect(enriched[2]).toEqual(items[2]);
  });

  it('caps preview lookups per refresh', async () => {
    const { enrichItemsWithPreviews, MAX_PREVIEW_LOOKUPS_PER_REFRESH } =
      await import('../src/modules/external/link-preview.js');

    const items = Array.from({ length: 20 }, (_, index) => ({
      url: `https://site${index}.example.com/article`,
      summary: null,
      imageUrl: null,
    }));

    let calls = 0;
    await enrichItemsWithPreviews(items, async () => {
      calls += 1;
      return null;
    });

    expect(calls).toBe(MAX_PREVIEW_LOOKUPS_PER_REFRESH);
  });

  it('makes at most one preview request per host', async () => {
    const { enrichItemsWithPreviews } = await import('../src/modules/external/link-preview.js');

    const items = [
      { url: 'https://same.example.com/one', summary: null, imageUrl: null },
      { url: 'https://same.example.com/two', summary: null, imageUrl: null },
      { url: 'https://other.example.org/three', summary: null, imageUrl: null },
    ];

    const looked: string[] = [];
    await enrichItemsWithPreviews(items, async (url) => {
      looked.push(url);
      return null;
    });

    expect(looked).toEqual(['https://same.example.com/one', 'https://other.example.org/three']);
  });

  it('builds linkpreview.net requests with the documented query and header', async () => {
    const { buildPreviewRequest } = await import('../src/modules/external/link-preview.js');

    const request = buildPreviewRequest(
      'https://example.com/article?id=1',
      'https://api.linkpreview.net/',
      'test-api-key',
    );

    const parsed = new URL(request.url);
    expect(parsed.origin).toBe('https://api.linkpreview.net');
    expect(parsed.searchParams.get('q')).toBe('https://example.com/article?id=1');
    expect(request.headers['x-linkpreview-api-key']).toBe('test-api-key');
  });
});
