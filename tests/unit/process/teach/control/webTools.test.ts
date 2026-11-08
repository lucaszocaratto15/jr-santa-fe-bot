import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, createWebTools, parseDuckDuckGo } from '@process/services/teach/control/webTools';

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example <b>A</b></a>
  <a class="result__snippet" href="#">Snippet <b>one</b> &amp; more</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://example.org/b">Example B</a>
  <a class="result__snippet">Snippet two</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://example.com/a?x=1">Duplicate</a>
  <a class="result__snippet">Duplicate</a>
</div>`;

const lookup = async (hostname: string) =>
  hostname === 'private.test'
    ? [{ address: '10.0.0.5', family: 4 }]
    : hostname === 'ipv6.test'
      ? [{ address: '2606:4700:4700::1111', family: 6 }]
      : [{ address: '93.184.216.34', family: 4 }];

const htmlResponse = (body: string, contentType = 'text/html; charset=utf-8') =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

describe('parseDuckDuckGo', () => {
  it('extracts, unwraps, decodes and dedupes results', () => {
    const results = parseDuckDuckGo(DDG_HTML, 5);
    expect(results).toEqual([
      { title: 'Example A', url: 'https://example.com/a?x=1', snippet: 'Snippet one & more' },
      { title: 'Example B', url: 'https://example.org/b', snippet: 'Snippet two' },
    ]);
  });

  it('respects the result limit', () => {
    expect(parseDuckDuckGo(DDG_HTML, 1)).toHaveLength(1);
  });
});

describe('assertPublicUrl', () => {
  it('accepts public hosts and rejects private or unsupported ones', async () => {
    await expect(assertPublicUrl('https://public.test/page', lookup)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://ipv6.test/page', lookup)).resolves.toBeInstanceOf(URL);

    for (const blocked of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://private.test/',
      'http://localhost/',
      'http://printer.local/',
    ]) {
      await expect(assertPublicUrl(blocked, lookup)).rejects.toMatchObject({ code: 'blocked_url' });
    }

    for (const invalid of ['file:///etc/passwd', 'ftp://public.test/', 'https://user:pass@public.test/', '', 'nope']) {
      await expect(assertPublicUrl(invalid, lookup)).rejects.toMatchObject({ code: 'invalid_url' });
    }
  });
});

describe('createWebTools', () => {
  it('searches DuckDuckGo and caches identical queries', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(DDG_HTML));
    const tools = createWebTools({ fetch: fetchMock as unknown as typeof fetch, lookup, now: () => 1_000 });

    const first = await tools.search({ query: 'teste', limit: 2 });
    expect(first).toMatchObject({ ok: true, provider: 'duckduckgo', cached: false });
    if (first.ok) expect(first.results).toHaveLength(2);

    const second = await tools.search({ query: 'teste', limit: 2 });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid queries and enforces the per-minute budget', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(DDG_HTML));
    const tools = createWebTools({
      fetch: fetchMock as unknown as typeof fetch,
      lookup,
      now: () => 1_000,
      searchPerMinute: 1,
    });

    await expect(tools.search({ query: '' })).resolves.toMatchObject({ ok: false, error: 'invalid_query' });
    await expect(tools.search({ query: 'a'.repeat(301) })).resolves.toMatchObject({
      ok: false,
      error: 'invalid_query',
    });
    await expect(tools.search({ query: 'um' })).resolves.toMatchObject({ ok: true });
    await expect(tools.search({ query: 'dois' })).resolves.toMatchObject({ ok: false, error: 'web_rate_limited' });
  });

  it('fetches and extracts the main text without scripts or navigation', async () => {
    const page =
      '<html><head><title>Doc</title></head><body><nav>menu</nav><script>alert(1)</script><h1>Oi</h1><p>Texto &amp; mais</p><footer>rodape</footer></body></html>';
    const fetchMock = vi.fn(async () => htmlResponse(page));
    const tools = createWebTools({ fetch: fetchMock as unknown as typeof fetch, lookup, now: () => 1_000 });

    const result = await tools.fetchPage({ url: 'https://public.test/doc' });
    expect(result).toMatchObject({ ok: true, title: 'Doc', truncated: false });
    if (result.ok) {
      expect(result.text).toContain('Oi');
      expect(result.text).toContain('Texto & mais');
      expect(result.text).not.toContain('alert');
      expect(result.text).not.toContain('menu');
      expect(result.text).not.toContain('rodape');
    }
  });

  it('revalidates redirects and blocks a private hop', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    );
    const tools = createWebTools({ fetch: fetchMock as unknown as typeof fetch, lookup, now: () => 1_000 });

    await expect(tools.fetchPage({ url: 'https://public.test/start' })).resolves.toMatchObject({
      ok: false,
      error: 'blocked_url',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects binary content and truncates very long pages', async () => {
    const binary = createWebTools({
      fetch: vi.fn(async () => htmlResponse('%PDF-1.7', 'application/pdf')) as unknown as typeof fetch,
      lookup,
      now: () => 1_000,
    });
    await expect(binary.fetchPage({ url: 'https://public.test/file.pdf' })).resolves.toMatchObject({
      ok: false,
      error: 'unsupported_content_type',
    });

    const big = createWebTools({
      fetch: vi.fn(async () =>
        htmlResponse(`<html><title>Big</title><body><p>${'a'.repeat(25_000)}</p></body></html>`)
      ) as unknown as typeof fetch,
      lookup,
      now: () => 1_000,
    });
    const result = await big.fetchPage({ url: 'https://public.test/big' });
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.text.length).toBeLessThanOrEqual(20_000);
  });
});
