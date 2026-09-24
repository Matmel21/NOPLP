// ═══ UTILITIES ═════════════════════════════════════════════════════

/** Escape HTML special characters for safe innerHTML insertion. */
export function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Normalise a string for loose answer comparison (accents, apostrophes, case). */
export function normalize(s) {
  return s.toLowerCase().trim()
    .replace(/[''`]/g, "'")
    .replace(/[àâä]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/\s+/g, ' ');
}

/** Format a timestamp in seconds as m:ss.s */
export function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/** Score pill HTML (high / mid / low colour). */
export function scorePill(score) {
  if (score == null) return '—';
  const cls = score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low';
  return `<span class="score-pill ${cls}">${score}%</span>`;
}

/** Full text label for a mastery level. Returns '' for unset/default. */
export function masteryLabel(m) {
  return { maitrisee: 'Apprise', revision: 'À revoir', prevue: 'En cours' }[m] || '';
}

/** Compact coloured text badge for a mastery level. Returns '' for unset/default. */
export function masteryIcon(mastery) {
  const label = { maitrisee: 'Apprise', revision: 'À revoir', prevue: 'En cours' }[mastery];
  return label ? `<span class="mastery-mini ${mastery}">${label}</span>` : '';
}

// ── Toast notification ──────────────────────────────────────────────
let _toastTimer;

export function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = [
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%)',
      'background:var(--bg3);border:1px solid var(--border2)',
      'color:var(--text);padding:10px 20px;border-radius:10px',
      'font-size:13px;z-index:9999;pointer-events:none',
      'transition:opacity .3s;opacity:0',
    ].join(';');
    document.body.appendChild(t);
  }
  t.textContent   = msg;
  t.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ── Dialogs (styled replacements for prompt / confirm) ──────────────

// Resolves with the trimmed text (empty only if allowEmpty), or null if cancelled. With `input: false`
// it acts as a confirm and resolves true / null.
function openDialog({ title, message = '', value = '', placeholder = '', maxLength = 200,
                      confirmLabel = 'OK', danger = false, input = true, allowEmpty = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'app-dialog';
    wrap.innerHTML = `
      <div class="app-dialog-box" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <div class="app-dialog-title" id="app-dialog-title">${esc(title)}</div>
        ${message ? `<p class="app-dialog-msg">${esc(message)}</p>` : ''}
        ${input ? `<input class="app-dialog-input" type="text" maxlength="${maxLength}"
                     placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">` : ''}
        <div class="app-dialog-actions">
          <button type="button" class="app-dialog-btn cancel">Annuler</button>
          <button type="button" class="app-dialog-btn confirm${danger ? ' danger' : ''}">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const field = wrap.querySelector('.app-dialog-input');
    const done = result => {
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 160);
      resolve(result);
    };
    const confirm = () => {
      if (!input) return done(true);
      const v = field.value.trim();
      if (v || allowEmpty) done(v); else field.focus();
    };
    // Capture phase so Enter/Escape never reach the page-level shortcuts
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); confirm(); }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(null); });
    wrap.querySelector('.cancel').addEventListener('click', () => done(null));
    wrap.querySelector('.confirm').addEventListener('click', confirm);
    (field || wrap.querySelector('.confirm')).focus();
    field?.select();
  });
}

export const promptDialog  = opts => openDialog({ ...opts, input: true });
export const confirmDialog = opts => openDialog({ ...opts, input: false });
