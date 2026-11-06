import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { safeFetch, isPrivateAddress } from '../../lib/ssrf.js';
import { addDays } from '../../lib/time.js';
import { consumeRateLimit } from '../../lib/rate-limit.js';

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

const CACHE_TTL_DAYS = 7;
const MAX_FIELD_LENGTH = 500;
const BUDGET_KEY = 'linkpreview:daily';

const urlHash = (url: string): string => createHash('sha256').update(url).digest('hex');

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_FIELD_LENGTH);
};

const httpUrlOrNull = (value: unknown): string | null => {
  const text = asString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Cheap synchronous guard so we never ask the provider to probe an internal host. */
const isObviouslyInternal = (target: string): boolean => {
  try {
    const host = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (isIP(host) && isPrivateAddress(host)) return true;
    return false;
  } catch {
    return true;
  }
};

export interface PreviewRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Builds a linkpreview.net request. The provider expects `?q=<percent-encoded url>` and the key in
 * the `X-Linkpreview-Api-Key` header (the `key` query parameter is deprecated).
 */
export const buildPreviewRequest = (
  targetUrl: string,
  baseUrl: string = env.LINK_PREVIEW_API_URL ?? '',
  apiKey: string = env.LINK_PREVIEW_API_KEY ?? '',
): PreviewRequest => {
  const endpoint = new URL(baseUrl || 'https://api.linkpreview.net/');
  endpoint.searchParams.set('q', targetUrl);

  return {
    url: endpoint.toString(),
    headers: { 'x-linkpreview-api-key': apiKey },
  };
};

export const isLinkPreviewConfigured = (): boolean => env.linkPreviewConfigured;

/** Previews are a fallback, not a crawler: cap how many lookups one refresh may trigger. */
export const MAX_PREVIEW_LOOKUPS_PER_REFRESH = 8;

export interface PreviewableItem {
  url: string;
  summary?: string | null;
  imageUrl?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fills only the fields a feed did not provide. Items that already carry a summary and an image
 * are never looked up, a `null` preview leaves the item untouched, and duplicate hosts are skipped
 * because linkpreview.net allows one request per second per domain.
 */
export const enrichItemsWithPreviews = async <T extends PreviewableItem>(
  items: T[],
  lookup: (url: string) => Promise<LinkPreview | null>,
  limit: number = MAX_PREVIEW_LOOKUPS_PER_REFRESH,
): Promise<T[]> => {
  const seenHosts = new Set<string>();
  const candidates: T[] = [];

  for (const item of items) {
    if (item.summary && item.imageUrl) continue;
    let host: string;
    try {
      host = new URL(item.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    candidates.push(item);
    if (candidates.length >= limit) break;
  }

  if (candidates.length === 0) return items;

  const previews = new Map<string, LinkPreview | null>();
  await Promise.all(
    candidates.map(async (item) => {
      previews.set(item.url, await lookup(item.url));
    }),
  );

  return items.map((item) => {
    const preview = previews.get(item.url);
    if (!preview) return item;

    return {
      ...item,
      summary: item.summary ?? preview.description,
      imageUrl: item.imageUrl ?? preview.imageUrl,
      metadata: preview.siteName
        ? { ...(item.metadata ?? {}), siteName: preview.siteName }
        : item.metadata,
    };
  });
};

/**
 * Fetches a preview from linkpreview.net. Returns `null` when the integration is not configured,
 * when the daily budget is exhausted, when the target is obviously internal, or when the provider
 * answers with an error (401/403 invalid key, 423 robots.txt, 426 per-domain limit, 429 quota...).
 */
export const getLinkPreview = async (rawUrl: string): Promise<LinkPreview | null> => {
  if (!env.linkPreviewConfigured) return null;
  if (isObviouslyInternal(rawUrl)) return null;

  const hash = urlHash(rawUrl);
  const cached = await prisma.linkPreviewCache.findUnique({ where: { urlHash: hash } });
  if (cached && cached.expiresAt.getTime() > Date.now()) {
    return {
      url: cached.url,
      title: cached.title,
      description: cached.description,
      imageUrl: cached.imageUrl,
      siteName: cached.siteName,
    };
  }

  const budget = await consumeRateLimit(BUDGET_KEY, env.LINK_PREVIEW_DAILY_LIMIT, 24 * 60 * 60);
  if (!budget.allowed) {
    logger.warn(
      { limit: env.LINK_PREVIEW_DAILY_LIMIT },
      'link preview daily budget exhausted, skipping lookups',
    );
    return null;
  }

  try {
    const request = buildPreviewRequest(rawUrl);
    const response = await safeFetch(request.url, {
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
      accept: 'application/json',
      headers: request.headers,
    });

    if (response.status !== 200) {
      let providerError: unknown = null;
      try {
        providerError = (JSON.parse(response.body) as { error?: unknown }).error ?? null;
      } catch {
        providerError = null;
      }
      const keyRejected = response.status === 401 || response.status === 403;
      if (keyRejected) {
        logger.error(
          { status: response.status, providerError },
          'link preview API key was rejected, check LINK_PREVIEW_API_KEY',
        );
      } else {
        logger.warn(
          { status: response.status, providerError },
          'link preview provider returned an error',
        );
      }
      return null;
    }

    const payload = JSON.parse(response.body) as Record<string, unknown>;
    const preview: LinkPreview = {
      url: rawUrl,
      title: asString(payload.title),
      description: asString(payload.description),
      imageUrl: httpUrlOrNull(payload.image),
      siteName: asString(payload.site_name ?? payload.siteName),
    };

    if (!preview.title && !preview.description && !preview.imageUrl) return null;

    await prisma.linkPreviewCache.upsert({
      where: { urlHash: hash },
      create: {
        urlHash: hash,
        url: preview.url,
        title: preview.title,
        description: preview.description,
        imageUrl: preview.imageUrl,
        siteName: preview.siteName,
        expiresAt: addDays(new Date(), CACHE_TTL_DAYS),
      },
      update: {
        title: preview.title,
        description: preview.description,
        imageUrl: preview.imageUrl,
        siteName: preview.siteName,
        fetchedAt: new Date(),
        expiresAt: addDays(new Date(), CACHE_TTL_DAYS),
      },
    });

    return preview;
  } catch (error) {
    logger.warn({ err: error }, 'link preview lookup failed');
    return null;
  }
};
