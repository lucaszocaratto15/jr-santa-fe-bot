import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Forward Strata's MCP envelope once, retaining errors and avoiding escaped copies of large query results. */
export function controlMcpResult(tool: string, text: string, httpOk: boolean): CallToolResult {
  let strataError = false;
  if (tool.startsWith('strata_')) {
    try {
      const result = JSON.parse(text);
      strataError = result?.isError === true || result?.ok === false;
      if (tool === 'strata_call_tool' && httpOk && Array.isArray(result?.content)) {
        const parsed = CallToolResultSchema.parse(result);
        return { ...parsed, isError: strataError };
      }
    } catch {
      strataError = true;
    }
  }
  return { content: [{ type: 'text', text }], isError: !httpOk || strataError };
}
