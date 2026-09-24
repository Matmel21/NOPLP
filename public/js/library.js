// ═══ LIBRARY — song grid, filters, pagination, playlists ═══════════
import { state }              from './state.js';
import { api }                from './api.js';
import { esc, masteryIcon, showToast, promptDialog, confirmDialog } from './utils.js';
import { openImportDialog }   from './import.js';

let _playlists = [];

// openModeModal is imported lazily to avoid a circular dependency
// (game.js → library.js → game.js for loadLibrary in closeGame).

// ── loadLibrary ──────────────────────────────────────────────────────

// Only the latest request may render: fast typing in the search box fires
// several, and an older, slower answer must not replace the newer one.
let _loadSeq = 0;

export async function loadLibrary() {
  const seq = ++_loadSeq;
  const params = new URLSearchParams({
    search:  state.search,
    mastery: state.mastery,
    type:    state.type,
    sort:    state.sort,
    limit:   state.limit,
    offset:  state.page * state.limit,
  });
  if (state.playlist) params.set('playlist', state.playlist);
  try {
    const { songs, total } = await api.get('/api/songs?' + params);
    if (seq === _loadSeq) renderSongGrid(songs, total);
  } catch { if (seq === _loadSeq) showToast('Erreur lors du chargement de la bibliothèque'); }
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
    aired_desc:      { val: s.aired_12m,  cls: '',   text: v => `${v} fois cette année` },
    mal_aimees: (() => {
      const total = (s.chosen_count || 0) + (s.not_chosen_count || 0);
      if (!total) return null;
      const pct = Math.round((s.chosen_count || 0) / total * 100);
      return { val: total, cls: '', text: () => `${pct}% choisie (${s.chosen_count}/${total})` };
    })(),
  };
  const e = map[state.sort || { mal_aimees: 'mal_aimees' }[state.type] || ''];
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
    const hasVideo  = s.youtube_url?.trim();
    const alts      = s.alt_versions || [];
    const altBadge  = alts.length
      ? `<span class="song-versions-badge" title="${alts.map(v => esc(v.artist) + (v.year ? ' - ' + v.year : '')).join('\n')}">${alts.length + 1} versions</span>`
      : '';
    // Escaped: an apostrophe in an artist name must not end the attribute
    const altData   = alts.length ? ` data-alts="${esc(JSON.stringify(alts))}"` : '';
    return `
      <div class="song-card" data-id="${esc(s.id)}" data-mastery="${s.mastery || ''}"${altData}>
        <div class="song-card-actions">
          <button class="song-star${s.in_default ? ' on' : ''}" data-id="${esc(s.id)}" title="Favoris"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/></svg></button>
          <button class="song-pl-btn" data-id="${esc(s.id)}" title="Choisir une playlist"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
        </div>
        <div class="song-card-title">${esc(s.title)}${altBadge}</div>
        <div class="song-card-artist">${esc(s.artist)}${s.year ? ' - ' + s.year : ''}</div>
        ${sortStatBadge(s)}
        ${!hasVideo ? '<div class="song-card-unavailable">Clip indisponible</div>' : ''}
        <div class="song-card-meta">
          ${masteryIcon(s.mastery)}
          ${quickStatusHtml(s.mastery)}
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.song-card').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.closest('.song-card-actions, .song-quick')) return;
      const alts = card.dataset.alts ? JSON.parse(card.dataset.alts) : [];
      if (alts.length) {
        openVersionPicker(card, alts);
        return;
      }
      const { openModeModal } = await import('./game.js');
      openModeModal(card.dataset.id);
    });
  });

  grid.querySelectorAll('.song-pl-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openPlaylistPicker(btn, btn.dataset.id);
    });
  });
  grid.querySelectorAll('.sq').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setCardStatus(btn.closest('.song-card'), btn.dataset.mastery);
    });
  });
  grid.querySelectorAll('.song-star').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleStar(btn);
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

function defaultPlaylist() {
  return _playlists.find(p => p.is_default);
}

function setStar(songId, on) {
  document.querySelectorAll(`.song-star[data-id="${CSS.escape(songId)}"]`)
    .forEach(b => b.classList.toggle('on', on));
}

async function toggleStar(btn) {
  const pl = defaultPlaylist();
  if (!pl) return;
  const songId = btn.dataset.id;
  const on = !btn.classList.contains('on');
  try {
    const url = `/api/playlists/${pl.id}/songs/${encodeURIComponent(songId)}`;
    if (on) await api.post(url, {}); else await api.delete(url);
    setStar(songId, on);
    updatePlaylistCount(pl.id, on ? 1 : -1);
    btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    showToast(on ? `Ajoutée à « ${pl.name} »` : `Retirée de « ${pl.name} »`);
  } catch { showToast('Erreur'); }
}

// ── Version picker (grouped duplicate songs) ─────────────────────────

let _activeVersionCard = null;

function closeVersionPicker() {
  document.getElementById('version-picker-popover')?.remove();
  _activeVersionCard = null;
}

async function openVersionPicker(card, alts) {
  if (_activeVersionCard === card) { closeVersionPicker(); return; }
  closeVersionPicker();
  _activeVersionCard = card;

  const primary = { id: card.dataset.id, artist: card.querySelector('.song-card-artist').textContent };
  const all = [primary, ...alts];

  const popover = document.createElement('div');
  popover.id = 'version-picker-popover';
  popover.className = 'pl-picker-popover';
  popover.innerHTML = `
    <div class="pl-picker-header">Choisir une version</div>
    ${all.map(v => `
      <button class="pl-picker-row version-pick-row" data-id="${esc(v.id)}">
        <span class="pl-picker-name">${esc(v.artist)}${v.year ? ' - ' + v.year : ''}</span>
      </button>`).join('')}`;

  const rect = card.getBoundingClientRect();
  popover.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 220)}px`;
  document.body.appendChild(popover);

  popover.querySelectorAll('.version-pick-row').forEach(row => {
    row.addEventListener('click', async e => {
      e.stopPropagation();
      closeVersionPicker();
      const { openModeModal } = await import('./game.js');
      openModeModal(row.dataset.id);
    });
  });

  setTimeout(() => {
    document.addEventListener('click', closeVersionPicker, { once: true });
  }, 0);
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
        const url = `/api/playlists/${plId}/songs/${encodeURIComponent(songId)}`;
        if (inPl) {
          await api.delete(url);
          updatePlaylistCount(plId, -1);
        } else {
          await api.post(url, {});
          updatePlaylistCount(plId, 1);
        }
        if (plId === defaultPlaylist()?.id) setStar(songId, !inPl);
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

// Open the library on a given list (from the home screen), filters reset
export function presetLibrary({ type = '', playlist = null } = {}) {
  Object.assign(state, { type, playlist, page: 0, search: '', mastery: '', sort: '' });
  document.getElementById('type-filter').value    = type;
  document.getElementById('mastery-filter').value = '';
  document.getElementById('sort-filter').value    = '';
  document.getElementById('search-input').value   = '';
  renderPlaylistPanel();
}

export const refreshPlaylists = () => loadPlaylists();

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
      const ok = await confirmDialog({ title: 'Supprimer cette playlist ?', confirmLabel: 'Supprimer', danger: true });
      if (!ok) return;
      try {
        await api.delete(`/api/playlists/${id}`);
      } catch (err) { showToast(err.message); return; }
      if (state.playlist == id) { state.playlist = null; state.page = 0; }
      await loadPlaylists();
      loadLibrary();
    });
  });
}

export async function initLibraryPlaylists() {
  await loadPlaylists();
  document.getElementById('btn-new-playlist').addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Nouvelle playlist', placeholder: 'Nom de la playlist', maxLength: 60, confirmLabel: 'Créer' });
    if (!name) return;
    try {
      _playlists.push(await api.post('/api/playlists', { name }));
      renderPlaylistPanel();
    } catch (err) { showToast(err.message); }
  });
}

// ── Mastery badge ────────────────────────────────────────────────────
// Status is set from the song panel (game.js), which announces the change.

const QUICK_STATUS = [
  { mastery: 'maitrisee',     label: 'Apprise',  key: '1', icon: '✓' },
  { mastery: 'prevue',        label: 'En cours', key: '2', icon: '◐' },
  { mastery: 'revision',      label: 'À revoir', key: '3', icon: '↻' },
  { mastery: 'non_maitrisee', label: 'Aucun',    key: '0', icon: '✕' },
];
// Physical keys, so the top row works on AZERTY without Shift
const KEY_TO_STATUS = {
  Digit1: 'maitrisee', Numpad1: 'maitrisee',
  Digit2: 'prevue',    Numpad2: 'prevue',
  Digit3: 'revision',  Numpad3: 'revision',
  Digit0: 'non_maitrisee', Numpad0: 'non_maitrisee',
};

function quickStatusHtml(mastery) {
  const current = mastery || 'non_maitrisee';
  return `<div class="song-quick">${QUICK_STATUS.map(q => `
    <button class="sq ${q.mastery}${q.mastery === current ? ' current' : ''}" data-mastery="${q.mastery}"
            title="${q.label} (${q.key})" aria-label="${q.label}">${q.icon}</button>`).join('')}</div>`;
}

function applyMasteryToCard(card, mastery) {
  const value = mastery === 'non_maitrisee' ? '' : (mastery || '');
  card.dataset.mastery = value;
  card.querySelector('.mastery-mini')?.remove();
  const newBadge = masteryIcon(value);
  if (newBadge) card.querySelector('.song-card-meta').insertAdjacentHTML('afterbegin', newBadge);
  card.querySelectorAll('.sq').forEach(b => b.classList.toggle('current', b.dataset.mastery === (value || 'non_maitrisee')));
}

// Show the new status at once, save in the background, roll back on failure
async function setCardStatus(card, mastery) {
  if (!card) return;
  const prev = card.dataset.mastery || 'non_maitrisee';
  if (prev === mastery) return;
  applyMasteryToCard(card, mastery);
  card.classList.remove('status-flash'); void card.offsetWidth; card.classList.add('status-flash');
  try {
    await api.put('/api/songs/' + encodeURIComponent(card.dataset.id) + '/mastery', { mastery });
  } catch {
    applyMasteryToCard(card, prev);
    showToast('Erreur de sauvegarde');
  }
}

document.addEventListener('mastery-changed', e => {
  const card = document.querySelector(`.song-card[data-id="${CSS.escape(e.detail.id)}"]`);
  if (card) applyMasteryToCard(card, e.detail.mastery);
});

// ── Static listeners (registered once via initLibrary) ───────────────

let _hoverCard = null;

function initQuickKeys() {
  const grid = document.getElementById('song-grid');
  grid.addEventListener('mouseover', e => { _hoverCard = e.target.closest('.song-card'); });
  grid.addEventListener('mouseleave', () => { _hoverCard = null; });
  document.addEventListener('keydown', e => {
    const mastery = KEY_TO_STATUS[e.code];
    if (!mastery || state.view !== 'library' || !_hoverCard?.isConnected) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches?.('input, textarea, select')) return;
    if (document.querySelector('.modal:not(.hidden), .app-dialog, .fav-picker-modal')) return;
    e.preventDefault();
    setCardStatus(_hoverCard, mastery);
  });
}

export function initLibrary() {
  initQuickKeys();
  document.getElementById('btn-import-list').addEventListener('click', openImportDialog);
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

  // A new page starts at the top of the grid, not where the old one was scrolled
  const turnPage = delta => {
    state.page += delta;
    loadLibrary();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  document.getElementById('prev-page').addEventListener('click', () => turnPage(-1));
  document.getElementById('next-page').addEventListener('click', () => turnPage(1));
}
