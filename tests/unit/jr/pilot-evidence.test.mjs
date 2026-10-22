import assert from 'node:assert/strict';
import test from 'node:test';
import { hasLocalExecution, approvalWaitingMs, summarizeTurnTiming } from '../../../scripts/jr/pilot-support.mjs';

test('approval time is measured from observations even without terminal input and never double-counted', () => {
  assert.equal(
    approvalWaitingMs(
      [
        { at: 100, pending: 0 },
        { at: 120, pending: 2 },
        { at: 150, pending: 1 },
        { at: 180, pending: 0 },
      ],
      200
    ),
    60
  );
  assert.equal(approvalWaitingMs([{ at: 120, pending: 1 }], 200), 80);
});

test('provider first text and agent first text use independent observed timestamps', () => {
  const result = summarizeTurnTiming(
    100,
    200,
    [
      { type: 'thinking', receivedAt: 110 },
      { type: 'content', receivedAt: 140, data: { content: 'Olá' } },
    ],
    [{ started: 105, firstTextMs: 20 }],
    [
      { at: 160, pending: 1 },
      { at: 180, pending: 0 },
    ]
  );
  assert.equal(result.firstApiTextMs, 25);
  assert.equal(result.firstAgentTextMs, 40);
  assert.equal(result.processingMs, 80);
});

test('an assistant claim or a file write does not prove code execution', () => {
  assert.equal(hasLocalExecution([{ type: 'content', data: 'I executed calcular.mjs successfully' }]), false);
  assert.equal(hasLocalExecution([{ type: 'tool_call', data: { name: 'Write', status: 'completed' } }]), false);
});

test('requires the requested local command and a successful tool result', () => {
  const start = {
    type: 'tool_call',
    data: {
      call_id: '1',
      name: 'ExecCommand',
      status: 'running',
      args: { cmd: '/opt/homebrew/bin/node calcular.mjs' },
    },
  };
  const end = {
    type: 'tool_call',
    data: { call_id: '1', name: 'ExecCommand', status: 'completed', output: 'Exit code: 0\nSTDOUT: result' },
  };
  assert.equal(hasLocalExecution([start, end]), true);
  assert.equal(hasLocalExecution([start, { ...end, data: { ...end.data, status: 'error' } }]), false);
  assert.equal(hasLocalExecution([{ ...start, data: { ...start.data, args: { cmd: 'echo success' } } }, end]), false);
});
