// ═══ DASHBOARD — stats, mastery table, playlist ════════════════════
import { state }                                      from './state.js';
import { api }                                        from './api.js';
import { esc, showToast, scorePill, masteryLabel }    from './utils.js';

let _dashData    = null;
let _allSongs    = [];
let _pickerSongId = null;

// ── loadDashboard ────────────────────────────────────────────────────

export async function loadDashboard() {
  _dashData = await api.get('/api/stats');
  renderStatCards(_dashData);
  renderMasteryProgress(_dashData);
  renderPlaylist(_dashData.playlist || []);
  renderMasteryTable(_dashData.songs);
  renderTopTable(_dashData.top);
  renderArtistTable(_dashData.by_artist);
}

// ── Stat cards ───────────────────────────────────────────────────────

// Render the summary stat cards at the top of the dashboard.
function renderStatCards(data) {
  const cards = [
    { label: 'Chansons jouables', value: data.total,      sub: 'avec vidéo YouTube' },
    { label: 'Jouées',            value: data.played,     sub: `${data.total ? Math.round(data.played / data.total * 100) : 0}% de couverture` },
    { label: 'Apprises',          value: data.maitrisee || 0,  sub: 'statut Apprise' },
    { label: 'A revoir',          value: (data.revision || 0) + (data.prevue || 0), sub: 'a revoir + en cours' },
    { label: 'Essais totaux',     value: data.attempts || 0,   sub: 'toutes chansons' },
    { label: 'Score moyen',       value: (data.avg_score ? Math.round(data.avg_score) : 0) + '%', sub: 'sur les essais réalisés' },
  ];
  document.getElementById('stat-cards').innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-card-label">${c.label}</div>
      <div class="stat-card-value">${c.value ?? '—'}</div>
      <div class="stat-card-sub">${c.sub}</div>
    </div>`).join('');
}

// ── Mastery progress bar ─────────────────────────────────────────────

// Render the colour-segmented progress bar and mastery count labels.
function renderMasteryProgress(data) {
  const total = data.total || 1;
  const named = [
    { key: 'maitrisee', label: 'Apprises',  cls: 'maitrisee' },
    { key: 'revision',  label: 'A revoir',  cls: 'revision' },
    { key: 'prevue',    label: 'En cours',  cls: 'prevue' },
  ];
  const barSegments = [
    ...named,
    { key: 'non_maitrisee', cls: 'non_maitrisee' },
  ];
  document.getElementById('mastery-progress-row').innerHTML = `
    <div class="mastery-bar">
      ${barSegments.map(s => {
        const pct = Math.round((data[s.key] || 0) / total * 100);
        return pct > 0 ? `<div class="mastery-bar-seg ${s.cls}" style="width:${pct}%"></div>` : '';
      }).join('')}
    </div>
    <div class="mastery-bar-labels">
      ${named.map(s => `<span class="mastery-tag ${s.cls}">${s.label} · ${data[s.key] || 0}</span>`).join('')}
    </div>`;
}

// ── Playlist chips ───────────────────────────────────────────────────

// Render the row of playlist chips and wire the remove / click-to-play buttons.
function renderPlaylist(playlist) {
  const chips   = document.getElementById('playlist-chips');
  const empty   = document.getElementById('playlist-empty');
  document.getElementById('playlist-count').textContent = playlist.length ? `(${playlist.length})` : '';

  if (!playlist.length) {
    chips.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  chips.innerHTML = playlist.map(s => `
    <div class="playlist-chip" data-id="${s.id}">
      <span class="playlist-chip-title">${esc(s.title)}</span>
      <span class="playlist-chip-artist">${esc(s.artist)}</span>
      <button class="playlist-chip-remove" data-id="${s.id}" title="Retirer">✕</button>
    </div>`).join('');

  chips.querySelectorAll('.playlist-chip-remove').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); await setPlaylist(btn.dataset.id, false); });
  });
  chips.querySelectorAll('.playlist-chip').forEach(chip => {
    chip.addEventListener('click', async e => {
      if (e.target.classList.contains('playlist-chip-remove')) return;
      const { openModeModal } = await import('./game.js');
      openModeModal(chip.dataset.id);
    });
  });

  // Show/hide the random play button based on playlist content
  document.getElementById('btn-play-playlist').classList.toggle('hidden', !playlist.length);
}

// ── Mastery table ────────────────────────────────────────────────────

// Store and display the full songs table (delegates filtering to filterMasteryTable).
function renderMasteryTable(songs) {
  _allSongs = songs || [];
  filterMasteryTable();
}

// Re-render the table body applying current search/filter values.
function filterMasteryTable() {
  const q       = (document.getElementById('dash-search').value || '').toLowerCase();
  const mastery = document.getElementById('dash-mastery-filter').value;
  const type    = document.getElementById('dash-type-filter').value;
  const tbody   = document.querySelector('#mastery-table tbody');

  const filtered = _allSongs.filter(s => {
    const matchQ = !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q);
    const matchM = !mastery || s.mastery === mastery;
    const matchT = !type
      || (type === 'mc'   && s.mc_count > 0)
      || (type === 'fn'   && s.fn_count > 0)
      || (type === 'none' && !s.mc_count && !s.fn_count);
    return matchQ && matchM && matchT;
  });

  document.getElementById('dash-song-count').textContent = `${filtered.length} chanson${filtered.length > 1 ? 's' : ''}`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text3);padding:20px;text-align:center">Aucune chanson</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const m    = s.mastery;
    const pill = s.best_score != null ? scorePill(s.best_score) : '<span style="color:var(--text3)">—</span>';
    const types = [
      s.mc_count > 0 ? '<span class="type-badge mc">MC</span>' : '',
      s.fn_count > 0 ? '<span class="type-badge fn">FN</span>' : '',
    ].filter(Boolean).join(' ');
    const plBtn = `<button class="playlist-toggle ${s.in_playlist ? 'active' : ''}" data-id="${s.id}" title="${s.in_playlist ? 'Retirer de la playlist' : 'Ajouter à la playlist'}">
      ${s.in_playlist ? '−' : '+'}
    </button>`;
    return `<tr data-id="${s.id}">
      <td>${esc(s.title)}</td>
      <td style="color:var(--accent)">${esc(s.artist)}</td>
      <td>${types}</td>
      <td style="color:var(--text3)">${s.attempts || 0}</td>
      <td>${pill}</td>
      <td><span class="mastery-tag ${m || ''} mastery-clickable" data-id="${s.id}" data-mastery="${m || ''}">${masteryLabel(m) || '—'}</span></td>
      <td>${plBtn}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.mastery-clickable').forEach(tag => {
    tag.addEventListener('click', e => openMasteryPicker(e, tag.dataset.id, tag.dataset.mastery));
  });
  tbody.querySelectorAll('.playlist-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const song = _allSongs.find(s => s.id === btn.dataset.id);
      if (song) await setPlaylist(btn.dataset.id, !song.in_playlist);
    });
  });
}

// ── Top / by-artist tables ───────────────────────────────────────────

// Render the top-20 scores table.
function renderTopTable(top) {
  const tbody = document.querySelector('#top-table tbody');
  if (!top?.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text3);padding:16px;text-align:center">Aucun essai</td></tr>`;
    return;
  }
  tbody.innerHTML = top.map(s => `<tr>
    <td>${esc(s.title)}</td>
    <td style="color:var(--accent)">${esc(s.artist)}</td>
    <td>${scorePill(s.best_score)}</td>
    <td style="color:var(--text3)">${s.attempts}</td>
  </tr>`).join('');
}

// Render the per-artist breakdown table.
function renderArtistTable(byArtist) {
  const tbody = document.querySelector('#artist-table tbody');
  if (!byArtist?.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text3);padding:16px;text-align:center">Aucune donnée</td></tr>`;
    return;
  }
  tbody.innerHTML = byArtist.map(a => {
    const pct = a.total ? Math.round(a.played / a.total * 100) : 0;
    return `<tr>
      <td style="font-weight:600">${esc(a.artist)}</td>
      <td style="color:var(--text3)">${a.total}</td>
      <td style="color:var(--text3)">${a.played}</td>
      <td>
        <div class="progress-bar-wrap">
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
          <span class="progress-bar-label">${pct}%</span>
        </div>
      </td>
      <td>${a.avg_score != null ? scorePill(Math.round(a.avg_score)) : '<span style="color:var(--text3)">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Mastery picker popover ───────────────────────────────────────────

// Position and show the mastery picker popover near the clicked tag.
function openMasteryPicker(e, songId, currentMastery) {
  _pickerSongId = songId;
  const picker = document.getElementById('mastery-picker');
  picker.querySelectorAll('.mastery-pick-btn').forEach(btn =>
    btn.classList.toggle('current', btn.dataset.mastery === currentMastery)
  );
  picker.classList.remove('hidden');
  const rect = e.target.getBoundingClientRect();
  picker.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  picker.style.left = (rect.left  + window.scrollX) + 'px';
  e.stopPropagation();
}

// ── setMastery / setPlaylist ─────────────────────────────────────────

// Persist a mastery change and refresh the table and progress bar.
async function setMastery(songId, mastery) {
  const song = _allSongs.find(s => s.id === songId);
  if (!song) return;
  song.mastery = mastery;
  try {
    await api.put('/api/songs/' + songId + '/mastery', { mastery });
    showToast('Statut mis à jour');
  } catch (_) {
    showToast('Erreur de sauvegarde');
  }
  filterMasteryTable();
  if (_dashData) renderMasteryProgress({ ..._dashData, [mastery]: (_dashData[mastery] || 0) + 1 });
}

// Persist a playlist membership change and refresh the chips + table.
async function setPlaylist(songId, inPlaylist) {
  const song = _allSongs.find(s => s.id === songId);
  if (song) song.in_playlist = inPlaylist ? 1 : 0;
  try {
    await api.put('/api/songs/' + songId + '/playlist', { in_playlist: inPlaylist });
    showToast(inPlaylist ? 'Ajouté à la playlist' : 'Retiré de la playlist');
  } catch (_) {
    showToast('Erreur de sauvegarde');
  }
  filterMasteryTable();
  renderPlaylist(_allSongs.filter(s => s.in_playlist));
  if (_dashData) {
    _dashData.playlist = _allSongs.filter(s => s.in_playlist);
    document.getElementById('playlist-count').textContent =
      _dashData.playlist.length ? `(${_dashData.playlist.length})` : '';
  }
}

// ── Random play helpers ──────────────────────────────────────────────

// Pick a random song from the provided list and open the mode modal.
async function playRandom(songs) {
  if (!songs.length) { return; }
  const pick = songs[Math.floor(Math.random() * songs.length)];
  const { openModeModal } = await import('./game.js');
  // Switch to library view so the game modal has the right context
  document.querySelector('.nav-btn[data-view="library"]')?.click();
  openModeModal(pick.id);
}

// ── Static listeners (registered once via initDashboard) ─────────────

export function initDashboard() {
  let searchTimer;
  document.getElementById('dash-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => filterMasteryTable(), 200);
  });
  document.getElementById('dash-mastery-filter').addEventListener('change', () => filterMasteryTable());
  document.getElementById('dash-type-filter').addEventListener('change', () => filterMasteryTable());

  document.getElementById('mastery-picker').querySelectorAll('.mastery-pick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!_pickerSongId) return;
      await setMastery(_pickerSongId, btn.dataset.mastery);
      document.getElementById('mastery-picker').classList.add('hidden');
      _pickerSongId = null;
    });
  });

  document.addEventListener('click', () => {
    document.getElementById('mastery-picker').classList.add('hidden');
  });

  document.getElementById('btn-play-playlist').addEventListener('click', () => {
    const playlist = _allSongs.filter(s => s.in_playlist);
    playRandom(playlist);
  });

  document.getElementById('btn-play-maitrisee').addEventListener('click', () => {
    const mastered = _allSongs.filter(s => s.mastery === 'maitrisee');
    playRandom(mastered);
  });
}
