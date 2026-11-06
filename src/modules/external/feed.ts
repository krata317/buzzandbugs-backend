import { XMLParser } from 'fast-xml-parser';
import { parseDate, safeUrl, stripHtml, truncate, type RawExternalItem } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
  // Entity expansion is disabled on purpose: it removes the billion-laughs attack surface and
  // avoids the parser's expansion limit being hit by large but legitimate feeds. Common and
  // numeric entities are decoded afterwards by stripHtml.
  processEntities: false,
});

type XmlValue = unknown;

const asArray = (value: XmlValue): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const textOf = (value: XmlValue): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') return record['#text'];
  }
  return null;
};

const attr = (value: XmlValue, name: string): string | null => {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const found = record[`@_${name}`];
    if (typeof found === 'string') return found;
  }
  return null;
};

const firstLink = (value: XmlValue): string | null => {
  const entries = asArray(value);
  if (entries.length === 0) return null;

  const plain = entries.find((entry) => typeof entry === 'string');
  if (typeof plain === 'string') return plain;

  const alternates = entries.filter((entry) => {
    const rel = attr(entry, 'rel');
    return rel === null || rel === 'alternate';
  });
  for (const entry of alternates.length > 0 ? alternates : entries) {
    const href = attr(entry, 'href');
    if (href) return href;
    const text = textOf(entry);
    if (text) return text;
  }
  return null;
};

const firstImage = (item: Record<string, unknown>, summaryHtml: string): string | null => {
  const candidates: string[] = [];

  for (const key of ['media:content', 'media:thumbnail', 'enclosure']) {
    for (const entry of asArray(item[key])) {
      const url = attr(entry, 'url');
      const type = attr(entry, 'type');
      if (url && (!type || type.startsWith('image'))) candidates.push(url);
    }
  }

  const itunesImage = attr(item['itunes:image'], 'href');
  if (itunesImage) candidates.push(itunesImage);

  for (const key of ['image', 'media:group']) {
    const direct = firstLink(item[key]);
    if (direct) candidates.push(direct);
  }

  const match = summaryHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match?.[1]) candidates.push(match[1]);

  for (const candidate of candidates) {
    const safe = safeUrl(candidate);
    if (safe) return safe;
  }
  return null;
};

const firstAuthor = (item: Record<string, unknown>): string | null => {
  for (const key of ['dc:creator', 'author', 'itunes:author', 'creator']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return stripHtml(value).slice(0, 200);
    if (value && typeof value === 'object') {
      const name = (value as Record<string, unknown>).name;
      const nameText = textOf(name);
      if (nameText) return stripHtml(nameText).slice(0, 200);
      const direct = textOf(value);
      if (direct) return stripHtml(direct).slice(0, 200);
    }
  }
  return null;
};

const firstDate = (item: Record<string, unknown>): Date | null => {
  for (const key of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const date = parseDate(textOf(item[key]));
    if (date) return date;
  }
  return null;
};

const summaryOf = (item: Record<string, unknown>): string => {
  for (const key of ['content:encoded', 'content', 'summary', 'description', 'media:description']) {
    const raw = textOf(item[key]);
    if (raw && raw.trim()) return raw;
  }
  return '';
};

const parseDuration = (value: XmlValue): number | null => {
  const text = textOf(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return null;
};

export interface ParsedFeed {
  title: string | null;
  items: RawExternalItem[];
}

const ITEM_BLOCK = /<item[\s>][\s\S]*?<\/item>/gi;
const ENTRY_BLOCK = /<entry[\s>][\s\S]*?<\/entry>/gi;

/**
 * Keeps only the first `limit` items of a feed document and wraps them in a minimal
 * envelope so the result is still valid XML. Used for large feeds where downloading and
 * parsing the whole document is wasteful.
 */
export const sliceFeedXml = (xml: string, limit: number): string => {
  const items = (xml.match(ITEM_BLOCK) ?? []).slice(0, limit);
  if (items.length > 0) {
    return `<rss><channel>${items.join('')}</channel></rss>`;
  }

  const entries = (xml.match(ENTRY_BLOCK) ?? []).slice(0, limit);
  if (entries.length > 0) {
    return `<feed>${entries.join('')}</feed>`;
  }

  return xml;
};

/** Parses RSS 2.0, Atom and RDF feeds into a single normalised shape. */
export const parseFeed = (xml: string, sourceKey: string): ParsedFeed => {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parser error';
    throw new Error(`Feed is not valid XML: ${reason}`);
  }

  let feedTitle: string | null = null;
  let entries: unknown[] = [];

  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;

  if (channel) {
    feedTitle = textOf(channel.title);
    entries = asArray(channel.item);
  } else if (document.feed) {
    const atom = document.feed as Record<string, unknown>;
    feedTitle = textOf(atom.title);
    entries = asArray(atom.entry);
  } else if (document['rdf:RDF']) {
    const rdf = document['rdf:RDF'] as Record<string, unknown>;
    const rdfChannel = rdf.channel as Record<string, unknown> | undefined;
    feedTitle = rdfChannel ? textOf(rdfChannel.title) : null;
    entries = asArray(rdf.item);
  } else {
    throw new Error('Unrecognised feed format');
  }

  const items: RawExternalItem[] = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const title = stripHtml(textOf(item.title) ?? '');
    const link = firstLink(item.link);
    const rawSummary = summaryOf(item);
    const summary = stripHtml(rawSummary);

    if (!title || !link) continue;
    const safeLink = safeUrl(link);
    if (!safeLink) continue;

    const guid = textOf(item.guid) ?? textOf(item.id) ?? safeLink;
    const duration = parseDuration(item['itunes:duration']);

    items.push({
      externalId: `${sourceKey}:${guid.slice(0, 200)}`,
      title: truncate(title, 300),
      url: safeLink,
      summary: summary ? truncate(summary, 500) : null,
      imageUrl: firstImage(item, rawSummary),
      author: firstAuthor(item),
      publishedAt: firstDate(item),
      metadata: duration ? { durationSeconds: duration } : undefined,
    });
  }

  return { title: feedTitle, items };
};
