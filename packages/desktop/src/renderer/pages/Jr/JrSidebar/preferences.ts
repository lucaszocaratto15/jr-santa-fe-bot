export type KeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

const memory = new Map<string, string>();

const memoryStore: KeyValueStore = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
};

export function browserStore(): KeyValueStore {
  if (typeof localStorage === 'undefined') return memoryStore;
  return localStorage;
}

const EXECUTION_KEY = 'jr.executionPreference';
const ROUTE_KEY = 'jr.routeTraffic';
const SPELLCHECK_KEY = 'jr.spellcheck';

export const SPELLCHECK_EVENT = 'jr-spellcheck-change';

/** Local composer preference. `allow` is the default until the user picks `ask`. */
export type ExecutionPreference = 'allow' | 'ask';

/**
 * Saved only in the renderer. Codex can replace these readers when execution
 * policy and traffic routing are exposed by the desktop process. They do not
 * change the agent engine today.
 */
export function readExecutionPreference(store: KeyValueStore = browserStore()): ExecutionPreference {
  return store.getItem(EXECUTION_KEY) === 'ask' ? 'ask' : 'allow';
}

export function writeExecutionPreference(value: ExecutionPreference, store: KeyValueStore = browserStore()): void {
  store.setItem(EXECUTION_KEY, value);
}

export function readRouteTraffic(store: KeyValueStore = browserStore()): boolean {
  return store.getItem(ROUTE_KEY) === '1';
}

export function writeRouteTraffic(enabled: boolean, store: KeyValueStore = browserStore()): void {
  store.setItem(ROUTE_KEY, enabled ? '1' : '0');
}

export function readSpellcheck(store: KeyValueStore = browserStore()): boolean {
  const value = store.getItem(SPELLCHECK_KEY);
  if (value == null) return true;
  return value === '1';
}

export function writeSpellcheck(enabled: boolean, store: KeyValueStore = browserStore()): void {
  store.setItem(SPELLCHECK_KEY, enabled ? '1' : '0');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SPELLCHECK_EVENT));
}

export type ComputerIdentity = {
  hostname: string | null;
  source: 'mock';
};

/** The renderer has no hostname bridge. Replace this when the desktop process exposes one. */
export function readComputerIdentity(): ComputerIdentity {
  return { hostname: null, source: 'mock' };
}
