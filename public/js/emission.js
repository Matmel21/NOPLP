// ═══ EMISSION — mode émission NOPLP ════════════════════════════════
import { state }      from './state.js';
import { api }        from './api.js';
import { esc }        from './utils.js';
import { startGame }  from './game.js';

// ── Module-level emission state ───────────────────────────────────

let emissionData        = null;
let playedCount         = 0;
let currentPlayer       = 1;
let currentPlayingLevel = null;
let emissionSource      = 'real';
let playerMode          = 'duel';
let scores              = [0, 0];
let _user               = null;
let _duelNames          = ['', ''];  // [player1 name, player2 name]

const SOURCE_LABEL = {
  real:      'Vraies catégories',
  episode:   'Rejouer un épisode',
  generated: 'Catégories inventées',
};

function categoryCount() {
  // Non-prise tiles are displayed but not playable — don't count them
  return (emissionData?.pairs || []).filter(p => p && !p.nonPrise).length;
}

// ── Avatar helpers ────────────────────────────────────────────────

const AVATAR_COLORS = ['#3a7bd5','#e05555','#4caf7d','#f0c060','#9b59b6','#e67e22'];
function avatarColor(name) {
  let h = 0;
  for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function playerAvatarHtml(name, avatarUrl) {
  if (avatarUrl) {
    return `<div class="ep-avatar"><img src="${avatarUrl}" alt=""></div>`;
  }
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const color    = avatarColor(name);
  return `<div class="ep-avatar" style="background:${color}">${esc(initials)}</div>`;
}

// ── Board rendering ───────────────────────────────────────────────

const LEVEL_COLOR = {
  50: '#0d4a2e', 40: '#2e3d0d', 30: '#0d2a4a', 20: '#4a0d0d', 10: '#2a0d4a',
};

function bannersHtml(allDone) {
  if (playerMode === 'solo') {
    const name = _user?.username || 'Joueur';
    return `
      <div class="emission-players solo">
        <div class="emission-player active">
          ${playerAvatarHtml(name, _user?.avatar_url)}
          <div class="ep-name">${esc(name)}</div>
          <div class="ep-score">${scores[0]}</div>
        </div>
      </div>`;
  }
  const p1 = !allDone && currentPlayer === 1;
  const p2 = !allDone && currentPlayer === 2;
  const lead = allDone
    ? (scores[0] === scores[1] ? '' : (scores[0] > scores[1] ? 'win-left' : 'win-right'))
    : '';
  const n1 = _duelNames[0] || 'Joueur 1';
  const n2 = _duelNames[1] || 'Joueur 2';
  const av1 = _duelNames[0] === _user?.username ? playerAvatarHtml(n1, _user?.avatar_url) : playerAvatarHtml(n1);
  return `
    <div class="emission-players duel ${lead}">
      <div class="emission-player${p1 ? ' active' : ''}${lead === 'win-left' ? ' winner' : ''}">
        ${av1}
        <div class="ep-name">${esc(n1)}</div>
        <div class="ep-score">${scores[0]}</div>
      </div>
      <div class="emission-vs">${allDone ? 'FIN' : 'VS'}</div>
      <div class="emission-player${p2 ? ' active' : ''}${lead === 'win-right' ? ' winner' : ''}">
        ${playerAvatarHtml(n2)}
        <div class="ep-name">${esc(n2)}</div>
        <div class="ep-score">${scores[1]}</div>
      </div>
    </div>`;
}

function doneMessage() {
  const n1 = _duelNames[0] || 'Joueur 1';
  const n2 = _duelNames[1] || 'Joueur 2';
  if (playerMode === 'solo') return `Émission terminée ! Score : ${scores[0]} pts`;
  if (scores[0] === scores[1]) return `Égalité ! ${scores[0]} – ${scores[1]}`;
  const winner = scores[0] > scores[1] ? n1 : n2;
  return `${winner} l'emporte ${Math.max(...scores)} – ${Math.min(...scores)} !`;
}

export function renderEmissionBoard() {
  const container = document.getElementById('emission-container');
  if (!emissionData) {
    const ownName = _user?.username || '';
    container.innerHTML = `
      <div class="emission-empty">
        <div class="emission-logo">N'OUBLIEZ PAS LES PAROLES</div>

        <p class="emission-empty-text">Type de partie :</p>
        <div class="emission-playermode">
          <button class="pmode-btn${playerMode === 'solo' ? ' active' : ''}" data-pmode="solo">Solo</button>
          <button class="pmode-btn${playerMode === 'duel' ? ' active' : ''}" data-pmode="duel">1 contre 1</button>
        </div>

        <div id="duel-config" class="duel-config${playerMode === 'duel' ? '' : ' hidden'}">
          <div class="duel-config-row">
            <label class="duel-config-label">Joueur 1</label>
            <input id="duel-name-1" class="duel-name-input" type="text"
              placeholder="Nom du joueur 1" value="${esc(_duelNames[0] || ownName)}">
          </div>
          <div class="duel-config-row">
            <label class="duel-config-label">Joueur 2</label>
            <input id="duel-name-2" class="duel-name-input" type="text"
              placeholder="Nom du joueur 2" value="${esc(_duelNames[1])}">
          </div>
        </div>

        <p class="emission-empty-text">Type d'émission :</p>
        <div class="emission-source-choice">
          <button class="btn-primary btn-emission-start" data-source="real">Vraies catégories</button>
          <button class="btn-primary btn-emission-start" data-source="episode">Rejouer un épisode</button>
          <button class="btn-primary btn-emission-start" data-source="generated">Catégories inventées</button>
        </div>
        <p class="emission-source-hint">Catégories &amp; chansons issues des vraies émissions (archives du wiki).</p>
      </div>`;

    // Player mode toggle
    container.querySelectorAll('[data-pmode]').forEach(b =>
      b.addEventListener('click', () => {
        playerMode = b.dataset.pmode;
        container.querySelectorAll('[data-pmode]').forEach(x => x.classList.toggle('active', x === b));
        document.getElementById('duel-config')?.classList.toggle('hidden', playerMode !== 'duel');
      }));

    // Save duel names on input
    document.getElementById('duel-name-1')?.addEventListener('input', e => { _duelNames[0] = e.target.value.trim(); });
    document.getElementById('duel-name-2')?.addEventListener('input', e => { _duelNames[1] = e.target.value.trim(); });
    // Init names from current input values (pre-filled)
    if (!_duelNames[0] && ownName) _duelNames[0] = ownName;

    // Source buttons
    container.querySelectorAll('[data-source]').forEach(b =>
      b.addEventListener('click', () => {
        if (b.dataset.source === 'episode') { openEpisodePicker(); }
        else { generateEmission(b.dataset.source); }
      }));
    return;
  }

  const totalCats  = categoryCount();
  const mcUnlocked = playedCount >= totalCats;
  const mcPlayed   = emissionData.mcSong?.played;
  const allDone    = mcPlayed || (mcUnlocked && !emissionData.mcSong);

  const tilesHtml = emissionData.pairs.map(pair => {
    if (!pair) return '';
    const played   = pair.played;
    const nonPrise = pair.nonPrise;
    const color    = LEVEL_COLOR[pair.level] || '#1a1a2e';
    return `
      <div class="emission-tile${played ? ' played' : ''}${nonPrise ? ' non-prise' : ''}"
           data-level="${pair.level}" style="--tile-bg: ${color}">
        <div class="emission-tile-pts">${pair.level}<span>pts</span></div>
        <div class="emission-tile-name">${esc(pair.categoryName)}</div>
        ${played    ? '<div class="emission-tile-check">Joué</div>' : ''}
        ${nonPrise  ? '<div class="emission-tile-check">Non prise</div>' : ''}
      </div>`;
  }).join('');

  const remaining = totalCats - playedCount;
  const mcLockMsg = remaining > 0 ? `Jouez encore ${remaining} catégorie${remaining > 1 ? 's' : ''}` : '';
  const mcHtml = emissionData.mcSong ? `
    <div class="emission-tile emission-mc-tile${!mcUnlocked ? ' locked' : ''}${mcPlayed ? ' played' : ''}"
         id="emission-mc-tile">
      <div class="emission-mc-star">★</div>
      <div class="emission-mc-label">C'EST LA MÊME CHANSON</div>
      ${!mcUnlocked ? `<div class="emission-mc-lock">${mcLockMsg}</div>` : ''}
      ${mcPlayed ? '<div class="emission-tile-check">Joué</div>' : ''}
    </div>` : '';

  const n1 = _duelNames[0] || 'Joueur 1';
  const statusHtml = allDone
    ? `<div class="emission-done">${doneMessage()}</div>`
    : (playerMode === 'duel'
        ? `<div class="emission-turn">Au tour de <strong>${esc(currentPlayer === 1 ? n1 : (_duelNames[1] || 'Joueur 2'))}</strong></div>`
        : '');

  container.innerHTML = `
    <div class="emission-board">
      <div class="emission-board-header">
        <div class="emission-board-title">N'OUBLIEZ PAS LES PAROLES</div>
        <div class="emission-board-sub">${esc(SOURCE_LABEL[emissionSource] || 'Mode Émission')}</div>
      </div>
      ${bannersHtml(allDone)}
      ${statusHtml}
      <div class="emission-tiles">
        ${tilesHtml}
        ${mcHtml}
      </div>
      <button id="btn-new-emission" class="btn-ghost btn-sm emission-new-btn">↺ Nouvelle émission</button>
    </div>`;

  container.querySelectorAll('.emission-tile[data-level]').forEach(tile => {
    if (tile.classList.contains('played'))    return;
    if (tile.classList.contains('non-prise')) return;
    if (playedCount >= totalCats) return;
    tile.addEventListener('click', () => {
      const level = parseInt(tile.dataset.level);
      const pair  = emissionData.pairs.find(p => p?.level === level && !p.played && !p.nonPrise);
      if (pair) openPick(pair);
    });
  });

  const mcTile = document.getElementById('emission-mc-tile');
  if (mcTile && mcUnlocked && !mcPlayed) mcTile.addEventListener('click', startMcGame);

  document.getElementById('btn-new-emission')?.addEventListener('click', () => {
    if (!confirm('Générer une nouvelle émission ?')) return;
    const src = emissionSource;
    resetEmission();
    generateEmission(src);
  });
}

// ── Episode picker (calendar) ─────────────────────────────────────

const CAL_MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet',
                    'Août','Septembre','Octobre','Novembre','Décembre'];
const CAL_DOW    = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];

let _episodesByDate = {};   // 'YYYY-MM-DD' → [{id, emission_no}, ...]
let _calYear  = null;       // currently displayed month
let _calMonth = null;
let _selectedDate = null;

async function openEpisodePicker() {
  document.getElementById('episode-picker-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('episode-emission-choice').classList.add('hidden');
  _selectedDate = null;

  const calEl = document.getElementById('episode-calendar');

  if (!Object.keys(_episodesByDate).length) {
    calEl.innerHTML = '<div class="episode-loading">Chargement…</div>';
    let episodes;
    try { episodes = await api.get('/api/emission/episodes'); }
    catch { calEl.innerHTML = '<div class="episode-loading">Erreur de chargement.<br>Le serveur a-t-il été redémarré ?</div>'; return; }

    if (!episodes.length) {
      calEl.innerHTML = '<div class="episode-loading">Aucun épisode en base.</div>';
      return;
    }
    for (const ep of episodes) {
      (_episodesByDate[ep.air_date] ||= []).push({ id: ep.id, emission_no: ep.emission_no });
    }
    // Default to the most recent month that has episodes
    const latest = episodes[0].air_date; // API returns DESC
    _calYear  = parseInt(latest.slice(0, 4));
    _calMonth = parseInt(latest.slice(5, 7)) - 1;
  }

  renderCalendar();
}

function closeEpisodePicker() {
  document.getElementById('episode-picker-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderCalendar() {
  document.getElementById('cal-month-label').textContent = `${CAL_MONTHS[_calMonth]} ${_calYear}`;

  // First day of month → which weekday column (Mon=0)
  const first = new Date(_calYear, _calMonth, 1);
  const startCol = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();

  let cells = CAL_DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');

  // Leading blanks
  for (let i = 0; i < startCol; i++) cells += `<div class="cal-cell cal-empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${_calYear}-${String(_calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const eps = _episodesByDate[key];
    const hasEps = !!eps;
    const sel = _selectedDate === key ? ' selected' : '';
    cells += `
      <div class="cal-cell${hasEps ? ' has-eps' : ' no-eps'}${sel}"
           ${hasEps ? `data-date="${key}"` : ''}>
        <span class="cal-day-num">${day}</span>
        ${hasEps ? `<span class="cal-day-dot">${eps.length}</span>` : ''}
      </div>`;
  }

  document.getElementById('episode-calendar').innerHTML = cells;

  document.querySelectorAll('#episode-calendar .cal-cell.has-eps').forEach(cell => {
    cell.addEventListener('click', () => selectDate(cell.dataset.date));
  });
}

function selectDate(key) {
  _selectedDate = key;
  renderCalendar();

  const eps = (_episodesByDate[key] || []).slice().sort((a, b) => a.emission_no - b.emission_no);
  const label = new Date(key + 'T12:00:00').toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const choiceEl = document.getElementById('episode-emission-choice');
  choiceEl.innerHTML = `
    <div class="ep-choice-date">${esc(label)}</div>
    <div class="ep-choice-btns">
      ${eps.map(ep => `
        <button class="ep-pick-btn" data-id="${ep.id}">Émission ${ep.emission_no}</button>
      `).join('')}
    </div>`;
  choiceEl.classList.remove('hidden');

  choiceEl.querySelectorAll('.ep-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      closeEpisodePicker();
      generateEmission('episode', parseInt(btn.dataset.id));
    });
  });
}

function calShift(delta) {
  _calMonth += delta;
  if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
  if (_calMonth > 11) { _calMonth = 0;  _calYear++; }
  renderCalendar();
}

// ── Song pick overlay ─────────────────────────────────────────────

function openPick(pair) {
  currentPlayingLevel = pair.level;
  document.getElementById('emission-pick-level').textContent =
    `${pair.level} pts — ${pair.categoryName}`;
  document.getElementById('emission-pick-songs').innerHTML = pair.songs.map(song => `
    <div class="emission-song-card" data-id="${esc(song.id)}" data-blank-level="${song.blankLevel || pair.level}">
      <div class="emission-song-title">${esc(song.title)}</div>
      <div class="emission-song-artist">${esc(song.artist)}${song.year ? ' · ' + song.year : ''}</div>
      <div class="emission-song-play">▶ Choisir</div>
    </div>`).join('');
  const modal = document.getElementById('emission-pick-modal');
  modal.querySelectorAll('.emission-song-card').forEach(card => {
    // blankLevel may be set per-song when the episode's category level (e.g. 60)
    // exceeds the scraped range (10-50); fall back to the category level otherwise.
    const blankLevel = parseInt(card.dataset.blankLevel) || pair.level;
    card.addEventListener('click', () => { closePick(); startEmissionGame(card.dataset.id, blankLevel); });
  });
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closePick() {
  document.getElementById('emission-pick-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── Game launch ───────────────────────────────────────────────────

async function startEmissionGame(songId, level) {
  const data = await api.get('/api/songs/' + encodeURIComponent(songId));
  state.song = data;
  startGame('normal', level, 0, 'classic');
}

async function startMcGame() {
  if (!emissionData?.mcSong) return;
  currentPlayingLevel = null;
  const data = await api.get('/api/songs/' + encodeURIComponent(emissionData.mcSong.id));
  state.song = data;
  const startSrc = data.karaoke_url?.trim() ? 'karaoke' : 'classic';
  startGame('mc', 20, 0, startSrc);
}

// ── Called by game.js when the game modal closes ──────────────────

export function onEmissionGameClose() {
  if (currentPlayingLevel !== null) {
    const pair = emissionData?.pairs.find(p => p?.level === currentPlayingLevel && !p.played);
    if (pair) {
      const won = Math.round(state.score || 0) >= 100;
      if (won) scores[currentPlayer - 1] += pair.level;
      pair.played = true;
      pair.wonBy  = won ? currentPlayer : null;
      playedCount++;
      if (playerMode === 'duel') currentPlayer = currentPlayer === 1 ? 2 : 1;
    }
    currentPlayingLevel = null;
  } else {
    if (emissionData?.mcSong) emissionData.mcSong.played = true;
  }
  renderEmissionBoard();
}

// ── Generate & reset ──────────────────────────────────────────────

function resetEmission() {
  emissionData        = null;
  playedCount         = 0;
  currentPlayer       = 1;
  currentPlayingLevel = null;
  scores              = [0, 0];
}

async function generateEmission(source = 'real', episodeId = null) {
  emissionSource = source;
  const container = document.getElementById('emission-container');
  container.innerHTML = `<div class="emission-loading">Génération de l'émission…</div>`;

  // Save duel names from inputs before the board re-renders
  const n1 = document.getElementById('duel-name-1')?.value.trim();
  const n2 = document.getElementById('duel-name-2')?.value.trim();
  if (n1) _duelNames[0] = n1;
  if (n2) _duelNames[1] = n2;
  // Solo: reset so banner uses real user info
  if (playerMode === 'solo') _duelNames = ['', ''];

  try {
    const body = { source };
    if (episodeId) body.episodeId = episodeId;
    const data = await api.post('/api/emission/generate', body);
    emissionData = data;
    emissionData.pairs = (emissionData.pairs || []).map(p => p ? { ...p, played: false } : null);
    if (emissionData.mcSong) emissionData.mcSong.played = false;
    playedCount   = 0;
    currentPlayer = 1;
    scores        = [0, 0];
    renderEmissionBoard();
  } catch (err) {
    container.innerHTML = `
      <div class="emission-error">
        <p>Erreur lors de la génération : ${esc(err.message || 'inconnue')}</p>
        <button id="btn-retry-emission" class="btn-primary">Réessayer</button>
      </div>`;
    document.getElementById('btn-retry-emission')
      .addEventListener('click', () => generateEmission(emissionSource, episodeId));
  }
}

// ── Init ─────────────────────────────────────────────────────────

export function initEmission(user) {
  _user = user;
  if (user?.username) _duelNames[0] = user.username;

  document.getElementById('btn-close-emission-pick')
    .addEventListener('click', closePick);
  document.getElementById('emission-pick-overlay')
    .addEventListener('click', closePick);
  document.getElementById('btn-close-episode-picker')
    .addEventListener('click', closeEpisodePicker);
  document.getElementById('episode-picker-overlay')
    .addEventListener('click', closeEpisodePicker);
  document.getElementById('cal-prev').addEventListener('click', () => calShift(-1));
  document.getElementById('cal-next').addEventListener('click', () => calShift(1));
}
