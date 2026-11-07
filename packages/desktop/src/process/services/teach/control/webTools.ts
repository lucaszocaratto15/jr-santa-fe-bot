/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side internet tools for the JR agent: DuckDuckGo HTML search and a bounded page
 * reader. No browser, no Chrome and no renderer involvement, so a search never hijacks the
 * in-app browser shown in the main window.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_SEARCH_BYTES = 1_500_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 20_000;
const SEARCH_TIMEOUT_MS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type LookupResult = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupResult[]>;

export type WebToolsDeps = {
  fetch?: typeof fetch;
  lookup?: Lookup;
  now?: () => number;
  searchTtlMs?: number;
  fetchTtlMs?: number;
  searchPerMinute?: number;
  fetchPerMinute?: number;
};

export type WebSearchItem = { title: string; url: string; snippet: string };

export type WebSearchResponse =
  | { ok: true; query: string; provider: 'duckduckgo'; results: WebSearchItem[]; cached: boolean }
  | { ok: false; error: string };

export type WebFetchResponse =
  | { ok: true; url: string; title: string; text: string; truncated: boolean; cached: boolean }
  | { ok: false; error: string };

type WebError = Error & { code: string };

const webError = (code: string): WebError => Object.assign(new Error(code), { code });

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const decodeEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

const stripTags = (value: string): string =>
  decodeEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const unwrapDuckDuckGo = (href: string): string => {
  const clean = decodeEntities(href.trim());
  if (!clean.startsWith('//duckduckgo.com/l/') && !clean.startsWith('https://duckduckgo.com/l/')) return clean;
  try {
    const url = new URL(clean.startsWith('//') ? `https:${clean}` : clean);
    return url.searchParams.get('uddg') || clean;
  } catch {
    return clean;
  }
};

/** Parses the HTML and lite DuckDuckGo result pages into ranked results. */
export function parseDuckDuckGo(html: string, limit: number): WebSearchItem[] {
  const links = [
    ...html.matchAll(
      /<a[^>]+(?:class="[^"]*(?:result__a|result-link)[^"]*"|class='[^']*(?:result__a|result-link)[^']*')[^>]*href=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi
    ),
  ];
  const snippets = [
    ...html.matchAll(
      /<(?:a|td|div)[^>]+class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi
    ),
  ];
  const items: WebSearchItem[] = [];
  const seen = new Set<string>();
  for (const [index, match] of links.entries()) {
    const url = unwrapDuckDuckGo(match[2]);
    const title = stripTags(match[3]);
    if (!/^https?:\/\//i.test(url) || !title || seen.has(url)) continue;
    seen.add(url);
    items.push({ title, url, snippet: stripTags(snippets[index]?.[1] ?? '') });
    if (items.length >= limit) break;
  }
  return items;
}

const isIpv4 = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

const isPrivateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const isPrivateAddress = (address: string): boolean => {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpv4(host)) return isPrivateIpv4(host);
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('::ffff:')) return isPrivateIpv4(host.slice('::ffff:'.length));
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (/^2001:db8:/i.test(host)) return true;
  return false;
};

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
]);

/** Rejects non-web schemes, credentials and any host that resolves to a private address. */
export async function assertPublicUrl(raw: unknown, lookup: Lookup): Promise<URL> {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw webError('invalid_url');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw webError('invalid_url');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
    throw webError('invalid_url');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.localhost'))
    throw webError('blocked_url');
  if (isIpv4(host) || host.includes(':')) {
    if (isPrivateAddress(host)) throw webError('blocked_url');
    return url;
  }
  let addresses: LookupResult[];
  try {
    addresses = await lookup(host);
  } catch {
    throw webError('blocked_url');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw webError('blocked_url');
  return url;
}

const readBounded = async (response: Response, maxBytes: number): Promise<string> => {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw webError('web_response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // Reads are ordered; concurrent reads would defeat the size bound.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw webError('web_response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
};

const requestText = async (
  fetchImpl: typeof fetch,
  rawUrl: string,
  init: RequestInit,
  maxBytes: number,
  lookup: Lookup,
  timeoutMs: number
): Promise<{ text: string; finalUrl: string; contentType: string }> => {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, lookup);
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw webError('web_unavailable');
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw webError('web_unavailable');
    }
    const text = await readBounded(response, maxBytes);
    return { text, finalUrl: url.toString(), contentType: response.headers.get('content-type') ?? '' };
  }
  throw webError('web_unavailable');
};

const extractPage = (html: string): { title: string; text: string } => {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside|form)[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const text = decodeEntities(cleaned.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
};

type CacheEntry<T> = { value: T; expiresAt: number };

const takeToken = (bucket: { tokens: number; updatedAt: number }, perMinute: number, now: number): void => {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(perMinute, bucket.tokens + (elapsed / 60_000) * perMinute);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) throw webError('web_rate_limited');
  bucket.tokens -= 1;
};

export function createWebTools(deps: WebToolsDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const lookup: Lookup = deps.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const now = deps.now ?? Date.now;
  const searchTtl = deps.searchTtlMs ?? 5 * 60_000;
  const fetchTtl = deps.fetchTtlMs ?? 10 * 60_000;
  const searchPerMinute = deps.searchPerMinute ?? 20;
  const fetchPerMinute = deps.fetchPerMinute ?? 30;
  const cache = new Map<string, CacheEntry<unknown>>();
  const searchBucket = { tokens: searchPerMinute, updatedAt: now() };
  const fetchBucket = { tokens: fetchPerMinute, updatedAt: now() };

  const readCache = <T>(key: string): T | null => {
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  };
  const writeCache = <T>(key: string, value: T, ttl: number): void => {
    if (cache.size >= 200) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: now() + ttl });
  };

  const search = async (input: unknown): Promise<WebSearchResponse> => {
    const query = record(input) && typeof input.query === 'string' ? input.query.trim() : '';
    const limit = record(input) && typeof input.limit === 'number' && Number.isInteger(input.limit) ? input.limit : 5;
    if (!query || query.length > 300 || limit < 1 || limit > 10) return { ok: false, error: 'invalid_query' };
    const key = `search:${query.toLowerCase()}:${limit}`;
    const cached = readCache<WebSearchItem[]>(key);
    if (cached) return { ok: true, query, provider: 'duckduckgo', results: cached, cached: true };
    try {
      takeToken(searchBucket, searchPerMinute, now());
      let text = '';
      try {
        const result = await requestText(
          fetchImpl,
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt`,
          {
            headers: {
              'user-agent': USER_AGENT,
              'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
              accept: 'text/html',
            },
          },
          MAX_SEARCH_BYTES,
          lookup,
          SEARCH_TIMEOUT_MS
        );
        text = result.text;
      } catch {
        const result = await requestText(
          fetchImpl,
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
          { headers: { 'user-agent': USER_AGENT, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8', accept: 'text/html' } },
          MAX_SEARCH_BYTES,
          lookup,
          SEARCH_TIMEOUT_MS
        );
        text = result.text;
      }
      const results = parseDuckDuckGo(text, limit);
      writeCache(key, results, searchTtl);
      return { ok: true, query, provider: 'duckduckgo', results, cached: false };
    } catch (error) {
      return { ok: false, error: error instanceof Error && 'code' in error ? String(error.code) : 'web_unavailable' };
    }
  };

  const fetchPage = async (input: unknown): Promise<WebFetchResponse> => {
    const rawUrl = record(input) && typeof input.url === 'string' ? input.url.trim() : '';
    if (!rawUrl) return { ok: false, error: 'invalid_url' };
    const cached = readCache<{ url: string; title: string; text: string; truncated: boolean }>(`page:${rawUrl}`);
    if (cached) return { ok: true, ...cached, cached: true };
    try {
      takeToken(fetchBucket, fetchPerMinute, now());
      const result = await requestText(
        fetchImpl,
        rawUrl,
        {
          headers: {
            'user-agent': USER_AGENT,
            'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          },
        },
        MAX_PAGE_BYTES,
        lookup,
        FETCH_TIMEOUT_MS
      );
      if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(result.contentType))
        throw webError('unsupported_content_type');
      const extracted = extractPage(result.text);
      const truncated = extracted.text.length > MAX_TEXT_CHARS;
      const page = {
        url: result.finalUrl,
        title: extracted.title,
        text: truncated ? extracted.text.slice(0, MAX_TEXT_CHARS) : extracted.text,
        truncated,
      };
      writeCache(`page:${rawUrl}`, page, fetchTtl);
      return { ok: true, ...page, cached: false };
    } catch (error) {
      return { ok: false, error: error instanceof Error && 'code' in error ? String(error.code) : 'web_unavailable' };
    }
  };

  return { search, fetchPage };
}

export type WebTools = ReturnType<typeof createWebTools>;
