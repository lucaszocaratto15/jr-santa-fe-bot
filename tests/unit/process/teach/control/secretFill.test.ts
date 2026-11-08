import { describe, expect, it, vi } from 'vitest';
import { fillFocused, FOCUS_CHECK_EXPRESSION } from '@process/services/teach/control/secretFill';

const SECRET = 'S3nh@-Sup3r-Secreta';

type Focus = { editable: boolean; isPassword: boolean };

const makeDeps = (focus: Focus, url = 'https://portal.gov.br/login', locked = false) => {
  const calls: string[] = [];
  const bridge = {
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: focus } };
      return {};
    }),
    addSecret: vi.fn((_id: number, _value: string, _opts?: { probe: boolean }) => {
      calls.push('addSecret');
    }),
    isClientsLocked: vi.fn(() => locked),
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
    expect(bridge.addSecret).toHaveBeenCalledWith(7, SECRET, { probe: true });
    expect(calls.indexOf('addSecret')).toBeLessThan(calls.indexOf('Input.insertText'));
  });

  it('registers a redaction-only username without the field probe (R16)', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: false });
    const result = await fillFocused(deps, 'joao.silva', { requirePassword: false, redactOnly: true });
    expect(result).toEqual({ ok: true });
    expect(bridge.addSecret).toHaveBeenCalledWith(7, 'joao.silva', { probe: false });
  });

  it('still probes a redaction-only value typed into a password field (R16)', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true });
    await fillFocused(deps, 'joao.silva', { requirePassword: false, redactOnly: true });
    expect(bridge.addSecret).toHaveBeenCalledWith(7, 'joao.silva', { probe: true });
  });

  it('probes secure-input values in plain text fields by default (R16)', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: false });
    await fillFocused(deps, '483917', { requirePassword: false });
    expect(bridge.addSecret).toHaveBeenCalledWith(7, '483917', { probe: true });
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

  it('refuses while bridge clients are locked (recording or take-over), touching nothing', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true }, 'https://portal.gov.br/login', true);
    const result = await fillFocused(deps, SECRET, {
      requirePassword: true,
      allowedOrigins: ['https://portal.gov.br'],
    });
    expect(result).toEqual({ ok: false, error: 'navegador bloqueado: gravação ou funcionário no controle' });
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(bridge.addSecret).not.toHaveBeenCalled();
  });

  it('presses Enter after inserting the text when submit is set', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true });
    const result = await fillFocused(deps, SECRET, { requirePassword: true, submit: true });
    expect(result).toEqual({ ok: true });
    const methods = bridge.sendCommand.mock.calls.map(([method, params]) =>
      method === 'Input.dispatchKeyEvent' ? `${method}:${(params as { type: string }).type}` : method
    );
    expect(methods).toEqual([
      'Runtime.evaluate',
      'Input.insertText',
      'Input.dispatchKeyEvent:keyDown',
      'Input.dispatchKeyEvent:keyUp',
    ]);
    const keyDown = bridge.sendCommand.mock.calls[2][1];
    expect(keyDown).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    expect(JSON.stringify(bridge.sendCommand.mock.calls.slice(2))).not.toContain(SECRET);
  });

  it('does not press Enter without submit', async () => {
    const { deps, bridge } = makeDeps({ editable: true, isPassword: true });
    await fillFocused(deps, SECRET, { requirePassword: true });
    expect(bridge.sendCommand).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
  });

  it('treats a malformed evaluate result as not editable', async () => {
    const { deps } = makeDeps({ editable: true, isPassword: true });
    deps.bridge.sendCommand.mockResolvedValueOnce({ exceptionDetails: {} });
    const result = await fillFocused(deps, SECRET, { requirePassword: false });
    expect(result).toEqual({ ok: false, error: 'clique no campo antes de preencher' });
  });
});
