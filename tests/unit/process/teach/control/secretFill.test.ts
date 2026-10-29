import { describe, expect, it, vi } from 'vitest';
import { fillFocused, FOCUS_CHECK_EXPRESSION } from '@process/services/teach/control/secretFill';

const SECRET = 'S3nh@-Sup3r-Secreta';

type Focus = { editable: boolean; isPassword: boolean };

const makeDeps = (focus: Focus, url = 'https://portal.gov.br/login') => {
  const calls: string[] = [];
  const bridge = {
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: focus } };
      return {};
    }),
    addSecret: vi.fn((_id: number, _value: string) => {
      calls.push('addSecret');
    }),
  };
  return { deps: { bridge, currentUrl: () => url, webContentsId: () => 7 }, bridge, calls };
};

describe('fillFocused', () => {
  it('refuses a look-alike domain that is not one of the item origins', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true }, 'https://portal.gov.br.evil.com/login');
    const result = await fillFocused(deps, SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
    expect(result).toEqual({ ok: false, error: 'domínio não autorizado para este item do cofre' });
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(bridge.addSecret).not.toHaveBeenCalled();
  });

  it('refuses when the focused element is not editable', async () => {
    const { deps, bridge } = makeDeps({ editable: false, isPassword: false });
    const result = await fillFocused(deps, SECRET, { requirePassword: false });
    expect(result).toEqual({ ok: false, error: 'clique no campo antes de preencher' });
    expect(bridge.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
    expect(bridge.addSecret).not.toHaveBeenCalled();
  });

  it('refuses to type a password into a non-password field', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: false });
    const result = await fillFocused(deps, SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
    expect(result).toEqual({ ok: false, error: 'o campo focado não é de senha' });
    expect(bridge.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('registers the secret for redaction before inserting it once', async () => {
    const { deps, bridge, calls } = makeDeps({ editable: true, isPassword: true });
    const result = await fillFocused(deps, SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
    expect(result).toEqual({ ok: true });
    const inserts = bridge.sendCommand.mock.calls.filter(([method]) => method === 'Input.insertText');
    expect(inserts).toEqual([['Input.insertText', { text: SECRET }]]);
    expect(bridge.addSecret).toHaveBeenCalledWith(7, SECRET);
    expect(calls.indexOf('addSecret')).toBeLessThan(calls.indexOf('Input.insertText'));
  });

  it('never returns the value, on success or failure', async () => {
    const ok = await fillFocused(makeDeps({ editable: true, isPassword: true }).deps, SECRET, {
      requirePassword: true,
    });
    const bad = await fillFocused(makeDeps({ editable: true, isPassword: false }).deps, SECRET, {
      requirePassword: true,
    });
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it('checks focus with a by-value expression that never reads .value', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: false });
    await fillFocused(deps, 'otp-123456', { requirePassword: false });
    const evaluate = bridge.sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate');
    expect(evaluate?.[1]).toMatchObject({ expression: FOCUS_CHECK_EXPRESSION, returnByValue: true });
    expect(FOCUS_CHECK_EXPRESSION).not.toMatch(/\.value\b/);
  });

  it('refuses when the page navigated off the allowed origin during the focus check', async () => {
    const urls = ['https://portal.gov.br/login', 'https://evil.com/'];
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true });
    const result = await fillFocused({ ...deps, currentUrl: () => urls.shift() ?? 'https://evil.com/' }, SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
    expect(result).toEqual({ ok: false, error: 'domínio não autorizado para este item do cofre' });
    expect(bridge.addSecret).not.toHaveBeenCalled();
  });

  it('reports a fixed error when the browser is not attached', async () => {
    const { deps } = makeDeps({ editable: true, isPassword: true });
    deps.bridge.sendCommand.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    const result = await fillFocused(deps, SECRET, { requirePassword: true });
    expect(result).toEqual({ ok: false, error: 'navegador do app não está pronto' });
  });

  it('treats a malformed evaluate result as not editable', async () => {
    const { deps } = makeDeps({ editable: true, isPassword: true });
    deps.bridge.sendCommand.mockResolvedValueOnce({ exceptionDetails: {} });
    const result = await fillFocused(deps, SECRET, { requirePassword: false });
    expect(result).toEqual({ ok: false, error: 'clique no campo antes de preencher' });
  });
});
