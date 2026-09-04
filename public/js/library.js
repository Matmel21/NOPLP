// ═══ LIBRARY — song grid, filters, pagination, playlists ═══════════
import { state }              from './state.js';
import { api }                from './api.js';
import { esc, masteryIcon, showToast } from './utils.js';

let _playlists = [];

// openModeModal is imported lazily to avoid a circular dependency
// (game.js → library.js → game.js for loadLibrary in closeGame).

// ── loadLibrary ──────────────────────────────────────────────────────

export async function loadLibrary() {
  const params = new URLSearchParams({
    search:  state.search,
    artist:  state.artist,
    mastery: state.mastery,
    type:    state.type,
    sort:    state.sort,
    limit:   state.limit,
    offset:  state.page * state.limit,
  });
  if (state.playlist) params.set('playlist', state.playlist);
  const { songs, total } = await api.get('/api/songs?' + params);
  renderSongGrid(songs, total);
}

// Contextual stat badge — shows the metric matching the active sort.
// Hidden for the default alphabetical sorts and when the value is 0/absent.
function sortStatBadge(s) {
  const map = {
    show_count_desc: { val: s.show_count, cls: '',   text: v => `${v} apparition${v > 1 ? 's' : ''}` },
    mc_count_desc:   { val: s.mc_count,   cls: 'mc', text: v => `${v} fois Même Chanson` },
    fn_count_desc:   { val: s.fn_count,   cls: 'fn', text: v => `${v} fois Finale` },
    word_count_asc:  { val: s.word_count, cls: '',   text: v => `${v} mots` },
    word_count_desc: { val: s.word_count, cls: '',   text: v => `${v} mots` },
    mal_aimees: (() => {
      const total = (s.chosen_count || 0) + (s.not_chosen_count || 0);
      if (!total) return null;
      const pct = Math.round((s.chosen_count || 0) / total * 100);
      return { val: total, cls: '', text: () => `${pct}% choisie (${s.chosen_count}/${total})` };
    })(),
  };
  const e = map[state.sort];
  if (!e || !e.val) return '';
  return `<div class="song-card-stat ${e.cls}">${e.text(e.val)}</div>`;
}

// Render the song cards grid and wire each card to open the mode modal.
function renderSongGrid(songs, total) {
  const grid = document.getElementById('song-grid');
  document.getElementById('song-count').textContent = `${total} chanson${total > 1 ? 's' : ''}`;

  if (!songs.length) {
    grid.innerHTML = `<div style="color:var(--text3);padding:40px;text-align:center;grid-column:1/-1">Aucune chanson trouvée</div>`;
    updatePagination(0);
    return;
  }

  grid.innerHTML = songs.map(s => {
    const hasVideo = s.youtube_url?.trim();
    const best     = s.best_score != null ? `<span class="song-card-score">${s.best_score}%</span>` : '';
    return `
      <div class="song-card" data-id="${s.id}" data-mastery="${s.mastery || ''}">
        <div class="song-card-title">${esc(s.title)}</div>
        <div class="song-card-artist">${esc(s.artist)}${s.year ? ' · ' + s.year : ''}</div>
        ${sortStatBadge(s)}
        ${!hasVideo ? '<div class="song-card-unavailable">Clip indisponible</div>' : ''}
        <div class="song-card-meta">
          <span class="song-card-badge ${s.attempts > 0 ? 'played' : ''}">
            ${s.attempts > 0 ? `${s.attempts} essai${s.attempts > 1 ? 's' : ''}` : 'Pas joué'}
          </span>
          ${masteryIcon(s.mastery)}
          ${best}
          <button class="song-pl-btn" data-id="${s.id}" title="Ajouter à une playlist">☰</button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.song-card').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.closest('.song-pl-btn')) return;
      if (_bulkMode) { toggleBulkSelect(card); return; }
      const { openModeModal } = await import('./game.js');
      openModeModal(card.dataset.id);
    });
  });

  grid.querySelectorAll('.song-pl-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      openPlaylistPicker(btn, btn.dataset.id);
    });
  });

  updatePagination(total);
}

// Update the page counter and enable/disable the prev/next buttons.
function updatePagination(total) {
  const totalPages = Math.ceil(total / state.limit);
  document.getElementById('page-info').textContent = `Page ${state.page + 1} / ${totalPages || 1}`;
  document.getElementById('prev-page').disabled = state.page === 0;
  document.getElementById('next-page').disabled = state.page >= totalPages - 1;
}

// ── Playlist panel ────────────────────────────────────────────────

function updatePlaylistCount(playlistId, delta) {
  const chip = document.querySelector(`.pl-chip[data-id="${playlistId}"] .pl-chip-count`);
  if (chip) chip.textContent = Math.max(0, (parseInt(chip.textContent) || 0) + delta);
}

let _activePickerSongId = null;

function closePicker() {
  document.getElementById('pl-picker-popover')?.remove();
  _activePickerSongId = null;
}

async function openPlaylistPicker(btn, songId) {
  // Toggle: close if already open for this song
  if (_activePickerSongId === songId) { closePicker(); return; }
  closePicker();
  _activePickerSongId = songId;

  if (!_playlists.length) {
    showToast('Créez d\'abord une playlist');
    _activePickerSongId = null;
    return;
  }

  // Fetch which playlists already contain this song
  let memberIds = new Set();
  try {
    const rows = await api.get(`/api/songs/${encodeURIComponent(songId)}/playlists`);
    memberIds = new Set(rows.map(r => r.playlist_id));
  } catch { /* show picker anyway */ }

  const popover = document.createElement('div');
  popover.id = 'pl-picker-popover';
  popover.className = 'pl-picker-popover';
  popover.innerHTML = _playlists.map(pl => `
    <button class="pl-picker-row ${memberIds.has(pl.id) ? 'active' : ''}" data-pl="${pl.id}">
      <span class="pl-picker-check">${memberIds.has(pl.id) ? '★' : '☆'}</span>
      <span class="pl-picker-name">${esc(pl.name)}</span>
    </button>`).join('');

  // Position below the button
  const rect = btn.getBoundingClientRect();
  popover.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 180)}px`;
  document.body.appendChild(popover);

  popover.querySelectorAll('.pl-picker-row').forEach(row => {
    row.addEventListener('click', async e => {
      e.stopPropagation();
      const plId = parseInt(row.dataset.pl);
      const inPl = row.classList.contains('active');
      try {
        if (inPl) {
          await api.delete(`/api/playlists/${plId}/songs/${songId}`);
          updatePlaylistCount(plId, -1);
        } else {
          await api.post(`/api/playlists/${plId}/songs/${songId}`, {});
          updatePlaylistCount(plId, 1);
        }
        row.classList.toggle('active', !inPl);
        row.querySelector('.pl-picker-check').textContent = inPl ? '☆' : '★';
        memberIds[inPl ? 'delete' : 'add'](plId);
      } catch { showToast('Erreur'); }
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closePicker, { once: true });
  }, 0);
}

async function loadPlaylists() {
  _playlists = await api.get('/api/playlists');
  renderPlaylistPanel();
}

function renderPlaylistPanel() {
  const container = document.getElementById('playlist-chips-lib');
  container.innerHTML = _playlists.map(pl => `
    <div class="pl-chip ${state.playlist == pl.id ? 'active' : ''}" data-id="${pl.id}">
      <span class="pl-chip-name">${esc(pl.name)}</span>
      <span class="pl-chip-count">${pl.song_count}</span>
      ${!pl.is_default ? `<button class="pl-chip-del" data-id="${pl.id}" title="Supprimer">✕</button>` : ''}
    </div>`).join('');

  container.querySelectorAll('.pl-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      if (e.target.closest('.pl-chip-del')) return;
      const id = parseInt(chip.dataset.id);
      state.playlist = state.playlist === id ? null : id;
      state.page = 0;
      renderPlaylistPanel();
      loadLibrary();
    });
  });

  container.querySelectorAll('.pl-chip-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Supprimer cette playlist ?')) return;
      await api.delete(`/api/playlists/${id}`);
      if (state.playlist == id) { state.playlist = null; state.page = 0; }
      await loadPlaylists();
      loadLibrary();
    });
  });
}

export async function initLibraryPlaylists() {
  await loadPlaylists();
  document.getElementById('btn-new-playlist').addEventListener('click', async () => {
    const name = prompt('Nom de la playlist :');
    if (!name?.trim()) return;
    const pl = await api.post('/api/playlists', { name });
    _playlists.push(pl);
    renderPlaylistPanel();
  });
}

// ── Mastery tagging ──────────────────────────────────────────────────
// Individual: click the + button to cycle through states instantly.
// Bulk: enter selection mode, pick multiple cards, apply a state to all.

const MASTERY_CYCLE = [null, 'maitrisee', 'revision', 'prevue'];
const MASTERY_LABEL = { maitrisee: 'Apprise', revision: 'À revoir', prevue: 'En cours', '': 'Aucun' };

let _bulkMode    = false;
let _bulkSelected = new Set(); // song ids

// Cycle mastery for a single card and persist.
async function cycleMastery(btn) {
  const card    = btn.closest('.song-card');
  const songId  = btn.dataset.id;
  const current = card.dataset.mastery || null;
  const idx     = MASTERY_CYCLE.indexOf(current);
  const next    = MASTERY_CYCLE[(idx + 1) % MASTERY_CYCLE.length];

  try {
    await api.put('/api/songs/' + encodeURIComponent(songId) + '/mastery', { mastery: next });
    applyMasteryToCard(card, next);
  } catch { showToast('Erreur lors de la mise à jour'); }
}

function applyMasteryToCard(card, mastery) {
  card.dataset.mastery = mastery || '';
  const badge = card.querySelector('.mastery-mini');
  if (badge) badge.remove();
  const newBadge = masteryIcon(mastery);
  if (newBadge) {
    const ref = card.querySelector('.song-pl-btn') || card.querySelector('.song-card-score');
    if (ref) ref.insertAdjacentHTML('beforebegin', newBadge);
    else card.querySelector('.song-card-meta').insertAdjacentHTML('beforeend', newBadge);
  }
}

// Bulk apply mastery to all selected songs.
async function applyBulkMastery(mastery) {
  if (!_bulkSelected.size) return;
  const ids = [..._bulkSelected];
  try {
    await Promise.all(ids.map(id =>
      api.put('/api/songs/' + encodeURIComponent(id) + '/mastery', { mastery })
    ));
    ids.forEach(id => {
      const card = document.querySelector(`.song-card[data-id="${id}"]`);
      if (card) applyMasteryToCard(card, mastery);
    });
    showToast(`${ids.length} chanson${ids.length > 1 ? 's' : ''} mise${ids.length > 1 ? 's' : ''} à jour`);
  } catch { showToast('Erreur lors de la mise à jour'); }
  exitBulkMode();
}

function enterBulkMode() {
  _bulkMode = true;
  _bulkSelected.clear();
  document.getElementById('song-grid').classList.add('bulk-mode');
  document.getElementById('bulk-bar').classList.remove('hidden');
  document.getElementById('btn-bulk-mode').textContent = 'Annuler';
  updateBulkBar();
}

function exitBulkMode() {
  _bulkMode = false;
  _bulkSelected.clear();
  document.getElementById('song-grid').classList.remove('bulk-mode');
  document.getElementById('bulk-bar').classList.add('hidden');
  document.getElementById('btn-bulk-mode').textContent = 'Sélection';
  document.querySelectorAll('.song-card.bulk-selected').forEach(c => c.classList.remove('bulk-selected'));
}

function toggleBulkSelect(card) {
  const id = card.dataset.id;
  if (_bulkSelected.has(id)) {
    _bulkSelected.delete(id);
    card.classList.remove('bulk-selected');
  } else {
    _bulkSelected.add(id);
    card.classList.add('bulk-selected');
  }
  updateBulkBar();
}

function updateBulkBar() {
  const n = _bulkSelected.size;
  document.getElementById('bulk-count').textContent =
    n ? `${n} chanson${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}` : 'Cliquez sur des chansons pour les sélectionner';
  document.querySelectorAll('.bulk-apply-btn').forEach(b => b.disabled = n === 0);
}

export function initBulkMode() {
  document.getElementById('btn-bulk-mode').addEventListener('click', () => {
    if (_bulkMode) exitBulkMode(); else enterBulkMode();
  });
  document.querySelectorAll('.bulk-apply-btn').forEach(btn => {
    btn.addEventListener('click', () => applyBulkMastery(btn.dataset.mastery || null));
  });
}

// ── Artists dropdown ─────────────────────────────────────────────────

export async function loadArtists() {
  const artists = await api.get('/api/artists');
  const sel     = document.getElementById('artist-filter');
  sel.innerHTML = '<option value="">Tous les artistes</option>' +
    artists.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
}

// ── Static listeners (registered once via initLibrary) ───────────────

export function initLibrary() {
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; state.page = 0; loadLibrary(); }, 300);
  });

  document.getElementById('type-filter').addEventListener('change', e => {
    state.type = e.target.value; state.page = 0; loadLibrary();
  });
  document.getElementById('mastery-filter').addEventListener('change', e => {
    state.mastery = e.target.value; state.page = 0; loadLibrary();
  });
  document.getElementById('sort-filter').addEventListener('change', e => {
    state.sort = e.target.value; state.page = 0; loadLibrary();
  });

  document.getElementById('prev-page').addEventListener('click', () => { state.page--; loadLibrary(); });
  document.getElementById('next-page').addEventListener('click', () => { state.page++; loadLibrary(); });
}
