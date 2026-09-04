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
  return { maitrisee: 'Apprise', revision: 'A revoir', prevue: 'En cours' }[m] || '';
}

/** Compact coloured text badge for a mastery level. Returns '' for unset/default. */
export function masteryIcon(mastery) {
  const label = { maitrisee: 'Apprise', revision: 'A revoir', prevue: 'En cours' }[mastery];
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
