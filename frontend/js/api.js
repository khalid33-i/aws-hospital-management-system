// Thin fetch wrapper: JSON in/out, 15 s timeout, de-duplicates identical GETs that are already in flight.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

const TIMEOUT_MS = 15000;
const inflight = new Map();

function withQuery(path, params) {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const text = qs.toString();
  return text ? `${path}?${text}` : path;
}

async function request(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', err.name === 'AbortError' ? 'The server took too long to respond. Please try again.' : 'Cannot reach the server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
  }
  return data;
}

export const api = {
  get(path, params) {
    const url = withQuery(path, params);
    if (!inflight.has(url)) {
      inflight.set(url, request('GET', url).finally(() => inflight.delete(url)));
    }
    return inflight.get(url);
  },
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// crypto.randomUUID() needs HTTPS; getRandomValues works on plain HTTP too (e.g. an ALB without a certificate)
export function newRequestKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `ui-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
