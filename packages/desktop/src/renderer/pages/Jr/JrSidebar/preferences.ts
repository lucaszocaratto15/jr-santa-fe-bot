import { sanitizeSidebarLayout, type SidebarLayout } from './groupBots';

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
const SPELLCHECK_KEY = 'jr.spellcheck';
const SIDEBAR_KEY = 'jr.sidebarLayout';

export const SPELLCHECK_EVENT = 'jr-spellcheck-change';

/** Local composer preference. `allow` is the default until the user picks `ask`. */
export type ExecutionPreference = 'allow' | 'ask';

/**
 * Saved only in the renderer. Codex can replace this reader when execution
 * policy is exposed by the desktop process. It does not change the agent engine today.
 */
export function readExecutionPreference(store: KeyValueStore = browserStore()): ExecutionPreference {
  return store.getItem(EXECUTION_KEY) === 'ask' ? 'ask' : 'allow';
}

export function writeExecutionPreference(value: ExecutionPreference, store: KeyValueStore = browserStore()): void {
  store.setItem(EXECUTION_KEY, value);
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

/** Pins, row order, and collapsed sections. Corrupt JSON reads as an empty layout. */
export function readSidebarLayout(store: KeyValueStore = browserStore()): SidebarLayout {
  const raw = store.getItem(SIDEBAR_KEY);
  if (!raw) return { pinnedIds: [], order: [], collapsed: {} };
  try {
    return sanitizeSidebarLayout(JSON.parse(raw));
  } catch {
    return { pinnedIds: [], order: [], collapsed: {} };
  }
}

export function writeSidebarLayout(layout: SidebarLayout, store: KeyValueStore = browserStore()): void {
  store.setItem(SIDEBAR_KEY, JSON.stringify(sanitizeSidebarLayout(layout)));
}

export type ComputerIdentity = {
  hostname: string | null;
  source: 'mock';
};

/** The renderer has no hostname bridge. Replace this when the desktop process exposes one. */
export function readComputerIdentity(): ComputerIdentity {
  return { hostname: null, source: 'mock' };
}
