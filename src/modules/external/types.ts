import type { SourceKind } from '@prisma/client';

export interface RawExternalItem {
  externalId: string;
  title: string;
  url: string;
  summary?: string | null;
  imageUrl?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  key: string;
  name: string;
  kind: SourceKind;
  section: string;
  url: string;
  fetchItems(): Promise<RawExternalItem[]>;
}

export const stripHtml = (input: string): string =>
  input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

export const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const safeUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const platformFromUrl = (url: string): string => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('unstop')) return 'unstop';
    if (host.includes('devpost')) return 'devpost';
    if (host.includes('devfolio')) return 'devfolio';
    if (host.includes('hackerearth')) return 'hackerearth';
    if (host.includes('mlh')) return 'mlh';
    if (host.includes('leetcode')) return 'leetcode';
    if (host.includes('codechef')) return 'codechef';
    if (host.includes('codeforces')) return 'codeforces';
    if (host.includes('ctftime')) return 'ctftime';
    return 'generic';
  } catch {
    return 'generic';
  }
};
