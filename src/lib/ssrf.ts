import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
]);

const ipv4ToNumber = (ip: string): number =>
  ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

const isPrivateIpv4 = (ip: string): boolean => {
  const value = ipv4ToNumber(ip);
  const inRange = (cidr: string, bits: number): boolean => {
    const base = ipv4ToNumber(cidr);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) ||
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) ||
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.0.2.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('198.51.100.0', 24) ||
    inRange('203.0.113.0', 24) ||
    inRange('224.0.0.0', 4) ||
    inRange('240.0.0.0', 4)
  );
};

const isPrivateIpv6 = (ip: string): boolean => {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  return false;
};

export const isPrivateAddress = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true;
};

export const assertPublicHttpUrl = async (rawUrl: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 'Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new AppError('BAD_REQUEST', 'URLs with embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new AppError('BAD_REQUEST', 'URL host is not allowed');
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new AppError('BAD_REQUEST', 'URL host is not allowed');
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new AppError('BAD_REQUEST', 'URL host could not be resolved');
  }
  if (addresses.length === 0) {
    throw new AppError('BAD_REQUEST', 'URL host could not be resolved');
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new AppError('BAD_REQUEST', 'URL host is not allowed');
  }

  return url;
};

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  body: string;
  finalUrl: string;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  accept?: string;
  /**
   * Stop reading once this many feed items have arrived. Podcast feeds can be several
   * megabytes but only the newest entries are used, so the connection is closed early
   * instead of downloading (and then discarding) the whole document.
   */
  stopAfterItems?: number;
}

const countClosedItems = (chunk: string): number =>
  (chunk.match(/<\/item>/gi)?.length ?? 0) + (chunk.match(/<\/entry>/gi)?.length ?? 0);

const readLimited = async (
  response: Response,
  maxBytes: number,
  stopAfterItems?: number,
): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  let items = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError('PAYLOAD_TOO_LARGE', 'Remote response exceeded the size limit');
    }

    const chunk = decoder.decode(value, { stream: true });
    text += chunk;

    if (stopAfterItems) {
      items += countClosedItems(chunk);
      if (items >= stopAfterItems) {
        await reader.cancel();
        break;
      }
    }
  }

  return text + decoder.decode();
};

/**
 * Fetches a remote resource with SSRF protections: protocol allowlist, DNS resolution checks,
 * manual redirect validation and hard limits on time and response size.
 */
export const safeFetch = async (
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> => {
  const { timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3 } = options;

  let current = await assertPublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept:
          options.accept ??
          'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
        'user-agent': 'BuzzAndBugsBot/1.0 (+https://buzzandbugs.local)',
        ...options.headers,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          status: response.status,
          headers: response.headers,
          body: '',
          finalUrl: current.toString(),
        };
      }
      const next = new URL(location, current).toString();
      current = await assertPublicHttpUrl(next);
      continue;
    }

    const body = await readLimited(response, maxBytes, options.stopAfterItems);
    return {
      status: response.status,
      headers: response.headers,
      body,
      finalUrl: current.toString(),
    };
  }

  throw new AppError('BAD_REQUEST', 'Too many redirects');
};
