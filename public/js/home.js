// ═══ HOME VIEW ══════════════════════════════════════════════════════
import { api }   from './api.js';
import { esc }   from './utils.js';
import { state } from './state.js';

let _user = null;
let _revMode  = null;
let _revCount = 5;

// ── Public API ────────────────────────────────────────────────────

export function initHome(user) {
  _user = user;

  document.getElementById('home-btn-quick').addEventListener('click', openRevisionModal);
  document.getElementById('home-btn-emission').addEventListener('click', () => switchView('emission'));
  document.getElementById('home-btn-library').addEventListener('click',  () => switchView('library'));

  // Revision modal wiring
  document.getElementById('revision-overlay').addEventListener('click', closeRevisionModal);
  document.getElementById('btn-close-revision').addEventListener('click', closeRevisionModal);

  document.getElementById('revision-modes').addEventListener('click', e => {
    const btn = e.target.closest('.rev-mode-btn');
    if (!btn) return;
    document.querySelectorAll('.rev-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _revMode = btn.dataset.mode;
    document.getElementById('btn-start-revision').disabled = false;
  });

  document.getElementById('rev-count-minus').addEventListener('click', () => {
    _revCount = Math.max(1, _revCount - 1);
    document.getElementById('rev-count-display').textContent = _revCount;
  });
  document.getElementById('rev-count-plus').addEventListener('click', () => {
    _revCount = Math.min(20, _revCount + 1);
    document.getElementById('rev-count-display').textContent = _revCount;
  });

  document.getElementById('btn-start-revision').addEventListener('click', startRevision);
}

export async function loadHome() {
  if (_user) {
    document.getElementById('home-username').textContent = _user.username;
  }
  document.getElementById('home-date').textContent = formatDate(new Date());

  try {
    const data = await api.get('/api/home');
    renderRecents(data.recents);
    renderPlaylist(data.playlist, data.totalPlaylist);
  } catch (_) {
    // not yet logged in — content will load after auth
  }
}

// ── Revision modal ────────────────────────────────────────────────

function openRevisionModal() {
  _revMode = null;
  document.querySelectorAll('.rev-mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-start-revision').disabled = true;
  document.getElementById('rev-count-display').textContent = _revCount;
  document.getElementById('revision-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeRevisionModal() {
  document.getElementById('revision-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

async function startRevision() {
  if (!_revMode) return;
  closeRevisionModal();

  const params = new URLSearchParams({ count: _revCount });
  if (_revMode === 'mc') {
    params.set('mc', '1');
  } else if (_revMode !== 'random') {
    params.set('mastery', _revMode);
  }

  try {
    const songs = await api.get('/api/revision-queue?' + params);
    if (!songs.length) {
      const labels = { maitrisee: 'apprises', revision: 'à revoir', prevue: 'en cours', mc: 'avec Même Chanson', random: '' };
      const { showToast } = await import('./utils.js');
      showToast(`Aucune chanson ${labels[_revMode] || ''} trouvée`);
      return;
    }
    state.revisionQueue    = songs;
    state.revisionQueueIdx = 0;
    const { openModeModal } = await import('./game.js');
    openModeModal(songs[0].id);
  } catch {
    const { showToast } = await import('./utils.js');
    showToast('Erreur lors du chargement');
  }
}

function renderRecents(recents) {
  const el = document.getElementById('home-recents');
  if (!el) return;
  if (!recents.length) {
    el.innerHTML = `<div class="home-empty">Aucune chanson jouée récemment.</div>`;
    return;
  }
  el.innerHTML = recents.map(s => `
    <div class="home-recent-card" data-id="${esc(s.id)}">
      <div class="home-recent-info">
        <div class="home-recent-title">${esc(s.title)}</div>
        <div class="home-recent-artist">${esc(s.artist)}</div>
      </div>
      ${s.best_score != null ? `<div class="home-recent-score">${s.best_score}%</div>` : ''}
    </div>
  `).join('');

  el.querySelectorAll('.home-recent-card').forEach(card => {
    card.addEventListener('click', async () => {
      const { openModeModal } = await import('./game.js');
      openModeModal(card.dataset.id);
    });
  });
}

function renderPlaylist(playlist, total) {
  const el = document.getElementById('home-playlist');
  if (!el) return;
  if (!playlist.length) {
    el.innerHTML = `<div class="home-empty">Votre playlist est vide. Ajoutez des chansons depuis la bibliothèque.</div>`;
    return;
  }
  el.innerHTML = playlist.map(s => `
    <div class="home-playlist-chip" data-id="${esc(s.id)}">
      <div class="home-playlist-chip-info">
        <div class="home-playlist-chip-title">${esc(s.title)}</div>
        <div class="home-playlist-chip-artist">${esc(s.artist)}</div>
      </div>
      <div class="home-playlist-play">▷</div>
    </div>
  `).join('') + (total > playlist.length
    ? `<div class="home-more">+ ${total - playlist.length} autre${total - playlist.length > 1 ? 's' : ''} dans la playlist</div>`
    : '');

  el.querySelectorAll('.home-playlist-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const { openModeModal } = await import('./game.js');
      openModeModal(chip.dataset.id);
    });
  });
}

// ── Quick play ────────────────────────────────────────────────────

async function quickPlay() {
  try {
    const data = await api.get('/api/home');
    const pool = data.playlist.length ? data.playlist : data.recents;
    if (!pool.length) {
      switchView('library');
      return;
    }
    const song = pool[Math.floor(Math.random() * pool.length)];
    const { openModeModal } = await import('./game.js');
    openModeModal(song.id);
  } catch (_) {
    switchView('library');
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function switchView(viewName) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
  document.getElementById('view-' + viewName)?.classList.add('active');

  if (viewName === 'emission') {
    import('./emission.js').then(m => m.renderEmissionBoard());
  }
  if (viewName === 'library') {
    import('./library.js').then(m => m.loadLibrary());
  }
}

function formatDate(d) {
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
