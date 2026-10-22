import { browserStore, type KeyValueStore } from './preferences';

export const CONNECTOR_IDS = ['gmail', 'chrome', 'calendar', 'files', 'whatsapp'] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];
export type ConnectorStatus = 'connected' | 'disconnected';
export type ConnectorRecord = {
  id: ConnectorId;
  status: ConnectorStatus;
};

const STORAGE_KEY = 'jr.connectors.mock';

function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}

function parseRecords(raw: string | null): ConnectorRecord[] {
  const stored = new Map<string, ConnectorStatus>();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const id = (item as { id?: unknown }).id;
          const status = (item as { status?: unknown }).status;
          if (typeof id === 'string' && (status === 'connected' || status === 'disconnected')) {
            stored.set(id, status);
          }
        }
      }
    } catch {
      // Ignore a corrupt local mock and fall back to the catalog defaults.
    }
  }
  return CONNECTOR_IDS.map((id) => ({
    id,
    status: stored.get(id) ?? (id === 'gmail' ? 'connected' : 'disconnected'),
  }));
}

/**
 * Connector catalog for the settings screen.
 * Status lives in localStorage until a desktop bridge owns real account state.
 * Replace `readConnectorRecords` and `setConnectorStatus` without changing `ConnectorRecord`.
 */
export function readConnectorRecords(store: KeyValueStore = browserStore()): ConnectorRecord[] {
  return parseRecords(store.getItem(STORAGE_KEY));
}

export function setConnectorStatus(
  id: string,
  status: ConnectorStatus,
  store: KeyValueStore = browserStore()
): ConnectorRecord[] {
  const current = readConnectorRecords(store);
  if (!isConnectorId(id)) return current;
  const next = current.map((item) => (item.id === id ? { ...item, status } : item));
  store.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
