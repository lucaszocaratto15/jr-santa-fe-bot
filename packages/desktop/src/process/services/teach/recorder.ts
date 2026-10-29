/**
 * Main-process recorder for "Ensinar tarefa": watches the employee demonstrate a task in
 * the in-app browser (through the CDP bridge) and appends events to
 * `<dir>/<id>/events.jsonl`.
 *
 * Secrets: the page never sends a secret value (captureScript.ts), and main re-classifies
 * every field with isSecretField and masks it as `«segredo»` anyway. The recorder never
 * reads a secret from the page; it only remembers the origin in `secretOrigins` so the UI
 * can offer to save a credential (the employee retypes it there).
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import { REDACTED } from '@process/resources/builtinMcp/secretRedact';
import { CAPTURE_BINDING, buildCaptureScript } from './captureScript';
import { isSecretField, type FieldAttrs } from './fieldClassifier';
import { sanitizeUrl } from './urlSanitizer';

export type Locator = {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  attr?: string;
  css?: string;
};

export type TeachEventKind = 'navigate' | 'click' | 'input' | 'submit' | 'key' | 'tab-open' | 'tab-switch' | 'download';

export type TeachEvent = {
  t: number;
  tab: number;
  kind: TeachEventKind;
  url: string;
  target?: Locator[];
  value?: string;
  key?: string;
  fileName?: string;
};

export type RecorderState = 'idle' | 'recording' | 'paused';

export type RecordingResult = { id: string; events: TeachEvent[]; secretOrigins: string[] };

export type Recorder = {
  start(description: string): Promise<{ id: string }>;
  pause(): void;
  resume(): void;
  stop(): Promise<RecordingResult>;
  discard(): Promise<void>;
  /** Remove a finished recording's raw dir (after Save). */
  cleanup(id: string): Promise<void>;
  /** Record a finished download of the in-app browser (no-op unless recording). */
  recordDownload(info: { fileName: string; origin: string }): void;
  state(): RecorderState;
};

export type RecorderDeps = {
  bridge: CdpBridgeHandle;
  dir: string;
  now?: () => number;
  limitMs?: number;
  onAutoStop(): void;
};

/** Hard limit of a recording (10 minutes). */
export const RECORDING_LIMIT_MS = 600_000;
const MAX_VALUE = 500;
const MAX_LOCATORS = 8;
const MAX_LOCATOR_TEXT = 200;
const ID_RE = /^[0-9a-f-]{36}$/;
const LOCATOR_KEYS = ['role', 'name', 'label', 'text', 'placeholder', 'attr', 'css'] as const;
const PAGE_KINDS = new Set(['click', 'input', 'submit', 'key']);

type Session = {
  id: string;
  dir: string;
  startedAt: number;
  events: TeachEvent[];
  secretOrigins: Set<string>;
  tabs: Map<number, number>;
  currentTab: number;
  scriptIds: string[];
  unsubscribe: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  writes: Promise<void>;
  /** Tab events of attaches that happened while paused, pushed on resume. */
  pendingTabEvents: Array<Pick<TeachEvent, 'kind' | 'tab' | 'url'>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
};

/** Keep only known string locator fields (the page is untrusted). */
const sanitizeLocators = (value: unknown): Locator[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: Locator[] = [];
  for (const item of value.slice(0, MAX_LOCATORS)) {
    if (!isRecord(item)) continue;
    const locator: Locator = {};
    for (const key of LOCATOR_KEYS) {
      const text = str(item[key]);
      if (text) locator[key] = text.slice(0, MAX_LOCATOR_TEXT);
    }
    if (Object.keys(locator).length > 0) out.push(locator);
  }
  return out;
};

const sanitizeField = (value: unknown): FieldAttrs | null => {
  if (!isRecord(value)) return null;
  return {
    tag: str(value.tag) ?? '',
    type: str(value.type),
    autocomplete: str(value.autocomplete),
    name: str(value.name),
    id: str(value.id),
    label: str(value.label),
    placeholder: str(value.placeholder),
  };
};

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now;
  const limitMs = deps.limitMs ?? RECORDING_LIMIT_MS;
  const source = buildCaptureScript();
  let current: RecorderState = 'idle';
  let session: Session | null = null;
  let lastResult: RecordingResult | null = null;

  const push = (s: Session, event: Omit<TeachEvent, 't' | 'tab'> & { tab?: number }) => {
    // Every url written to events.jsonl goes through sanitizeUrl (no secrets in query/fragment).
    const full = {
      ...event,
      t: now() - s.startedAt,
      tab: event.tab ?? s.currentTab,
      url: sanitizeUrl(event.url),
    } as TeachEvent;
    s.events.push(full);
    const file = path.join(s.dir, 'events.jsonl');
    s.writes = s.writes.then(() => appendFile(file, `${JSON.stringify(full)}\n`, 'utf8')).catch(() => {});
  };

  const inject = async (s: Session) => {
    try {
      await deps.bridge.sendCommand('Runtime.enable');
      await deps.bridge.sendCommand('Page.enable');
      await deps.bridge.sendCommand('Runtime.addBinding', { name: CAPTURE_BINDING });
      const added = await deps.bridge.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
      const identifier = isRecord(added) ? str(added.identifier) : undefined;
      if (identifier) s.scriptIds.push(identifier);
      await deps.bridge.sendCommand('Runtime.evaluate', { expression: source });
    } catch {
      // Nothing attached or the page went away; re-injected on the next attach.
    }
  };

  const currentHref = async (): Promise<string> => {
    try {
      const res = await deps.bridge.sendCommand('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      const result = isRecord(res) && isRecord(res.result) ? res.result : null;
      return str(result?.value) ?? '';
    } catch {
      return '';
    }
  };

  const onPageEvent = (s: Session, payloadText: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    const kind = str(payload.kind);
    if (!kind || !PAGE_KINDS.has(kind)) return; // paste or anything else is never recorded
    const url = str(payload.url) ?? '';
    const field = sanitizeField(payload.field);
    const secret = payload.secret === true || (field !== null && isSecretField(field));
    const event: Omit<TeachEvent, 't' | 'tab'> = { kind: kind as TeachEventKind, url };
    const target = sanitizeLocators(payload.target);
    if (target) event.target = target;
    if (kind === 'key') {
      const key = str(payload.key);
      if (key !== 'Enter' && key !== 'Tab') return;
      event.key = key;
    }
    if (kind === 'input') {
      event.value = secret ? REDACTED : (str(payload.value) ?? '').slice(0, MAX_VALUE);
    }
    if (secret) {
      const origin = originOf(sanitizeUrl(url));
      if (origin) s.secretOrigins.add(origin);
    }
    push(s, event);
  };

  const onBridgeEvent = (s: Session, method: string, params: unknown) => {
    if (current !== 'recording' || session !== s || !isRecord(params)) return;
    if (method === 'Runtime.bindingCalled') {
      if (params.name !== CAPTURE_BINDING) return;
      const payload = str(params.payload);
      if (payload) onPageEvent(s, payload);
      return;
    }
    if (method === 'Page.frameNavigated' && isRecord(params.frame) && !params.frame.parentId) {
      push(s, { kind: 'navigate', url: str(params.frame.url) ?? '' });
    }
  };

  const onBridgeAttach = async (s: Session, webContentsId: number) => {
    if (session !== s) return;
    const known = s.tabs.get(webContentsId);
    const tab = known ?? s.tabs.size + 1;
    if (known === undefined) s.tabs.set(webContentsId, tab);
    s.currentTab = tab;
    await inject(s);
    if (session !== s) return;
    const event = { kind: known === undefined ? 'tab-open' : 'tab-switch', tab, url: await currentHref() } as const;
    if (session !== s) return;
    if (current === 'recording') push(s, event);
    else s.pendingTabEvents.push(event);
  };

  const teardown = async (s: Session) => {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    for (const off of s.unsubscribe.splice(0)) off();
    deps.bridge.setClientsLocked(false);
    // Best effort on the currently attached page; ids from other tabs fail harmlessly
    // (their binding events are ignored here and never relayed to bridge clients).
    await Promise.allSettled([
      ...s.scriptIds.map((identifier) =>
        deps.bridge.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
      ),
      deps.bridge.sendCommand('Runtime.removeBinding', { name: CAPTURE_BINDING }),
    ]);
    await s.writes;
  };

  /** In-flight stop (manual or auto); concurrent stop()/discard() share it. */
  let finishing: Promise<RecordingResult> | null = null;

  const finish = (): Promise<RecordingResult> => {
    if (finishing) return finishing;
    const s = session;
    if (!s) return lastResult ? Promise.resolve(lastResult) : Promise.reject(new Error('not recording'));
    session = null;
    current = 'idle';
    finishing = (async () => {
      await teardown(s);
      lastResult = { id: s.id, events: [...s.events], secretOrigins: [...s.secretOrigins] };
      return lastResult;
    })().finally(() => {
      finishing = null;
    });
    return finishing;
  };

  const removeDir = async (id: string) => {
    if (!ID_RE.test(id)) throw new Error(`invalid recording id: ${id}`);
    await rm(path.join(deps.dir, id), { recursive: true, force: true });
  };

  return {
    async start(_description) {
      if (session || finishing) throw new Error('a recording is already in progress');
      const id = randomUUID();
      const dir = path.join(deps.dir, id);
      await mkdir(dir, { recursive: true });
      const s: Session = {
        id,
        dir,
        startedAt: now(),
        events: [],
        secretOrigins: new Set(),
        tabs: new Map(),
        currentTab: 1,
        scriptIds: [],
        unsubscribe: [],
        timer: null,
        writes: Promise.resolve(),
        pendingTabEvents: [],
      };
      session = s;
      lastResult = null;
      current = 'recording';
      deps.bridge.setClientsLocked(true, 'recording in progress');
      s.unsubscribe.push(deps.bridge.onEvent((method, params) => onBridgeEvent(s, method, params)));
      s.unsubscribe.push(
        deps.bridge.onAttach((webContentsId) => {
          void onBridgeAttach(s, webContentsId);
        })
      );
      s.timer = setTimeout(() => {
        if (session !== s) return;
        void finish().then(
          () => deps.onAutoStop(),
          () => deps.onAutoStop()
        );
      }, limitMs);

      const attachedId = deps.bridge.attachedWebContentsId();
      if (attachedId !== null) {
        s.tabs.set(attachedId, 1);
        await inject(s);
        const url = await currentHref();
        if (session === s && url) push(s, { kind: 'navigate', url });
      }
      return { id };
    },
    pause() {
      if (current === 'recording') current = 'paused';
    },
    resume() {
      if (current !== 'paused' || !session) return;
      current = 'recording';
      for (const event of session.pendingTabEvents.splice(0)) push(session, event);
    },
    stop: finish,
    async discard() {
      // Covers an active recording, an in-flight (auto-)stop and an already stopped one.
      const result = session || finishing ? await finish() : lastResult;
      if (result) await removeDir(result.id);
      lastResult = null;
    },
    cleanup: removeDir,
    recordDownload(info) {
      const s = session;
      if (!s || current !== 'recording') return;
      push(s, { kind: 'download', url: info.origin, fileName: info.fileName });
    },
    state: () => current,
  };
}
