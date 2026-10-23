/**
 * Drives the same Chrome MCP command the desktop saves as `chrome-jr`.
 *
 * Arguments match `createChromeDraft` in
 * packages/desktop/src/renderer/pages/Jr/Connections/connections.ts.
 *
 *   node scripts/jr/check-chrome-connector.mjs
 *
 * Exits 0 only when Chrome opened, navigated to https://example.com, and the
 * page title was read back through the connector. This does not start Electron
 * or a model; it checks the connector the bot launches.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_MCP_VERSION = '1.12.0';
const TARGET = 'https://example.com';
const profile = await mkdtemp(join(tmpdir(), 'jr-chrome-check-'));
const args = [
  '-y',
  `chrome-devtools-mcp@${CHROME_MCP_VERSION}`,
  `--user-data-dir=${profile}/jr-chrome-profile`,
  '--no-usage-statistics',
  '--no-performance-crux',
  '--no-category-performance',
  '--no-category-network',
  '--no-category-emulation',
  '--no-category-memory',
];

const child = spawn('npx', args, { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
});

let buffer = '';
const pending = new Map();
let nextId = 1;
const closed = new Promise((resolve) => child.once('exit', resolve));

function fail(message) {
  const detail = stderr.trim();
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ jsonrpc: '2.0', id, method, params });
  return result;
}

function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  if (buffer.length > 8 * 1024 * 1024) fail('Chrome connector sent more than 8 MB without a complete message');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined || !pending.has(message.id)) continue;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  fail('Chrome connector timed out');
}, 120_000);
timeout.unref();

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'jr-chrome-check', version: '1.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await request('tools/list', {});
  const names = (listed.tools ?? []).map((tool) => tool.name);
  if (!names.includes('new_page') || !names.includes('navigate_page')) {
    fail(`navigation tools missing from ${names.join(', ')}`);
  }
  const reader = ['take_snapshot', 'evaluate_script'].find((name) => names.includes(name));
  if (!reader) fail(`no page reader in ${names.join(', ')}`);
  const opened = await request('tools/call', { name: 'new_page', arguments: { url: TARGET } });
  if (opened.isError) fail(`new_page failed: ${textOf(opened)}`);
  const openedText = textOf(opened);
  const pageMatch = /^(\d+):/m.exec(openedText);
  if (!pageMatch) fail(`new_page did not report a page id:\n${openedText.slice(0, 500)}`);
  const pageId = Number(pageMatch[1]);
  const navigated = await request('tools/call', {
    name: 'navigate_page',
    arguments: { pageId, type: 'url', url: TARGET },
  });
  if (navigated.isError) fail(`navigate_page failed: ${textOf(navigated)}`);
  const read = await request('tools/call', {
    name: reader,
    arguments: reader === 'evaluate_script' ? { pageId, function: '() => document.title' } : { pageId },
  });
  if (read.isError) fail(`${reader} failed: ${textOf(read)}`);
  const page = `${openedText}\n${textOf(navigated)}\n${textOf(read)}`;
  if (!page.includes('Example Domain')) fail(`page text did not include the example title:\n${page.slice(0, 800)}`);
  console.log(JSON.stringify({ ok: true, navigated: TARGET, pageId, reader, title: 'Example Domain' }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill('SIGTERM');
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
