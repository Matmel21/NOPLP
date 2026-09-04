// ═══ ENTRY POINT ══════════════════════════════════════════════════
// Bootstraps the application: wires up navigation and initialises
// all feature modules. No business logic lives here.

import { state }                    from './state.js';
import { initAuth, logout }         from './auth.js';
import { initYouTube }              from './youtube.js';
import { initCalibration }          from './calibration.js';
import { initTyping }               from './typing.js';
import { initGame }                 from './game.js';
import { initLibrary, loadLibrary, initLibraryPlaylists, initBulkMode } from './library.js';
import { initProfile, loadProfile }              from './profile.js';
import { initEmission, renderEmissionBoard }     from './emission.js';
import { initHome, loadHome }                    from './home.js';

// ── Navigation ────────────────────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const v = btn.dataset.view;
    document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
    document.getElementById('view-' + v).classList.add('active');
    state.view = v;
    if (v === 'home')    loadHome();
    if (v === 'library') loadLibrary();
    if (v === 'profile') loadProfile();
    if (v === 'emission') renderEmissionBoard();
  });
});

document.getElementById('btn-logout').addEventListener('click', logout);

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
  initBulkMode();         // bulk mastery tagging toolbar

  loadHome();          // initial home view
});
