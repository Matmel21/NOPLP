// ═══ API HELPERS ═══════════════════════════════════════════════════
// Thin wrappers around fetch that always parse JSON.
// A 401 response means the session expired — reload to show the login screen.

let _csrfToken = null;

// Called by auth.js after login / register / session restore to store the token.
export function setCsrfToken(token) { _csrfToken = token; }

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (_csrfToken) h['X-CSRF-Token'] = _csrfToken;
  return h;
}

function handle(r) {
  if (r.status === 401) { location.reload(); throw new Error('Session expirée'); }
  return r.json();
}

export const api = {
  get:    url       => fetch(url).then(handle),
  post:   (url, b)  => fetch(url, { method: 'POST',   headers: authHeaders(), body: JSON.stringify(b) }).then(handle),
  put:    (url, b)  => fetch(url, { method: 'PUT',    headers: authHeaders(), body: JSON.stringify(b) }).then(handle),
  delete: url       => fetch(url, { method: 'DELETE', headers: authHeaders() }).then(handle),
};
