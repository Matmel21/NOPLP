// ═══ GAME — mode selection, start, finish, finale rounds ═══════════
import { state, FN_ROUNDS }                              from './state.js';
import { api }                                           from './api.js';
import { esc, showToast }                                from './utils.js';
import { parseBlanks, buildLineQueue }                   from './blanks.js';
import { renderLyrics, advanceLine, updateBlanksLeft,
         showQueueLine, clearTypingArea }                from './lyrics.js';
import { setupTypingArea }                               from './typing.js';
import { extractYtId, startSync, stopSync, hideYtError } from './youtube.js';
import { exitCalibMode }                                 from './calibration.js';

// Note: game.js ↔ typing.js have a mutual import.
// This is safe in ES modules because the circular references are only used
// inside function bodies (never at module-evaluation time).

// ── Mode selection modal ─────────────────────────────────────────────

export async function openModeModal(id) {
  const data = await api.get('/api/songs/' + encodeURIComponent(id));
  state.song = data;

  document.getElementById('mode-title').textContent  = data.title;
  document.getElementById('mode-artist').textContent = data.artist;
  renderStatus(data.mastery);

  // Video source toggle — show when at least one URL exists, disable unavailable options
  const hasVideo   = !!data.youtube_url?.trim();
  const hasKaraoke = !!data.karaoke_url?.trim();
  const videoToggle = document.getElementById('mode-video-toggle');
  // Hide toggle entirely only when both are missing
  videoToggle.classList.toggle('hidden', !hasVideo && !hasKaraoke);
  videoToggle.querySelectorAll('.video-src-btn').forEach(b => {
    const isClassic  = b.dataset.src === 'classic';
    const available  = isClassic ? hasVideo : hasKaraoke;
    b.disabled = !available;
    // Default selection: classic if available, otherwise karaoke
    b.classList.toggle('active', isClassic ? hasVideo : (!hasVideo && hasKaraoke));
  });

  // Availability labels
  const modalTitle = document.getElementById('mode-title');
  let unavailableHtml = '';
  if (!hasVideo)   unavailableHtml += '<span class="modal-unavailable">Clip indisponible</span>';
  if (!hasKaraoke) unavailableHtml += '<span class="modal-unavailable">Karaoké indisponible</span>';
  let labelsEl = document.getElementById('mode-unavailable-labels');
  if (!labelsEl) {
    labelsEl = document.createElement('div');
    labelsEl.id = 'mode-unavailable-labels';
    labelsEl.className = 'mode-unavailable-labels';
    modalTitle.parentNode.insertBefore(labelsEl, modalTitle.nextSibling.nextSibling);
  }
  labelsEl.innerHTML = unavailableHtml;

  // Normal mode: show only levels that have blanks in the DB
  let availableLevels = [];
  if (data.blanks_json) {
    try {
      const bj = JSON.parse(data.blanks_json);
      availableLevels = Object.keys(bj).map(Number)
        .filter(k => { const a = bj[k] || bj[String(k)]; return Array.isArray(a) && a.length > 0; })
        .sort((a, b) => a - b);
    } catch (_) {}
  }
  if (!availableLevels.length) availableLevels = [10, 20, 30, 40, 50];

  const LEVEL_LABELS = { 10: '10 pts', 20: '20 pts', 30: '30 pts', 40: '40 pts', 50: '50 pts' };
  document.getElementById('mode-normal-btns').innerHTML = availableLevels
    .filter(l => [10, 20, 30, 40, 50].includes(l))
    .map(l => `<button class="mode-btn" data-mode="normal" data-diff="${l}">${LEVEL_LABELS[l] || l + '%'}</button>`)
    .join('');

  const mcSection = document.getElementById('mode-mc-section');
  if (data.mc_count) {
    mcSection.classList.remove('hidden');
    document.getElementById('mode-mc-btns').innerHTML =
      `<button class="mode-btn mode-btn-mc" data-mode="mc">Jouer</button>`;
  } else {
    mcSection.classList.add('hidden');
  }

  const fnSection = document.getElementById('mode-finale-section');
  if (data.fn_count) {
    fnSection.classList.remove('hidden');
    document.getElementById('mode-finale-btns').innerHTML = FN_ROUNDS
      .map((amount, i) => `<button class="mode-btn mode-btn-finale" data-mode="finale" data-step="${i}">${amount.toLocaleString('fr-FR')} €</button>`)
      .join('');
  } else {
    fnSection.classList.add('hidden');
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const activesrc = videoToggle.querySelector('.video-src-btn.active')?.dataset.src || 'classic';
      closeModeModal();
      startGame(
        btn.dataset.mode,
        parseInt(btn.dataset.diff) || 20,
        parseInt(btn.dataset.step) || 0,
        activesrc,
      );
    });
  });

  document.getElementById('mode-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

// ── Song status (Apprise / En cours / À revoir / Aucun) ──────────────

function renderStatus(mastery) {
  const current = mastery || 'non_maitrisee';
  document.querySelectorAll('.mode-status-btn').forEach(b =>
    b.classList.toggle('current', b.dataset.mastery === current));
}

// Highlight at once, save in the background, roll back on failure
async function setSongStatus(mastery) {
  const song = state.song;
  if (!song) return;
  const prev = song.mastery;
  const announce = m => document.dispatchEvent(new CustomEvent('mastery-changed', { detail: { id: song.id, mastery: m || 'non_maitrisee' } }));
  song.mastery = mastery === 'non_maitrisee' ? null : mastery;
  renderStatus(song.mastery);
  announce(song.mastery);
  try {
    await api.put('/api/songs/' + encodeURIComponent(song.id) + '/mastery', { mastery });
  } catch {
    song.mastery = prev;
    renderStatus(prev);
    announce(prev);
    showToast('Erreur de sauvegarde');
  }
}

export function closeModeModal() {
  document.getElementById('mode-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── startGame ────────────────────────────────────────────────────────

export function startGame(mode, difficulty, finaleStep, mcVideoMode = 'classic') {
  _attemptSaved              = false;   // reset per-game guard
  state.gameMode             = mode;
  state.difficulty           = difficulty;
  state.finaleStep           = finaleStep;
  state.mcVideoMode          = mcVideoMode;
  state.score                = 0;
  state.calibMode            = false;
  state.finaleInitialesUsed  = false;
  state.finaleInitialesShown = false;

  parseBlanks();
  buildLineQueue();
  state.totalBlanks = state.blanks.length;

  // Load calibration timestamps
  state.timestamps = [];
  const tsJson = state.song.timestamps_json || state.song.progress?.timestamps_json;
  if (tsJson) { try { state.timestamps = JSON.parse(tsJson); } catch (_) {} }

  // Header
  const badge = { normal: `Niveau ${difficulty} pts`, mc: 'Même Chanson', finale: `Finale — ${FN_ROUNDS[finaleStep]?.toLocaleString('fr-FR')} €` };
  document.getElementById('gm-mode-badge').textContent = badge[mode] || '';
  document.getElementById('gm-title').textContent      = state.song.title;
  document.getElementById('gm-artist').textContent     = state.song.artist;
  document.getElementById('score-display').textContent = '0';
  updateBlanksLeft();

  // INITIALES bonus button (finale only)
  const btnInit = document.getElementById('btn-initiales');
  btnInit.classList.toggle('hidden', mode !== 'finale');
  if (mode === 'finale') btnInit.disabled = false;

  const isRevision = mode === 'revision';
  const isMc       = mode === 'mc';
  document.getElementById('game-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Revision + MC: hide typing/score UI
  document.getElementById('revision-nav').classList.toggle('hidden', !isRevision);
  document.getElementById('typing-area').classList.toggle('hidden', isRevision || isMc);
  document.querySelector('.score-bar')?.classList.toggle('hidden', isRevision || isMc);
  document.getElementById('btn-reveal-all').classList.toggle('hidden', isRevision || isMc);

  // Karaoke toggle — available on any manche when both a karaoke and a sung clip exist
  const btnKaraoke   = document.getElementById('btn-karaoke');
  const canToggleVid = !isRevision && !!state.song.karaoke_url?.trim() && !!state.song.youtube_url?.trim();
  btnKaraoke.classList.toggle('hidden', !canToggleVid);
  if (canToggleVid) btnKaraoke.classList.toggle('active', mcVideoMode === 'karaoke');

  renderLyrics();
  if (!isRevision && !isMc) setupTypingArea();
  exitCalibMode();

  if (!state.timestamps.length) advanceLine();

  // Use karaoke URL if selected and available, for any mode
  const videoUrl = (mcVideoMode === 'karaoke' && state.song.karaoke_url?.trim())
    ? state.song.karaoke_url
    : state.song.youtube_url;
  const ytId = extractYtId(videoUrl);
  hideYtError();
  if (ytId) {
    if (state.ytReady && state.ytPlayer) state.ytPlayer.loadVideoById(ytId);
    else state.pendingYtId = ytId;
  } else {
    // No video — stop whatever was playing from the previous song
    state.pendingYtId = null;
    if (state.ytReady && state.ytPlayer) {
      try { state.ytPlayer.stopVideo(); } catch (_) {}
    }
  }

  // Hide calibration when no video
  const hasVideo = !!state.song.youtube_url?.trim();
  document.getElementById('btn-calibrate').classList.toggle('hidden', !hasVideo);

  if (state.timestamps.length && state.ytPlayer) {
    try { if (state.ytPlayer.getPlayerState?.() === 1) startSync(); } catch (_) {}
  }
}

// ── MC video source toggle (karaoke ⇄ sung clip) ─────────────────────
// Reloads the player with the URL matching state.mcVideoMode, resuming at
// the current playback position so the switch is seamless mid-song.
function reloadMcVideoSource() {
  if (!state.ytPlayer || !state.song) return;
  let t = 0;
  try { t = state.ytPlayer.getCurrentTime?.() ?? 0; } catch (_) {}
  const url = (state.mcVideoMode === 'karaoke' && state.song.karaoke_url?.trim())
    ? state.song.karaoke_url
    : state.song.youtube_url;
  const id = extractYtId(url);
  if (!id) return;
  try { state.ytPlayer.loadVideoById({ videoId: id, startSeconds: Math.max(0, t) }); } catch (_) {}
}

// ── nextFinaleRound ──────────────────────────────────────────────────

export function nextFinaleRound() {
  const nextStep = state.finaleStep + 1;
  if (nextStep >= FN_ROUNDS.length) {
    showToast('Bravo ! Finale complète !');
    finishGame();
    return;
  }
  state.finaleStep           = nextStep;
  state.score                = 0;
  state.currentQueueIdx      = -1;
  state.activeLine           = -1;
  state.finaleInitialesShown = false;

  parseBlanks();
  buildLineQueue();
  state.totalBlanks = state.blanks.length;

  const amount = FN_ROUNDS[nextStep].toLocaleString('fr-FR');
  document.getElementById('gm-mode-badge').textContent = `Finale — ${amount} €`;
  document.getElementById('score-display').textContent  = '0';
  showToast(`Manche suivante : ${amount} €`);

  setupTypingArea();
  renderLyrics();

  if (state.ytPlayer) { try { state.ytPlayer.playVideo(); } catch (_) {} }
  advanceLine();
}

// ── finishGame / closeGame ───────────────────────────────────────────
// Guard: only one attempt/session saved per game, regardless of how many
// times finishGame or closeGame are called (sync loop, YT auto-advance, etc.)
let _attemptSaved = false;

// Resolves to the server's XP result ({ gained, level, leveledUp }) or null
async function saveAttempt() {
  if (_attemptSaved || !state.song) return null;
  _attemptSaved = true;
  try {
    const res = await api.post('/api/songs/' + encodeURIComponent(state.song.id) + '/attempt', { score: state.score });
    return res.xp || null;
  } catch (_) { return null; }
}

export async function finishGame() {
  stopSync();
  clearTypingArea();
  document.getElementById('typing-area').classList.add('hidden');
  showToast(`Terminé ! Score : ${state.score}%`);
  const xp = await saveAttempt();
  if (xp?.leveledUp)  showToast(`Niveau ${xp.level.level} atteint : ${xp.level.title} !`);
  else if (xp?.gained) showToast(`Terminé ! Score : ${state.score}% · +${xp.gained} XP`);
  // Show next-song button if we're in a revision queue with songs remaining
  const hasNext = state.revisionQueueIdx >= 0
    && state.revisionQueueIdx < state.revisionQueue.length - 1;
  document.getElementById('btn-next-song').classList.toggle('hidden', !hasNext);
}

export async function closeGame() {
  stopSync();
  clearTimeout(state._autoAdvanceTimer);
  clearInterval(state.syncInterval);
  state.syncInterval = null;
  exitCalibMode();
  document.getElementById('btn-next-song').classList.add('hidden');
  document.getElementById('btn-initiales').classList.add('hidden');
  document.getElementById('btn-karaoke').classList.add('hidden');
  document.getElementById('btn-calibrate').classList.remove('hidden');
  document.getElementById('btn-reveal-all').classList.remove('hidden');
  document.getElementById('revision-nav').classList.add('hidden');
  document.getElementById('typing-area').classList.remove('hidden');
  document.querySelector('.score-bar')?.classList.remove('hidden');
  document.querySelector('.yt-container')?.classList.remove('audio-only');
  document.getElementById('btn-audio-only').classList.remove('active');

  if (state.ytPlayer) { try { state.ytPlayer.pauseVideo(); } catch (_) {} }

  if (state.totalBlanks > 0 && state.score > 0) await saveAttempt();

  document.getElementById('game-modal').classList.add('hidden');
  document.body.style.overflow = '';
  state.song = null;
  document.dispatchEvent(new CustomEvent('game-closed'));

  if (state.view === 'emission') {
    const { onEmissionGameClose } = await import('./emission.js');
    onEmissionGameClose();
  } else {
    const { loadLibrary } = await import('./library.js');
    loadLibrary();
  }
}

// ── Static listeners (registered once via initGame) ──────────────────

export function initGame() {
  document.getElementById('btn-close-mode').addEventListener('click', closeModeModal);
  document.querySelectorAll('.mode-status-btn').forEach(btn =>
    btn.addEventListener('click', () => setSongStatus(btn.dataset.mastery)));
  document.getElementById('mode-overlay').addEventListener('click', closeModeModal);
  document.getElementById('btn-close-game').addEventListener('click', closeGame);
  document.getElementById('modal-overlay').addEventListener('click', closeGame);

  document.getElementById('btn-next-song').addEventListener('click', async () => {
    state.revisionQueueIdx++;
    const next = state.revisionQueue[state.revisionQueueIdx];
    if (!next) return;
    // Reset attempt guard for the next song without closing modal
    _attemptSaved = false;
    stopSync();
    clearTimeout(state._autoAdvanceTimer);
    state.song = null;
    document.getElementById('btn-next-song').classList.add('hidden');
    document.getElementById('game-modal').classList.add('hidden');
    document.body.style.overflow = '';
    openModeModal(next.id);
  });

  // Karaoke toggle — switch the player between the official clip and the karaoke version
  document.getElementById('btn-karaoke').addEventListener('click', () => {
    state.mcVideoMode = state.mcVideoMode === 'karaoke' ? 'classic' : 'karaoke';
    document.getElementById('btn-karaoke').classList.toggle('active', state.mcVideoMode === 'karaoke');
    reloadMcVideoSource();
  });

  // Video source toggle (clip / karaoké)
  document.getElementById('mode-video-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.video-src-btn');
    if (!btn || btn.disabled) return;
    document.querySelectorAll('.video-src-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Audio-only toggle — hides the video iframe, audio keeps playing
  const btnAudio = document.getElementById('btn-audio-only');
  btnAudio.addEventListener('click', () => {
    const container = document.querySelector('.yt-container');
    const isHidden  = container.classList.toggle('audio-only');
    btnAudio.classList.toggle('active', isHidden);
    btnAudio.title = isHidden ? 'Afficher la vidéo' : 'Masquer la vidéo (audio uniquement)';
  });
}
