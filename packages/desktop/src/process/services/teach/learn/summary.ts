/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LearnSample } from '@/common/types/agent/learnTypes';
import { redactTitle } from './privacyFilter';

export const LEARN_TICK_MS = 15_000;
export const SUMMARY_MAX_BYTES = 16 * 1024;
/** Label of samples taken while a JR Bot window had focus. */
export const JR_APP_LABEL = 'JR Bot';

const TOP_PAIRS = 40;
const TOP_APPS = 40;
const TOP_BROWSER = 20;
const TOP_TRIPLES = 20;
const MIN_TRIPLE_REPEATS = 3;
/** A gap longer than this (idle, locked, paused) breaks a focus sequence. */
const SEQUENCE_GAP_MS = 5 * 60_000;

export type LearnSummary = {
  text: string;
  timePerApp: Array<{ app: string; minutes: number }>;
  browserOrigins: string[];
  periodStart: number;
  periodEnd: number;
};

/** Collapse whitespace and control characters so a title can never start a new line. */
const flat = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- Untrusted window titles may carry control bytes.
  text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

/** App names keep their wording but lose e-mails, documents and long numbers. */
const cleanApp = (app: string): string => {
  const flattened = flat(app);
  return (
    redactTitle(flattened) ??
    flattened
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\d{4,}/g, '#')
      .slice(0, 120)
  );
};

/** JR browser url → origin + path, with numbers/e-mails in the path redacted. Null for non-web urls. */
function cleanUrl(url: string | undefined): { origin: string; label: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    path = parsed.pathname;
  }
  const cleanPath = redactTitle(path) === null && path.trim() !== '' ? '/…' : (redactTitle(path) ?? '');
  return { origin: parsed.origin, label: `${parsed.origin}${cleanPath === '/' ? '' : cleanPath}` };
}

const minutes = (count: number, tickMs: number): number => Math.round((count * tickMs) / 6_000) / 10;

type Tally = { count: number; visits: number };

function tallyRuns<K extends string>(keys: Array<K | null>): Map<K, Tally> {
  const tally = new Map<K, Tally>();
  let previous: K | null = null;
  for (const key of keys) {
    if (key !== null) {
      const entry = tally.get(key) ?? { count: 0, visits: 0 };
      entry.count += 1;
      if (key !== previous) entry.visits += 1;
      tally.set(key, entry);
    }
    previous = key;
  }
  return tally;
}

const ranked = <K>(tally: Map<K, Tally>): Array<[K, Tally]> =>
  [...tally.entries()].toSorted((a, b) => b[1].count - a[1].count || b[1].visits - a[1].visits);

/** Repeated A→B→C focus switches, counted over consecutive distinct labels. */
function repeatedTriples(samples: LearnSample[], labels: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  let run: string[] = [];
  let lastT = -Infinity;
  for (const [i, sample] of samples.entries()) {
    if (sample.t - lastT > SEQUENCE_GAP_MS) run = [];
    lastT = sample.t;
    const current = labels[i];
    if (run.at(-1) === current) continue;
    run.push(current);
    if (run.length >= 3) {
      const triple = run.slice(-3).join(' → ');
      counts.set(triple, (counts.get(triple) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_TRIPLE_REPEATS)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, TOP_TRIPLES);
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Pure summary of raw samples for the model. Titles go through `redactTitle`; only the
 * JR Bot browser contributes urls (origin + cleaned path). Truncated by dropping the
 * lowest-ranked lines until the text fits `maxBytes`.
 */
export function buildLearnSummary(
  input: LearnSample[],
  opts: { tickMs: number; maxBytes: number }
): LearnSummary {
  const samples = input.toSorted((a, b) => a.t - b.t);
  const periodStart = samples[0]?.t ?? 0;
  const periodEnd = samples.length ? samples[samples.length - 1].t + opts.tickMs : 0;

  const apps = samples.map((sample) => cleanApp(sample.app) || '?');
  const appTally = tallyRuns(apps);
  const timePerApp = ranked(appTally).map(([app, { count }]) => ({ app, minutes: minutes(count, opts.tickMs) }));

  const isJr = (sample: LearnSample) => sample.app === JR_APP_LABEL;
  const titles = samples.map((sample) => (sample.title ? redactTitle(flat(sample.title)) : null));
  const urls = samples.map((sample) => (isJr(sample) ? cleanUrl(sample.url) : null));

  const pairKeys = samples.map((sample, i) => (isJr(sample) ? null : `${apps[i]} | ${titles[i] ?? '(sem título)'}`));
  const browserKeys = samples.map((sample, i) =>
    isJr(sample) && urls[i] ? `${urls[i]!.label} | ${titles[i] ?? '(sem título)'}` : null
  );
  const browserOrigins = [...new Set(urls.filter((url) => url !== null).map((url) => url.origin))].filter((origin) =>
    origin.startsWith('https://')
  );

  const appLines = timePerApp.slice(0, TOP_APPS).map(({ app, minutes: m }) => `- ${app}: ${m}`);
  const pairLines = ranked(tallyRuns(pairKeys))
    .slice(0, TOP_PAIRS)
    .map(([key, tally]) => `- ${key} | ${minutes(tally.count, opts.tickMs)} | ${tally.visits}`);
  const browserLines = ranked(tallyRuns(browserKeys))
    .slice(0, TOP_BROWSER)
    .map(([key, tally]) => `- ${key} | ${minutes(tally.count, opts.tickMs)} | ${tally.visits}`);
  const labels = samples.map((sample, i) =>
    isJr(sample) ? (urls[i]?.label ?? titles[i] ?? JR_APP_LABEL) : apps[i]
  );
  const tripleLines = repeatedTriples(samples, labels).map(([triple, count]) => `- ${triple} (${count}×)`);

  const render = () =>
    [
      `Período (UTC): ${samples.length ? `${iso(periodStart)} a ${iso(periodEnd)}` : 'sem dados'}`,
      `Amostras: ${samples.length} (uma a cada ${Math.round(opts.tickMs / 1000)} s)`,
      '',
      'Tempo por programa (minutos):',
      ...appLines,
      '',
      'Janelas mais usadas (programa | título | minutos | visitas):',
      ...pairLines,
      '',
      'Navegador do JR Bot (endereço | título | minutos | visitas):',
      ...browserLines,
      '',
      'Sequências repetidas (troca de foco):',
      ...tripleLines,
    ].join('\n');

  // Lowest priority first: window pairs, then app list, triples, browser pages.
  const dropOrder = [pairLines, appLines, tripleLines, browserLines];
  let text = render();
  while (Buffer.byteLength(text) > opts.maxBytes) {
    const list = dropOrder.find((lines) => lines.length > 0);
    if (!list) {
      text = Buffer.from(text).subarray(0, opts.maxBytes).toString().replace(/�+$/, '');
      break;
    }
    list.pop();
    text = render();
  }
  return { text, timePerApp, browserOrigins, periodStart, periodEnd };
}
