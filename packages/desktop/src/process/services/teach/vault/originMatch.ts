/** Reduce a URL or bare host to `scheme://host[:port]`; null when it is not a web origin. */
export function normalizeOrigin(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** True only when the page's origin equals one of the allowed origins exactly. */
export function originAllowed(pageUrl: string, origins: string[]): boolean {
  let pageOrigin: string;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    pageOrigin = url.origin;
  } catch {
    return false;
  }
  return origins.some((origin) => normalizeOrigin(origin) === pageOrigin);
}
