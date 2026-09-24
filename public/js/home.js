// ═══ HOME VIEW — gamified dashboard ════════════════════════════════
import { api }                           from './api.js';
import { showView }                      from './nav.js';
import { esc, showToast, promptDialog }  from './utils.js';
import { state }                         from './state.js';
import { presetLibrary, refreshPlaylists } from './library.js';

let _user     = null;
let _data     = null;
let _revMode  = null;   // custom series modal
let _revCount = 5;

const MASTERY_LABEL = { maitrisee: 'Apprise', prevue: 'En cours', revision: 'À revoir' };
const SOURCE_LABEL  = { real: 'Vraies catégories', episode: 'Épisode rejoué', generated: 'Catégories inventées' };
const fr = n => Number(n || 0).toLocaleString('fr-FR');
const plural = (n, word) => `${fr(n)} ${word}${n > 1 ? 's' : ''}`;

// ── Public API ────────────────────────────────────────────────────

export function initHome(user) {
  _user = user;
  document.getElementById('home-root').addEventListener('click', onHomeClick);

  // Custom series modal (mode + count)
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
  document.getElementById('btn-start-revision').addEventListener('click', startCustomRevision);

  // Refresh XP, goal and streak after playing or tagging from the home screen
  const refreshIfHome = () => { if (state.view === 'home') loadHome(); };
  document.addEventListener('game-closed', refreshIfHome);
  document.addEventListener('mastery-changed', refreshIfHome);
}

export async function loadHome() {
  try {
    _data = await api.get('/api/home');
    render(_data);
    celebrateLevel(_data.level);
  } catch (_) { /* not logged in yet */ }
}

// ── Rendering ─────────────────────────────────────────────────────

function render(d) {
  const cards = [heroHtml(d), `<div class="home-row two">${continueHtml(d)}${challengeHtml(d)}</div>`,
                 coverageHtml(d), playlistsHtml(d), `<div class="home-row two">${badgesHtml(d)}${recentHtml(d)}</div>`];
  const root = document.getElementById('home-root');
  root.innerHTML = cards.join('');
  root.querySelectorAll('.home-card').forEach((c, i) => c.style.setProperty('--d', i));
}

function heroHtml({ level, streak }) {
  const span  = level.nextLevel - level.levelStart;
  const inLvl = level.xp - level.levelStart;
  const xpPct = Math.round(inLvl / span * 100);
  const goalPct = Math.min(1, streak.today / streak.goal);
  const done = streak.today >= streak.goal;
  const left = streak.goal - streak.today;
  const goalMain = done ? 'Objectif atteint !' : streak.today ? `Encore ${plural(left, 'chanson')}` : `0 sur ${streak.goal} chansons`;
  const goalSub  = done ? `${plural(streak.today, 'chanson')} aujourd'hui`
                 : streak.atRisk ? 'Ta série est en jeu aujourd’hui'
                 : streak.today ? 'pour l’objectif du jour' : 'Joue ou apprends une chanson';
  const circ = 2 * Math.PI * 40;
  return `
    <section class="home-card home-hero">
      <div class="hero-id">
        <div class="hero-greeting">Bonjour, <span>${esc(_user?.username || '')}</span></div>
        <div class="hero-level">
          <span class="level-chip">Niveau ${level.level}</span>
          <span class="level-title">${esc(level.title)}</span>
        </div>
        <div class="xp-row">
          <div class="xp-bar"><div class="xp-fill" style="--w:${xpPct}%"></div></div>
          <span class="xp-text">${fr(inLvl)} / ${fr(span)} XP</span>
        </div>
      </div>
      <div class="hero-streak${streak.current ? ' on' : ''}${streak.atRisk ? ' risk' : ''}">
        <img class="flame big${streak.current ? '' : ' dim'}" src="/img/flame.webp" alt="" draggable="false">
        <div>
          <div class="hero-streak-num">${streak.current}</div>
          <div class="home-lbl">jour${streak.current > 1 ? 's' : ''} de suite</div>
          <div class="hero-sub">${streak.atRisk ? 'Joue aujourd’hui pour la garder' : `Meilleure série : ${streak.best}`}</div>
        </div>
      </div>
      <div class="hero-goal${done ? ' done' : ''}">
        <svg viewBox="0 0 100 100" class="goal-ring" aria-hidden="true">
          <circle cx="50" cy="50" r="40" class="goal-track"/>
          <circle cx="50" cy="50" r="40" class="goal-fill" style="--circ:${circ.toFixed(1)};--off:${(circ * (1 - goalPct)).toFixed(1)}"/>
          <text x="50" y="57" text-anchor="middle">${Math.min(streak.today, streak.goal)}/${streak.goal}</text>
        </svg>
        <div>
          <div class="home-lbl">Objectif du jour</div>
          <div class="hero-goal-main">${goalMain}</div>
          <div class="hero-sub">${goalSub}</div>
        </div>
      </div>
    </section>`;
}

function pillHtml(song) {
  return `
    <div class="home-pill">
      <div class="home-pill-title">${esc(song.title)}</div>
      <div class="home-pill-sub">${esc(song.artist)}${song.year ? ` - ${song.year}` : ''}</div>
    </div>`;
}

function continueHtml({ queue }) {
  const head = `
    <div class="card-head">
      <span class="home-lbl">Continuer la révision</span>
      <span class="card-meta">File : ${plural(queue.total, 'chanson')}${queue.total ? ` (${fr(queue.prevue)} en cours · ${fr(queue.revision)} à revoir)` : ''}</span>
    </div>`;
  if (!queue.next) {
    return `
      <section class="home-card home-continue">
        ${head}
        <p class="home-empty">Ta file est vide. Marque des chansons « En cours » ou « À revoir » dans la bibliothèque, ou commence par les priorités ci-dessous.</p>
        <div class="card-actions">
          <button class="home-btn" data-action="library">Ouvrir la bibliothèque</button>
          <button class="home-link" data-action="custom">Série personnalisée…</button>
        </div>
      </section>`;
  }
  const n = queue.next;
  const last = n.last_played ? `Dernier essai : ${n.last_score ?? 0} % · ${ago(n.last_played)}` : 'Jamais jouée';
  return `
    <section class="home-card home-continue">
      ${head}
      ${pillHtml(n)}
      <div class="continue-info">
        <span class="mastery-mini ${n.mastery}">${MASTERY_LABEL[n.mastery]}</span>
        <span class="card-meta">${last}</span>
      </div>
      <div class="card-actions">
        <button class="home-btn" data-action="play" data-id="${esc(n.id)}">&#9654; Réviser maintenant</button>
        <button class="home-btn ghost" data-action="launch" data-source="queue">Série rapide · ${Math.min(10, queue.total)}</button>
        <button class="home-link" data-action="custom">Personnaliser…</button>
      </div>
    </section>`;
}

function challengeHtml({ challenge: c }) {
  if (!c) {
    return `
      <section class="home-card home-challenge done">
        <div class="card-head"><span class="home-lbl gold">Défi du jour</span></div>
        <p class="home-empty">Tu connais toutes les chansons diffusées cette année. Chapeau !</p>
      </section>`;
  }
  return `
    <section class="home-card home-challenge${c.completed ? ' done' : ''}">
      <div class="card-head">
        <span class="home-lbl gold">Défi du jour</span>
        <span class="xp-tag">+${c.xp} XP</span>
      </div>
      ${pillHtml(c)}
      <div class="card-meta">Sortie ${fr(c.aired_12m)} fois ces 12 derniers mois · réussis-la à ${c.pass} % ou plus.</div>
      ${c.completed
        ? '<div class="challenge-done">&#10003; Défi relevé ! Nouveau défi demain.</div>'
        : `<div class="card-actions"><button class="home-btn gold" data-action="play" data-id="${esc(c.id)}">Relever le défi</button></div>`}
    </section>`;
}

function coverageHtml({ coverage: c }) {
  return `
    <section class="home-card home-coverage">
      <div class="cov-left">
        <span class="home-lbl">Prêt pour l'émission ?</span>
        <div class="cov-figure">
          <span class="cov-num">${c.pct}<small>%</small></span>
          <span class="cov-cap">du répertoire diffusé<br>ces 12 derniers mois</span>
        </div>
        <div class="cov-bar"><div class="cov-fill" style="--w:${Math.max(c.pct, 1)}%"></div></div>
        <p class="card-meta">${fr(c.known)} chansons apprises sur les ${fr(c.aired)} sorties dans l'émission depuis un an. Les plus diffusées d'abord : ce sont elles qui reviennent le plus.</p>
      </div>
      <div class="cov-right">
        <div class="card-head">
          <span class="home-lbl">À apprendre en priorité</span>
          <button class="home-link" data-action="open-smart" data-type="year_todo">Tout voir</button>
        </div>
        ${c.priority.map(p => `
          <button class="prio-row" data-action="play" data-id="${esc(p.id)}">
            <span class="prio-count">${p.aired}×</span>
            <span class="prio-title">${esc(p.title)} <span>· ${esc(p.artist)}</span></span>
            <span class="prio-go">&#9654; Réviser</span>
          </button>`).join('') || '<p class="home-empty">Rien à rattraper !</p>'}
      </div>
    </section>`;
}

function playlistsHtml({ playlists, smart }) {
  const card = ({ name, meta, open, launch, star, isDefault, empty }) => `
    <div class="home-card pl-card">
      <div class="pl-card-head">
        <button class="pl-name" ${open}>${star ? '&#9733; ' : ''}${esc(name)}</button>
        ${isDefault ? '<span class="tag-soft">Par défaut</span>' : ''}
      </div>
      <div class="card-meta">${meta}</div>
      <button class="home-btn small" ${launch}${empty ? ' disabled' : ''}>&#9654; Lancer</button>
    </div>`;
  return `
    <section class="home-section">
      <div class="card-head">
        <span class="home-lbl">Mes playlists</span>
        <button class="home-link" data-action="library">Bibliothèque &#8594;</button>
      </div>
      <div class="pl-grid">
        ${playlists.map(pl => card({
          name: pl.name, star: pl.is_default, isDefault: pl.is_default, empty: !pl.count,
          meta: plural(pl.count, 'chanson'),
          open: `data-action="open-playlist" data-id="${pl.id}"`,
          launch: `data-action="launch" data-source="playlist" data-id="${pl.id}"`,
        })).join('')}
        ${card({ name: 'Tubes de l’année à apprendre', meta: `Liste auto · ${plural(smart.year_todo, 'chanson')}`, empty: !smart.year_todo,
                 open: 'data-action="open-smart" data-type="year_todo"', launch: 'data-action="launch" data-source="year_todo"' })}
        ${card({ name: 'Même chanson', meta: `Liste auto · ${plural(smart.mc, 'chanson')}`, empty: !smart.mc,
                 open: 'data-action="open-smart" data-type="mc"', launch: 'data-action="launch" data-source="mc"' })}
        <button class="pl-new" data-action="new-playlist">+ Nouvelle playlist</button>
      </div>
    </section>`;
}

function badgeHtml(b) {
  return `
    <div class="badge-item${b.unlocked ? '' : ' locked'}" title="${esc(b.desc)}">
      <div class="badge-disc ${b.tier}">${esc(b.icon)}</div>
      <span class="badge-name">${esc(b.label)}</span>
      ${b.unlocked ? '' : `<span class="badge-progress">${fr(b.value)} / ${fr(b.goal)}</span>`}
    </div>`;
}

function badgesHtml({ badges }) {
  const unlocked = badges.filter(b => b.unlocked);
  const nextUp = badges.filter(b => !b.unlocked).sort((a, b) => b.value / b.goal - a.value / a.goal);
  const shown = [...unlocked.slice(-4).reverse(), ...nextUp.slice(0, 6 - Math.min(4, unlocked.length))];
  return `
    <section class="home-card home-badges">
      <div class="card-head">
        <span class="home-lbl">Badges</span>
        <button class="home-link" data-action="badges">${unlocked.length} / ${badges.length} · Tout voir</button>
      </div>
      <div class="badge-row">${shown.map(badgeHtml).join('')}</div>
    </section>`;
}

function recentHtml({ recent }) {
  const scoreTag = s => `<span class="score-pill ${s >= 80 ? 'high' : s >= 50 ? 'mid' : 'low'}">${s} %</span>`;
  const rows = recent.map(r => r.type === 'song'
    ? `<button class="recent-row" data-action="play" data-id="${esc(r.id)}">
         <span class="recent-title">${esc(r.title)} <span>· ${esc(r.artist)}</span></span>
         <span class="recent-when">${ago(r.at)}</span>${scoreTag(r.score ?? 0)}
       </button>`
    : `<div class="recent-row">
         <span class="recent-title">Émission <span>· ${SOURCE_LABEL[r.source] || ''}${r.mode === 'duel' ? ' · 1 contre 1' : ''}</span></span>
         <span class="recent-when">${ago(r.at)}</span>
         <span class="score-pill emission">${r.mode === 'duel' ? `${r.score} – ${r.oppScore}` : `${r.score} pts`}</span>
       </div>`).join('');
  return `
    <section class="home-card home-recent">
      <div class="card-head"><span class="home-lbl">Activité récente</span></div>
      ${rows || '<p class="home-empty">Rien pour l’instant : lance ta première révision !</p>'}
    </section>`;
}

// ── Actions ───────────────────────────────────────────────────────

async function onHomeClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id, source, type } = el.dataset;
  switch (action) {
    case 'play':          return openSong(id);
    case 'launch':        return startSeries(source, id);
    case 'custom':        return openRevisionModal();
    case 'library':       return showView('library');
    case 'open-playlist': presetLibrary({ playlist: Number(id) }); return showView('library');
    case 'open-smart':    presetLibrary({ type });                 return showView('library');
    case 'new-playlist':  return createPlaylist();
    case 'badges':        return openBadges();
  }
}

async function openSong(id) {
  state.revisionQueue = [];
  const { openModeModal } = await import('./game.js');
  openModeModal(id);
}

async function startSeries(source, id) {
  const params = new URLSearchParams({ source, count: 10 });
  if (id) params.set('id', id);
  try {
    const songs = await api.get('/api/revision-queue?' + params);
    if (!songs.length) { showToast('Aucune chanson à réviser ici'); return; }
    state.revisionQueue    = songs;
    state.revisionQueueIdx = 0;
    const { openModeModal } = await import('./game.js');
    openModeModal(songs[0].id);
  } catch { showToast('Erreur lors du chargement'); }
}

async function createPlaylist() {
  const name = await promptDialog({ title: 'Nouvelle playlist', placeholder: 'Nom de la playlist', maxLength: 60, confirmLabel: 'Créer' });
  if (!name) return;
  await api.post('/api/playlists', { name });
  await refreshPlaylists();
  loadHome();
}

function openBadges() {
  const modal = document.createElement('div');
  modal.id = 'badges-modal';
  modal.className = 'app-dialog';
  const unlocked = _data.badges.filter(b => b.unlocked).length;
  modal.innerHTML = `
    <div class="app-dialog-box badges-box" role="dialog" aria-modal="true" aria-labelledby="badges-title">
      <div class="app-dialog-title" id="badges-title">Badges · ${unlocked} / ${_data.badges.length}</div>
      <div class="badge-grid">${_data.badges.map(b => `
        <div class="badge-cell${b.unlocked ? '' : ' locked'}">
          ${badgeHtml(b)}
          <span class="badge-desc">${esc(b.desc)}</span>
        </div>`).join('')}</div>
      <div class="app-dialog-actions"><button type="button" class="app-dialog-btn confirm">Fermer</button></div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
  modal.querySelector('.confirm').addEventListener('click', close);
  modal.querySelector('.confirm').focus();
}

// Toast when the level went up since the last visit on this device
function celebrateLevel(level) {
  const key = `noplr-level-${_user?.id}`;
  let seen = null;
  try { seen = Number(localStorage.getItem(key)) || null; localStorage.setItem(key, level.level); } catch (_) {}
  if (seen && level.level > seen) {
    showToast(`Niveau ${level.level} atteint : ${level.title} !`);
    document.querySelector('.level-chip')?.classList.add('level-up');
  }
}

// ── Custom series modal ───────────────────────────────────────────

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

async function startCustomRevision() {
  if (!_revMode) return;
  closeRevisionModal();
  const params = new URLSearchParams({ count: _revCount });
  if (_revMode === 'mc') params.set('mc', '1');
  else if (_revMode !== 'random') params.set('mastery', _revMode);
  try {
    const songs = await api.get('/api/revision-queue?' + params);
    if (!songs.length) {
      const labels = { maitrisee: 'apprise', revision: 'à revoir', prevue: 'en cours', mc: '« Même chanson »', random: '' };
      showToast(`Aucune chanson ${labels[_revMode] || ''} trouvée`);
      return;
    }
    state.revisionQueue    = songs;
    state.revisionQueueIdx = 0;
    const { openModeModal } = await import('./game.js');
    openModeModal(songs[0].id);
  } catch { showToast('Erreur lors du chargement'); }
}

// ── Helpers ───────────────────────────────────────────────────────

// SQLite datetime('now') is UTC without a zone marker
function ago(ts) {
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000;
  if (s < 60)    return 'à l’instant';
  if (s < 3600)  return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'hier' : `il y a ${days} jours`;
}
