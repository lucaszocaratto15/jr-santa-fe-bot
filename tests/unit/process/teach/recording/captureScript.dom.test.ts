import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCaptureScript } from '@/process/services/teach/recording/captureScript';
import {
  SECRET_AUTOCOMPLETE_RE,
  SECRET_TEXT_RE,
  isSecretField,
} from '@/process/services/teach/recording/fieldClassifier';

type Payload = Record<string, unknown> & { kind: string; value?: string; secret?: boolean; target?: unknown[] };

let calls: Payload[] = [];
const win = window as unknown as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  win.__jrTeachEvent = (json: string) => calls.push(JSON.parse(json) as Payload);
  document.body.innerHTML = `
    <form id="login">
      <label for="u">Usuário</label><input id="u" name="user" type="text" />
      <label>Senha <input id="p" name="pw" type="password" /></label>
      <input id="otp" name="codigo" type="text" placeholder="Código de verificação" />
      <textarea id="obs" aria-label="Observação"></textarea>
      <button type="submit">Entrar</button>
    </form>
    <a href="/notas" id="lnk"><span>Ver notas</span></a>`;
  // eslint-disable-next-line no-eval -- the capture script is a plain source string by design
  (0, eval)(buildCaptureScript());
});
afterEach(() => {
  delete win.__jrTeachEvent;
});

const change = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('capture script', () => {
  it('embeds the classifier rules from fieldClassifier (single source of truth)', () => {
    const source = buildCaptureScript();
    expect(source).toContain(JSON.stringify(SECRET_TEXT_RE.source));
    expect(source).toContain(JSON.stringify(SECRET_AUTOCOMPLETE_RE.source));
  });

  it('records the final value of ordinary fields with locators that never carry values', () => {
    change('u', 'maria');
    expect(calls).toHaveLength(1);
    const evt = calls[0];
    expect(evt).toMatchObject({
      kind: 'input',
      value: 'maria',
      field: { tag: 'input', type: 'text', name: 'user', label: 'Usuário' },
    });
    expect(evt.target).toEqual(
      expect.arrayContaining([{ role: 'textbox', name: 'Usuário' }, { label: 'Usuário' }, { attr: 'name="user"' }])
    );
    expect(JSON.stringify(evt.target)).not.toContain('maria');
  });

  it('never sends a secret value out of the page', () => {
    change('p', 'S3nh@');
    change('otp', '123456');
    expect(JSON.stringify(calls)).not.toContain('S3nh@');
    expect(JSON.stringify(calls)).not.toContain('123456');
    expect(calls.every((c) => c.secret === true && c.value === undefined)).toBe(true);
  });

  it('flags submit of a form holding a filled secret field', () => {
    (document.getElementById('p') as HTMLInputElement).value = 'S3nh@';
    const form = document.getElementById('login') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(calls).toEqual([expect.objectContaining({ kind: 'submit', secret: true })]);
    expect(JSON.stringify(calls)).not.toContain('S3nh@');
  });

  it('records clicks on the nearest interactive element and only Enter/Tab keys', () => {
    document.querySelector('#lnk span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = document.getElementById('u')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(calls.map((c) => c.kind)).toEqual(['click', 'key']);
    expect(calls[0].target).toEqual(
      expect.arrayContaining([{ role: 'link', name: 'Ver notas' }, { attr: 'id="lnk"' }])
    );
    expect(calls[1]).toMatchObject({ key: 'Enter' });
  });

  it('a click on a secret text field carries its attributes and secret, never its value', () => {
    const fields: Array<Record<string, string>> = [
      { name: 'codigo', placeholder: 'Código de verificação' },
      { name: 'cpf' },
      { name: 'numero', placeholder: 'Número do cartão' },
    ];
    for (const attrs of fields) {
      calls = [];
      const el = document.createElement('input');
      el.setAttribute('type', 'text');
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      document.body.appendChild(el);
      el.value = '987654';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(calls[0], JSON.stringify(attrs)).toMatchObject({ kind: 'click', secret: true, field: { tag: 'input' } });
      expect(JSON.stringify(calls)).not.toContain('987654');
      el.remove();
    }
  });

  it('a click on an ordinary field carries its attributes without secret', () => {
    document.getElementById('u')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls[0]).toMatchObject({ kind: 'click', field: { name: 'user' } });
    expect(calls[0].secret).toBeUndefined();
  });

  it('focusing a secret field sends a focus-secret notice; an ordinary field sends nothing', () => {
    document.getElementById('u')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(calls).toEqual([]);
    const otp = document.getElementById('otp') as HTMLInputElement;
    otp.value = '123456';
    otp.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(calls).toEqual([expect.objectContaining({ kind: 'focus-secret', secret: true })]);
    expect(JSON.stringify(calls)).not.toContain('123456');
  });

  it('never uses text of an element containing an editable region as a locator', () => {
    const box = document.createElement('div');
    box.setAttribute('role', 'group');
    box.innerHTML = '<div contenteditable="true">rascunho privado</div>';
    document.body.appendChild(box);
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(JSON.stringify(calls)).not.toContain('rascunho');
    box.remove();
  });

  it('does not install listeners twice when injected again', () => {
    // eslint-disable-next-line no-eval -- see above
    (0, eval)(buildCaptureScript());
    change('u', 'maria');
    expect(calls).toHaveLength(1);
  });

  it('classifies fields exactly like isSecretField', () => {
    const cases: Array<Record<string, string>> = [
      { type: 'password' },
      { type: 'text', autocomplete: 'one-time-code' },
      { type: 'text', autocomplete: 'cc-csc' },
      { type: 'text', autocomplete: 'username' },
      { type: 'text', name: 'numero_nf' },
      { type: 'text', name: 'user_token' },
      { type: 'text', placeholder: 'Número do cartão' },
      { type: 'text', id: 'pin' },
      { type: 'email', id: 'email' },
      { type: 'text', name: 'codigo' },
      { type: 'text', id: 'sms-code' },
      { type: 'text', name: 'zipcode' },
      { type: 'text', name: 'codigo_produto' },
      { type: 'text', placeholder: 'Verificação' },
    ];
    for (const attrs of cases) {
      calls = [];
      const el = document.createElement('input');
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      document.body.appendChild(el);
      el.value = 'v';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      expect(calls[0].secret === true, JSON.stringify(attrs)).toBe(isSecretField({ tag: 'input', ...attrs }));
      el.remove();
    }
  });
});
