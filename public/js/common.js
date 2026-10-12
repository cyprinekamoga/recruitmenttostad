'use strict';

// Shared helpers. All dynamic content is inserted as text (never as HTML),
// so names or answers containing markup can't run as code in anyone's browser.
window.App = (() => {
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  async function api(path, { method = 'GET', body, form, csrf } = {}) {
    const headers = { Accept: 'application/json' };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON response
    }
    if (!res.ok) {
      const error = new Error((data && data.error) || `Request failed (${res.status}).`);
      error.status = res.status;
      error.fields = (data && data.fields) || {};
      throw error;
    }
    return data;
  }

  function formatDate(ms, withTime = false) {
    if (!ms) return '';
    const options = withTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    return new Date(ms).toLocaleString(undefined, options);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Only allow http(s) links to be rendered as clickable. */
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function alertBox(kind, message) {
    return h('div', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  }

  /** Shows server-side validation messages next to inputs marked with data-field="<path>". */
  function showFieldErrors(container, fields) {
    container.querySelectorAll('.field-error').forEach((el) => el.remove());
    container.querySelectorAll('.invalid').forEach((el) => {
      el.classList.remove('invalid');
      el.removeAttribute('aria-invalid');
    });
    let first = null;
    for (const [path, message] of Object.entries(fields || {})) {
      const input = container.querySelector(`[data-field="${CSS.escape(path)}"]`);
      if (!input) continue;
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      const wrapper = input.closest('.field') || input.parentElement;
      wrapper.append(h('div', { class: 'field-error' }, message));
      first ??= input;
    }
    if (first) first.focus();
    return first !== null;
  }

  /** Removes a field's error message as soon as the user edits that field. */
  function clearErrorsOnEdit(container) {
    const clear = (event) => {
      const input = event.target.closest('[data-field]') || event.target.closest('.field')?.querySelector('[data-field]');
      if (!input || !input.classList.contains('invalid')) return;
      input.classList.remove('invalid');
      input.removeAttribute('aria-invalid');
      (input.closest('.field') || input.parentElement).querySelectorAll('.field-error').forEach((el) => el.remove());
    };
    container.addEventListener('input', clear);
    container.addEventListener('change', clear);
  }

  async function loadCompany() {
    try {
      const config = await api('/api/config');
      document.querySelectorAll('[data-company]').forEach((el) => {
        el.textContent = config.companyName;
      });
      return config;
    } catch {
      return { companyName: '', retentionDays: 0, maxUploadMb: 5, privacyContactEmail: '' };
    }
  }

  return { h, api, formatDate, formatSize, safeUrl, alertBox, showFieldErrors, clearErrorsOnEdit, loadCompany };
})();
