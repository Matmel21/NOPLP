// ═══ ENTRY POINT ══════════════════════════════════════════════════
// Bootstraps the application: wires up navigation and initialises
// all feature modules. No business logic lives here.

import { initAuth, logout }         from './auth.js';
import { initYouTube }              from './youtube.js';
import { initCalibration }          from './calibration.js';
import { initTyping }               from './typing.js';
import { initGame }                 from './game.js';
import { initLibrary, initLibraryPlaylists } from './library.js';
import { initProfile }                           from './profile.js';
import { initEmission }                          from './emission.js';
import { initHome, loadHome }                    from './home.js';
import { initSparkles }                          from './sparkles.js';
import { showView, initShortcuts }               from './nav.js';

// ── Navigation ────────────────────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

document.getElementById('btn-logout').addEventListener('click', logout);

initSparkles();

// ── Bootstrap (after successful auth check) ───────────────────────

initAuth(user => {
  document.getElementById('nav-username').textContent = user.username;

  initYouTube();       // registers window.onYouTubeIframeAPIReady before YT script fires
  initTyping();        // Space, Reveal-all, Initiales static buttons
  initCalibration();   // btn-calibrate, btn-calib-save, btn-calib-cancel
  initGame();          // btn-close-mode, btn-close-game, mode-overlay, modal-overlay
  initLibrary();       // search, filters, pagination
  initProfile(user);   // avatar upload, username/bio edit
  initEmission(user);  // emission pick modal close buttons
  initHome(user);      // home action cards, quick play
  initLibraryPlaylists(); // playlist panel in library
  initShortcuts();        // ←/→ switch pages, Escape closes overlays

  loadHome();          // initial home view
});
