// ═══ NAV — page switching, transitions and keyboard shortcuts ═══════
import { state }               from './state.js';
import { loadHome }            from './home.js';
import { loadLibrary }         from './library.js';
import { loadProfile }         from './profile.js';
import { renderEmissionBoard } from './emission.js';
import { panSparkles }         from './sparkles.js';

// Nav order — also the order the arrow keys walk through
export const VIEWS = ['home', 'library', 'profile', 'emission'];
const LOADERS = { home: loadHome, library: loadLibrary, profile: loadProfile, emission: renderEmissionBoard };

export function showView(view) {
  const from = VIEWS.indexOf(state.view);
  const to   = VIEWS.indexOf(view);
  if (to < 0) return;

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(s => s.classList.remove('active', 'enter-left', 'enter-right'));
  const el = document.getElementById('view-' + view);
  el.classList.add('active');
  if (to !== from) {
    void el.offsetWidth;   // restart the entrance animation
    el.classList.add(to > from ? 'enter-right' : 'enter-left');
  }
  state.view = view;
  panSparkles(to);
  LOADERS[view]();
}

// Escape closes the topmost overlay through its own close button, so each
// module's close logic (scroll unlock, cleanup) still runs. The game modal is
// left alone on purpose: Escape must not abort a song in progress.
const ESCAPE_TARGETS = [
  ['#fav-picker-modal',                  el => el.remove()],
  ['#import-modal',                      el => el.remove()],
  ['#badges-modal',                      el => el.remove()],
  ['.pl-picker-popover',                 el => el.remove()],
  ['#emission-pick-modal:not(.hidden)',  () => document.getElementById('btn-close-emission-pick').click()],
  ['#episode-picker-modal:not(.hidden)', () => document.getElementById('btn-close-episode-picker').click()],
  ['#mode-modal:not(.hidden)',           () => document.getElementById('btn-close-mode').click()],
  ['#revision-modal:not(.hidden)',       () => document.getElementById('btn-close-revision').click()],
];

const OVERLAY_SELECTOR = '.modal:not(.hidden), .fav-picker-modal, .app-dialog, .pl-picker-popover';

function isTyping(el) {
  return el?.matches?.(
    'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable="true"]'
  );
}

export function initShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      for (const [sel, close] of ESCAPE_TARGETS) {
        const el = document.querySelector(sel);
        if (el) { close(el); break; }
      }
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isTyping(e.target) || document.querySelector(OVERLAY_SELECTOR)) return;
    const next = VIEWS.indexOf(state.view) + (e.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= VIEWS.length) return;
    e.preventDefault();
    showView(VIEWS[next]);
  });
}
