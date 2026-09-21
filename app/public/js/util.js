/** Tiny DOM builder: h('div', { class: 'x', onclick }, 'text', child, [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// --- Dates (all local time) --------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseYmd(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function hm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, date.getHours(), date.getMinutes());
}

export function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

export function startOfWeek(date, weekStartsOn = 0) {
  const d = startOfDay(date);
  return addDays(d, -((d.getDay() - weekStartsOn + 7) % 7));
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
}

export function fmtDate(date, opts = { weekday: 'long', month: 'long', day: 'numeric' }) {
  return date.toLocaleDateString([], opts);
}

export function weekdayNames(weekStartsOn = 0, style = 'short') {
  const base = new Date(2023, 0, 1); // a Sunday
  return Array.from({ length: 7 }, (_, i) => addDays(base, i + weekStartsOn).toLocaleDateString([], { weekday: style }));
}

/** Converts an API occurrence into local Date bounds. All-day ends are exclusive midnights. */
export function eventBounds(ev) {
  if (ev.allDay) return { start: parseYmd(ev.start), end: parseYmd(ev.end) };
  return { start: new Date(ev.start), end: new Date(ev.end) };
}

export function describeWhen(ev) {
  const { start, end } = eventBounds(ev);
  if (ev.allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last)
      ? `${fmtDate(start)} · All day`
      : `${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(last, { month: 'short', day: 'numeric' })} · All day`;
  }
  if (sameDay(start, end) || +end === +start) return `${fmtDate(start)} · ${fmtTime(start)} – ${fmtTime(end)}`;
  return `${fmtDate(start, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(start)} – ${fmtDate(end, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(end)}`;
}

// --- Colour -------------------------------------------------------------------

export function readableText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#221d18' : '#ffffff';
}

export const PALETTE = ['#e8594f', '#f29f3d', '#e5c134', '#5bb974', '#2fb5a5', '#3fa7d6', '#6c7ee1', '#b76fd8', '#e56fa5', '#8d7b6a'];

export function colorPicker(value, onChange) {
  const wrap = h('div', { class: 'swatches' });
  const render = (current) => {
    clear(wrap);
    for (const c of PALETTE) {
      wrap.append(
        h('button', {
          type: 'button',
          class: `swatch${c === current ? ' selected' : ''}`,
          style: { background: c },
          'aria-label': `Colour ${c}`,
          onclick: () => {
            render(c);
            onChange(c);
          },
        }),
      );
    }
    const custom = h('input', { type: 'color', value: current || PALETTE[0], class: 'swatch-custom', title: 'Custom colour' });
    custom.addEventListener('input', () => onChange(custom.value));
    custom.addEventListener('change', () => render(custom.value));
    wrap.append(custom);
  };
  render(value);
  return wrap;
}

// --- Feedback ---------------------------------------------------------------

export function toast(message, type = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast ${type}` }, message);
  host.append(el);
  setTimeout(() => el.classList.add('hide'), 3800);
  setTimeout(() => el.remove(), 4300);
}

/** Opens a modal sheet. Returns { el, body, close }. */
export function modal({ title, content, actions = [], wide = false, onClose }) {
  const previouslyFocused = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
    previouslyFocused?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const body = h('div', { class: 'modal-body' }, content);
  const dialog = h(
    'div',
    { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    body,
    actions.length ? h('footer', { class: 'modal-foot' }, actions) : null,
  );
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close() }, dialog);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => dialog.querySelector('input:not([type=checkbox]):not([type=color]), select, textarea, button.primary')?.focus());
  return { el: dialog, body, close };
}

export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const m = modal({
      title,
      content: h('p', {}, message),
      actions: [
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

/** Asks the user to pick one of several options. Resolves to the chosen value or null. */
export function choose(title, message, options) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const m = modal({
      title,
      content: h(
        'div',
        { class: 'stack' },
        message ? h('p', {}, message) : null,
        options.map((o) => h('button', { class: `btn block ${o.danger ? 'danger' : ''}`, onclick: () => finish(o.value) }, o.label)),
      ),
      onClose: () => finish(null),
    });
  });
}

/** Wraps an async click handler: disables the button and reports errors as toasts. */
export function busy(button, fn) {
  return async (...args) => {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('loading');
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.classList.remove('loading');
    }
  };
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', {}, label));
}

export function avatar(member, size = '') {
  return h(
    'span',
    { class: `avatar ${size}`, style: { background: member?.color || '#8d7b6a', color: readableText(member?.color || '#8d7b6a') } },
    member?.emoji || (member?.name || '?').trim().charAt(0).toUpperCase(),
  );
}

/** Appends children (nested arrays and null allowed) and returns the element. */
export function add(el, ...children) {
  appendChildren(el, children);
  return el;
}
