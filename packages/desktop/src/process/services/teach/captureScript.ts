/**
 * Source of the capture script injected into in-app browser pages while a task is taught.
 *
 * It runs inside arbitrary third-party pages, so it is a plain self-contained ES5 string
 * (no bundler helpers, no closures over module scope): every handler is wrapped in
 * try/catch, listeners use the capture phase, and the only global it touches besides a
 * non-enumerable install guard is the `__jrTeachEvent` Runtime binding.
 *
 * Secret fields are classified with the regexes exported by fieldClassifier.ts (embedded
 * below), and their values never leave the page: the event only carries `secret: true`.
 * Paste events are never listened to.
 */

import { SECRET_AUTOCOMPLETE_RE, SECRET_TEXT_RE } from './fieldClassifier';

/** Runtime binding the script reports through (prefix `__jrTeach` keeps it off the bridge relay). */
export const CAPTURE_BINDING = '__jrTeachEvent';

const PAGE_SOURCE = String.raw`(function (RULES) {
  var KEY = typeof Symbol === 'function' ? Symbol.for('jrTeach.installed') : '__jrTeachInstalled';
  try {
    if (window[KEY]) return;
    Object.defineProperty(window, KEY, { value: true });
  } catch (e) {
    return;
  }
  var textRe = new RegExp(RULES.text[0], RULES.text[1]);
  var acRe = new RegExp(RULES.ac[0], RULES.ac[1]);
  var MAX_VALUE = 500;
  var MAX_TEXT = 80;

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }
  function attr(el, n) {
    var v = el && el.getAttribute ? el.getAttribute(n) : null;
    return v ? String(v) : '';
  }
  function tagOf(el) {
    return String(el.tagName || '').toLowerCase();
  }
  function isField(el) {
    var t = tagOf(el);
    return t === 'input' || t === 'textarea' || t === 'select';
  }
  function byIds(ids) {
    var out = [];
    var list = ids.split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var n = list[i] && document.getElementById(list[i]);
      if (n) out.push(n.textContent || '');
    }
    return clean(out.join(' '));
  }
  function labelOf(el) {
    var v = attr(el, 'aria-label');
    if (v) return clean(v);
    v = attr(el, 'aria-labelledby');
    if (v) {
      v = byIds(v);
      if (v) return v;
    }
    if (isField(el) && el.labels && el.labels.length) return clean(el.labels[0].textContent);
    return '';
  }
  function roleOf(el) {
    var r = attr(el, 'role');
    if (r) return r.split(/\s+/)[0];
    var t = tagOf(el);
    var type = attr(el, 'type').toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (t === 'button') return 'button';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (t === 'img') return 'img';
    if (t === 'option') return 'option';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      if (type === 'hidden' || type === 'file' || type === 'color') return '';
      return 'textbox';
    }
    return '';
  }
  function visibleText(el) {
    // Form fields and editable regions hold user data: never use their text as a locator.
    if (isField(el) || el.isContentEditable) return '';
    return clean(el.innerText != null ? el.innerText : el.textContent);
  }
  function nameOf(el) {
    var v = labelOf(el) || visibleText(el);
    if (v) return v;
    var type = attr(el, 'type').toLowerCase();
    // Author-set caption of input buttons (never a user-typed value).
    if (tagOf(el) === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      return clean(attr(el, 'value'));
    }
    return clean(attr(el, 'alt') || attr(el, 'title'));
  }
  function cssPath(el) {
    var parts = [];
    var n = el;
    for (var depth = 0; n && n.nodeType === 1 && depth < 4; depth++) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) {
        parts.unshift('#' + n.id);
        break;
      }
      var part = tagOf(n);
      var p = n.parentElement;
      if (p) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < p.children.length; i++) {
          if (p.children[i].tagName === n.tagName) {
            same++;
            if (p.children[i] === n) idx = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      n = p;
    }
    return parts.join(' > ');
  }
  function locators(el) {
    var out = [];
    var role = roleOf(el);
    var name = nameOf(el);
    if (role && name) out.push({ role: role, name: name });
    var label = isField(el) ? labelOf(el) : '';
    if (label) out.push({ label: label });
    var text = visibleText(el);
    if (text) out.push({ text: text });
    var ph = attr(el, 'placeholder');
    if (ph) out.push({ placeholder: clean(ph) });
    var nm = attr(el, 'name');
    if (nm) out.push({ attr: 'name="' + nm + '"' });
    if (el.id) out.push({ attr: 'id="' + el.id + '"' });
    var css = cssPath(el);
    if (css) out.push({ css: css });
    return out;
  }
  function fieldAttrs(el) {
    var t = tagOf(el);
    var f = { tag: t };
    var type = attr(el, 'type') || (t === 'input' ? 'text' : '');
    if (type) f.type = type;
    var ac = attr(el, 'autocomplete');
    if (ac) f.autocomplete = ac;
    var nm = attr(el, 'name');
    if (nm) f.name = nm;
    if (el.id) f.id = String(el.id);
    var label = labelOf(el);
    if (label) f.label = label;
    var ph = attr(el, 'placeholder');
    if (ph) f.placeholder = ph;
    return f;
  }
  function isSecret(f) {
    if (String(f.type || '').toLowerCase() === 'password') return true;
    var tokens = String(f.autocomplete || '').trim().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) if (acRe.test(tokens[i])) return true;
    var texts = [f.name, f.id, f.label, f.placeholder];
    for (var j = 0; j < texts.length; j++) if (texts[j] && textRe.test(texts[j])) return true;
    return false;
  }
  function valueOf(el) {
    var type = attr(el, 'type').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
    if (tagOf(el) === 'select') {
      var out = [];
      for (var i = 0; i < el.options.length; i++) if (el.options[i].selected) out.push(el.options[i].text);
      return out.join(', ');
    }
    return String(el.value == null ? '' : el.value);
  }
  function send(evt) {
    try {
      var b = window.__jrTeachEvent;
      if (typeof b !== 'function') return;
      evt.url = String(location.href);
      b(JSON.stringify(evt));
    } catch (e) {}
  }
  function element(e) {
    var el = e && e.target;
    return el && el.nodeType === 1 ? el : null;
  }
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,option,[role],[onclick],[contenteditable="true"],[contenteditable=""]';

  window.addEventListener('click', function (e) {
    try {
      var el = element(e);
      if (!el) return;
      var hit = (el.closest && el.closest(INTERACTIVE)) || el;
      send({ kind: 'click', target: locators(hit) });
    } catch (err) {}
  }, true);

  window.addEventListener('change', function (e) {
    try {
      var el = element(e);
      if (!el || !isField(el)) return;
      var f = fieldAttrs(el);
      var evt = { kind: 'input', field: f, target: locators(el) };
      if (isSecret(f)) evt.secret = true;
      else evt.value = valueOf(el).slice(0, MAX_VALUE);
      send(evt);
    } catch (err) {}
  }, true);

  window.addEventListener('submit', function (e) {
    try {
      var form = element(e);
      if (!form) return;
      var evt = { kind: 'submit', target: locators(form) };
      var els = form.elements || [];
      for (var i = 0; i < els.length; i++) {
        if (isField(els[i]) && isSecret(fieldAttrs(els[i])) && String(els[i].value || '').length > 0) {
          evt.secret = true;
          break;
        }
      }
      send(evt);
    } catch (err) {}
  }, true);

  window.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      var el = element(e);
      if (!el) return;
      var evt = { kind: 'key', key: e.key, target: locators(el) };
      if (isField(el)) {
        evt.field = fieldAttrs(el);
        if (isSecret(evt.field)) evt.secret = true;
      }
      send(evt);
    } catch (err) {}
  }, true);
})`;

/** The full injectable source, with the classifier rules from fieldClassifier.ts embedded. */
export function buildCaptureScript(): string {
  const rules = {
    text: [SECRET_TEXT_RE.source, SECRET_TEXT_RE.flags],
    ac: [SECRET_AUTOCOMPLETE_RE.source, SECRET_AUTOCOMPLETE_RE.flags],
  };
  return `${PAGE_SOURCE}(${JSON.stringify(rules)});`;
}
