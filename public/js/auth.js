// ═══ AUTH — login / register overlay ═══════════════════════════════
import { setCsrfToken } from './api.js';

let _currentUser = null;

export function getCurrentUser() { return _currentUser; }

// Check session on load; call onAuthenticated(user) if already logged in,
// otherwise show the login overlay and call it after a successful login.
export async function initAuth(onAuthenticated) {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      _currentUser = data;
      setCsrfToken(data.csrfToken);
      onAuthenticated(_currentUser);
      return;
    }
  } catch (_) {}
  showAuthOverlay(onAuthenticated);
}

// Destroy the session and reload so all state is wiped clean.
export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}

// ── Private ──────────────────────────────────────────────────────────

function showAuthOverlay(onAuthenticated) {
  const overlay  = document.getElementById('auth-overlay');
  const title    = document.getElementById('auth-title');
  const submit   = document.getElementById('auth-submit');
  const toggle   = document.getElementById('auth-toggle');
  const errorEl  = document.getElementById('auth-error');
  const form     = document.getElementById('auth-form');

  overlay.classList.remove('hidden');

  let mode = 'login';

  // Switch between login and register modes
  toggle.addEventListener('click', () => {
    mode          = mode === 'login' ? 'register' : 'login';
    title.textContent  = mode === 'login' ? 'Connexion' : 'Créer un compte';
    submit.textContent = mode === 'login' ? 'Se connecter' : "S'inscrire";
    toggle.textContent = mode === 'login'
      ? "Pas de compte ? S'inscrire"
      : 'Déjà un compte ? Se connecter';
    errorEl.textContent = '';
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!username || !password) return;

    errorEl.textContent = '';
    submit.disabled = true;

    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Erreur';
        submit.disabled = false;
        return;
      }
      _currentUser = data.user;
      setCsrfToken(data.csrfToken);
      overlay.classList.add('hidden');
      onAuthenticated(_currentUser);
    } catch (_) {
      errorEl.textContent = 'Erreur réseau';
      submit.disabled = false;
    }
  });
}
