// DOM helpers. Everything is built with textContent / createElement (never innerHTML) so data can never inject markup.
import { ApiError, debounce } from './api.js';

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'for') node.htmlFor = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'selected', 'required', 'hidden', 'readOnly', 'multiple'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

// Empties a node. The returned append() skips null/undefined/false (native Element.append would print them as text).
export const clear = (node) => {
  node.replaceChildren();
  return { append: (...children) => append(node, children) };
};

// ------------------------------------------------------------------ formatting
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value || '');
  return m ? { y: +m[1], mo: +m[2], d: +m[3], hh: m[4], mi: m[5] } : null;
}
export function fmtDate(value) {
  const p = parts(value);
  return p ? `${p.d} ${MONTHS[p.mo - 1]} ${p.y}` : '—';
}
export function fmtTime(value) {
  const p = parts(value);
  return p && p.hh ? `${p.hh}:${p.mi}` : '—';
}
export function fmtDateTime(value) {
  const p = parts(value);
  if (!p) return '—';
  const weekday = DAYS[new Date(p.y, p.mo - 1, p.d).getDay()];
  return `${weekday} ${p.d} ${MONTHS[p.mo - 1]} ${p.y}${p.hh ? `, ${p.hh}:${p.mi}` : ''}`;
}
export const shortDay = (value) => {
  const p = parts(value);
  return p ? `${DAYS[new Date(p.y, p.mo - 1, p.d).getDay()]} ${p.d}` : '';
};
export const money = (n) => `BHD ${Number(n || 0).toFixed(2)}`;
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function age(dob) {
  const p = parts(dob);
  if (!p) return '';
  const now = new Date();
  let years = now.getFullYear() - p.y;
  if (now.getMonth() + 1 < p.mo || (now.getMonth() + 1 === p.mo && now.getDate() < p.d)) years -= 1;
  return years;
}

// ------------------------------------------------------------------ small components
const TONES = {
  Scheduled: 'blue', Confirmed: 'teal', Completed: 'green', Cancelled: 'grey', 'No-Show': 'red',
  Pending: 'amber', 'Partially Dispensed': 'blue', Dispensed: 'green',
  Active: 'green', Inactive: 'grey', Expired: 'red', Low: 'amber', Out: 'red', OK: 'green',
  Admin: 'purple', Doctor: 'teal', Receptionist: 'blue', Pharmacist: 'amber', Patient: 'grey',
};
export const badge = (text, tone) => h('span', { class: `badge badge-${tone || TONES[text] || 'grey'}` }, text);

export const pageHeader = (title, subtitle, ...actions) =>
  h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)), h('div', { class: 'page-actions' }, actions));

export const card = (title, body, ...actions) =>
  h('section', { class: 'card' }, title || actions.length ? h('header', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'card-actions' }, actions)) : null, body);

export const statCard = (label, value, hint, tone = '') =>
  h('div', { class: `stat ${tone ? `stat-${tone}` : ''}` }, h('div', { class: 'stat-value' }, typeof value === 'number' ? num(value) : value), h('div', { class: 'stat-label' }, label), hint && h('div', { class: 'stat-hint' }, hint));

export function barList(items, emptyText = 'No data yet') {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return h('p', { class: 'muted' }, emptyText);
  return h(
    'ul',
    { class: 'bars' },
    items.map((i) => {
      const fill = h('span', { class: 'bar-fill' });
      fill.style.width = `${Math.round((i.value / max) * 100)}%`;
      return h('li', {}, h('span', { class: 'bar-label' }, i.label), h('span', { class: 'bar-track' }, fill), h('span', { class: 'bar-value' }, num(i.value)));
    })
  );
}

export const emptyState = (text) => h('div', { class: 'empty' }, text);
export const errorState = (err, retry) =>
  h('div', { class: 'error-state', role: 'alert' }, h('strong', {}, 'Something went wrong. '), err instanceof ApiError ? err.message : 'Unexpected error.', retry && h('button', { class: 'btn sm', onclick: retry }, 'Try again'));

export function skeleton(rows = 5) {
  return h('div', { class: 'skeleton-block', 'aria-hidden': 'true' }, Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' })));
}

// ------------------------------------------------------------------ toasts
let toastHost;
export function toast(message, type = 'success') {
  if (!toastHost) toastHost = document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  const node = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3500);
}

// ------------------------------------------------------------------ modal
export function openModal({ title, body, wide = false, onClose }) {
  const previous = document.activeElement;
  const content = h('div', { class: 'modal-body' }, body);
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, '×');
  const dialog = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', { class: 'modal-head' }, h('h2', {}, title), closeBtn), content);
  const overlay = h('div', { class: 'overlay' }, dialog);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.overlay')) document.body.classList.remove('modal-open');
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && overlay === [...document.querySelectorAll('.overlay')].pop()) close();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  document.body.classList.add('modal-open');
  const first = dialog.querySelector('input:not([type=hidden]), select, textarea, button.primary');
  (first || closeBtn).focus();
  return { close, setBody: (...nodes) => clear(content).append(...nodes.flat()), content, dialog };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      onClose: () => done(false),
      body: [h('p', {}, message), h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => done(true) }, confirmLabel))],
    });
  });
}

// ------------------------------------------------------------------ forms
/**
 * field: { name, label, type, options:[[value,label]], required, value, hint, placeholder, min, max, step, maxlength,
 *          showIf:{otherField:[values]}, full }
 * Hidden (showIf) fields are neither validated nor submitted. Empty strings are dropped before submit.
 */
export function buildForm({ fields, submitLabel = 'Save', onSubmit, onCancel, extra }) {
  const inputs = new Map();
  const wrappers = new Map();
  const errorSlots = new Map();

  const formError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'form', novalidate: true });

  for (const f of fields) {
    const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    let input;
    if (f.type === 'select') {
      input = h('select', { id, name: f.name, required: f.required }, !f.required || f.placeholder ? h('option', { value: '' }, f.placeholder || '— select —') : null, (f.options || []).map(([v, l]) => h('option', { value: v }, l)));
      input.value = f.value ?? '';
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: f.rows || 3, maxlength: f.maxlength, required: f.required, placeholder: f.placeholder }, f.value ?? '');
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: Boolean(f.value) });
    } else {
      input = h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, maxlength: f.maxlength, autocomplete: f.type === 'password' ? 'new-password' : 'off' });
    }
    const slot = h('div', { class: 'field-error', hidden: true });
    errorSlots.set(f.name, slot);
    inputs.set(f.name, input);
    const wrap =
      f.type === 'checkbox'
        ? h('div', { class: `field field-check ${f.full ? 'full' : ''}` }, h('label', { for: id }, input, ' ', f.label), f.hint && h('div', { class: 'hint' }, f.hint), slot)
        : h('div', { class: `field ${f.full || f.type === 'textarea' ? 'full' : ''}` }, h('label', { for: id }, f.label, f.required && h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')), input, f.hint && h('div', { class: 'hint' }, f.hint), slot);
    wrappers.set(f.name, wrap);
    form.append(wrap);
  }

  const valueOf = (name) => {
    const el = inputs.get(name);
    if (el.type === 'checkbox') return el.checked;
    return el.type === 'password' ? el.value : el.value.trim(); // never alter a password
  };
  const isVisible = (f) => !f.showIf || Object.entries(f.showIf).every(([other, allowed]) => allowed.includes(String(valueOf(other))));
  const refresh = () => {
    for (const f of fields) wrappers.get(f.name).hidden = !isVisible(f);
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();

  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const actions = h('div', { class: 'form-actions' }, extra, onCancel && h('button', { class: 'btn', type: 'button', onclick: onCancel }, 'Cancel'), submitBtn);
  form.append(formError, actions);

  const showErrors = (errors, message) => {
    for (const slot of errorSlots.values()) {
      slot.hidden = true;
      slot.textContent = '';
    }
    let unplaced = false;
    for (const { field, message: text } of errors) {
      const slot = errorSlots.get(field) || errorSlots.get(field.split('.').pop());
      if (slot) {
        slot.hidden = false;
        slot.textContent = text;
      } else unplaced = true;
    }
    formError.hidden = !(message || unplaced);
    formError.textContent = message || '';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errors = [];
    const values = {};
    for (const f of fields) {
      if (!isVisible(f)) continue;
      const v = valueOf(f.name);
      if (f.required && f.type !== 'checkbox' && v === '') errors.push({ field: f.name, message: 'This field is required' });
      if (v !== '' && v !== false) values[f.name] = v;
      if (f.type === 'checkbox') values[f.name] = v;
    }
    if (errors.length) return showErrors(errors, 'Please fix the highlighted fields.');
    showErrors([], '');
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Saving…';
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = (err.details || []).filter((d) => d && d.field);
        showErrors(details.map((d) => ({ field: d.field, message: d.message })), details.length ? 'Please fix the highlighted fields.' : err.message);
      } else {
        showErrors([], 'Unexpected error. Please try again.');
        console.error(err);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });

  return { form, setError: (message) => showErrors([], message), inputs };
}

export function formModal({ title, fields, submitLabel, onSubmit, wide }) {
  let modal;
  const { form } = buildForm({
    fields,
    submitLabel,
    onCancel: () => modal.close(),
    onSubmit: async (values) => {
      await onSubmit(values);
      modal.close();
    },
  });
  modal = openModal({ title, body: form, wide });
  return modal;
}

// ------------------------------------------------------------------ table + paginated list
export function dataTable(columns, rows, emptyText = 'Nothing to show.') {
  if (!rows.length) return emptyState(emptyText);
  const head = h('tr', {}, columns.map((c) => h('th', { scope: 'col', class: c.class }, c.label)));
  const body = rows.map((row) =>
    h('tr', {}, columns.map((c) => h('td', { class: c.class, 'data-label': c.label }, c.render ? c.render(row) : (row[c.key] ?? '—'))))
  );
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, head), h('tbody', {}, body)));
}

function pager(state, total, onChange) {
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const to = Math.min(total, state.page * state.pageSize);
  return h(
    'div',
    { class: 'pager' },
    h('span', { class: 'muted' }, `${from}–${to} of ${num(total)}`),
    h('div', {}, h('button', { class: 'btn sm', disabled: state.page <= 1, onclick: () => onChange(state.page - 1) }, '‹ Prev'), h('span', { class: 'page-no' }, `Page ${state.page} / ${pages}`), h('button', { class: 'btn sm', disabled: state.page >= pages, onclick: () => onChange(state.page + 1) }, 'Next ›'))
  );
}

/**
 * Server-paginated list with debounced search + filters.
 * fetch(state) -> { data, total }.  filters: [{ name, label, type:'select'|'date', options:[[v,l]], value }]
 */
export function createList({ columns, fetch, filters = [], search, emptyText, pageSize = 10, toolbarExtra }) {
  const state = { page: 1, pageSize, q: '' };
  for (const f of filters) state[f.name] = f.value ?? '';
  const results = h('div', { class: 'list-results', 'aria-live': 'polite' });
  let seq = 0;

  async function load() {
    const mine = ++seq;
    results.setAttribute('aria-busy', 'true');
    if (!results.firstChild) results.append(skeleton());
    try {
      const res = await fetch({ ...state });
      if (mine !== seq) return; // a newer request replaced this one
      const lastPage = Math.max(1, Math.ceil(res.total / state.pageSize));
      if (state.page > lastPage) {
        state.page = lastPage;
        return load();
      }
      clear(results).append(dataTable(columns, res.data, emptyText), res.total > state.pageSize ? pager(state, res.total, (p) => { state.page = p; load(); }) : null);
    } catch (err) {
      if (mine !== seq) return;
      clear(results).append(errorState(err, load));
    } finally {
      if (mine === seq) results.removeAttribute('aria-busy');
    }
  }

  const controls = [];
  if (search) {
    const input = h('input', { type: 'search', class: 'search', placeholder: search.placeholder || 'Search…', 'aria-label': search.placeholder || 'Search', maxlength: 100 });
    input.addEventListener('input', debounce(() => { state.q = input.value.trim(); state.page = 1; load(); }, 350));
    controls.push(input);
  }
  for (const f of filters) {
    const id = `flt-${f.name}`;
    const input =
      f.type === 'date'
        ? h('input', { id, type: 'date', value: f.value ?? '', 'aria-label': f.label })
        : h('select', { id, 'aria-label': f.label }, f.options.map(([v, l]) => h('option', { value: v }, l)));
    if (f.type !== 'date') input.value = f.value ?? '';
    input.addEventListener('change', () => { state[f.name] = input.value; state.page = 1; load(); });
    controls.push(h('label', { class: 'filter', for: id }, h('span', {}, f.label), input));
  }

  const el = h('div', { class: 'list' }, h('div', { class: 'toolbar' }, controls, h('div', { class: 'toolbar-extra' }, toolbarExtra)), results);
  load();
  return { el, reload: load };
}
