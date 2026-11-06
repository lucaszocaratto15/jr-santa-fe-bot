import { httpError } from '../validation.mjs';

const loopback = (url) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);

/** Fixed administrator configuration, never values from an HTTP request. */
export function parseStrataConfiguration(value) {
  if (
    !value ||
    !['resourceUrl', 'issuer', 'clientId', 'clientSecret', 'redirectUri', 'encryptionKey'].every((key) => value[key])
  )
    return null;
  try {
    const trustedUrl = (raw) => {
      const url = new URL(raw);
      if (
        (url.protocol !== 'https:' &&
          !(value.allowInsecureTest === true && url.protocol === 'http:' && loopback(url))) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url;
    };
    const resource = trustedUrl(value.resourceUrl);
    const issuer = trustedUrl(value.issuer);
    const redirect = trustedUrl(value.redirectUri);
    if (!resource.pathname.endsWith('/mcp') || !redirect.pathname.endsWith('/strata/callback')) throw new Error();
    if (
      typeof value.clientId !== 'string' ||
      !/^[\x21-\x7e]{1,200}$/u.test(value.clientId) ||
      value.clientId.includes(':')
    )
      throw new Error();
    if (
      typeof value.clientSecret !== 'string' ||
      value.clientSecret.length < 16 ||
      value.clientSecret.length > 4096 ||
      [...value.clientSecret].some((character) => [0, 10, 13].includes(character.charCodeAt(0)))
    )
      throw new Error();
    if (typeof value.encryptionKey !== 'string' || !/^(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/iu.test(value.encryptionKey))
      throw new Error();
    const key = /^[a-f0-9]{64}$/iu.test(value.encryptionKey)
      ? Buffer.from(value.encryptionKey, 'hex')
      : Buffer.from(value.encryptionKey, 'base64');
    if (key.length !== 32) throw new Error();
    const scopes = [
      ...new Set(
        String(value.scopes || 'mcp:identidade')
          .split(/\s+/u)
          .filter(Boolean)
      ),
    ];
    if (
      !scopes.length ||
      scopes.length > 30 ||
      scopes.some((scope) => !/^[A-Za-z0-9:._/-]{1,100}$/u.test(scope)) ||
      !scopes.includes('mcp:identidade')
    )
      throw new Error();
    return {
      resourceUrl: resource.toString().replace(/\/$/u, ''),
      issuer: issuer.toString().replace(/\/$/u, ''),
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      redirectUri: redirect.toString(),
      encryptionKey: key,
      scopes,
      allowInsecureTest: value.allowInsecureTest === true,
    };
  } catch {
    throw httpError(500, 'strata_invalid_configuration');
  }
}

/** Metadata cannot redirect credentials to another origin. */
export function issuerEndpoint(config, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(503, 'strata_invalid_metadata');
  }
  if (
    url.origin !== new URL(config.issuer).origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !['https:', ...(config.allowInsecureTest ? ['http:'] : [])].includes(url.protocol)
  )
    throw httpError(503, 'strata_invalid_metadata');
  return url.toString();
}
