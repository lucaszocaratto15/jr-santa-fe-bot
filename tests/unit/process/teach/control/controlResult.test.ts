import { describe, expect, it } from 'vitest';
import { controlMcpResult } from '@/process/resources/builtinMcp/controlResult';

describe('native Strata MCP result forwarding', () => {
  it('preserves a complete query as JSON without nesting another escaped MCP envelope', () => {
    const query = { scope: 'group', result: { data: Array.from({ length: 100 }, (_, id) => ({ id, value: 12.3 })) } };
    const content = [{ type: 'text' as const, text: JSON.stringify(query) }];
    const result = controlMcpResult('strata_call_tool', JSON.stringify({ content }), true);
    expect(result.content).toEqual(content);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(query);
    expect(result.isError).toBe(false);
  });

  it.each([
    ['{"content":[{"type":"text","text":"denied"}],"isError":true}', true],
    ['{"ok":false,"error":"strata_unavailable"}', true],
    ['{"content":[{"type":"text"}]}', true],
    ['not JSON', true],
    ['{"content":[{"type":"text","text":"unauthorized"}]}', false],
  ])('keeps failed or malformed responses as errors: %s', (text, httpOk) => {
    expect(controlMcpResult('strata_call_tool', text, httpOk).isError).toBe(true);
  });

  it('keeps tool discovery and other control responses in their original text form', () => {
    const text = JSON.stringify({ ok: true, tools: [] });
    expect(controlMcpResult('strata_list_tools', text, true)).toEqual({
      content: [{ type: 'text', text }],
      isError: false,
    });
  });
});
