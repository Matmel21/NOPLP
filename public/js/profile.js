// ═══ PROFILE — identity, activity, stats ══════════════════════════
import { api }         from './api.js';
import { esc, showToast, promptDialog } from './utils.js';
import { getCurrentUser } from './auth.js';

let _user = null;

// ── Init ──────────────────────────────────────────────────────────

export function initProfile(user) {
  _user = user;

  document.getElementById('avatar-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { showToast('Image trop grande (max 4 Mo)'); return; }
    const reader = new FileReader();
    reader.onload = async ev => {
      const [meta, data] = ev.target.result.split(',');
      const type = meta.match(/:(.*?);/)[1];
      try {
        const { avatar_url } = await api.post('/api/profile/avatar', { data, type });
        _user.avatar_url = avatar_url;
        const authUser = getCurrentUser();
        if (authUser) authUser.avatar_url = avatar_url;
        renderAvatar(_user);
        showToast('Avatar mis à jour');
      } catch { showToast('Erreur lors du téléchargement'); }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-edit-username').addEventListener('click', async () => {
    const current = document.getElementById('profile-username').textContent;
    const val = await promptDialog({ title: 'Modifier le pseudo', value: current, maxLength: 64, confirmLabel: 'Enregistrer' });
    if (!val || val === current) return;
    api.put('/api/profile', { username: val.trim() })
      .then(({ user }) => { _user = user; renderIdentity(user); showToast('Nom mis à jour'); })
      .catch(() => showToast('Ce nom est déjà pris'));
  });

  document.getElementById('btn-edit-bio').addEventListener('click', async () => {
    const current = document.getElementById('profile-bio').textContent;
    const val = await promptDialog({ title: 'Modifier la bio', placeholder: '200 caractères max',
      value: current === 'Ajouter une bio…' ? '' : current, maxLength: 200, confirmLabel: 'Enregistrer', allowEmpty: true });
    if (val === null) return;
    api.put('/api/profile', { bio: val.trim() })
      .then(({ user }) => { _user = user; renderIdentity(user); showToast('Bio mise à jour'); })
      .catch(() => showToast('Erreur'));
  });
}

// ── Load ──────────────────────────────────────────────────────────

export async function loadProfile() {
  const [data, actData] = await Promise.all([
    api.get('/api/profile'),
    api.get('/api/profile/activity'),
  ]);
  _user = data.user;
  renderAvatar(data.user);
  renderIdentity(data.user);
  renderStats(data);
  renderWeek(actData);
  renderMasteryDonuts(data);
  renderTopArtists(data.topArtists);
  renderFavoriteSongs(data.favSongs || []);
}

// ── Avatar ────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#3a7bd5','#e05555','#4caf7d','#f0c060','#9b59b6','#e67e22'];

function avatarColor(name) {
  let h = 0;
  for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function renderAvatar(user) {
  const el = document.getElementById('profile-avatar');
  if (user.avatar_url) {
    // The URL is versioned on upload, so an identical src means the same image
    if (el.querySelector('img')?.getAttribute('src') === user.avatar_url) return;
    el.innerHTML = `<img src="${esc(user.avatar_url)}" alt="">`;
    el.style.background = 'none';
  } else {
    const initials = (user.username || '?').slice(0, 2).toUpperCase();
    el.innerHTML = `<span>${esc(initials)}</span>`;
    el.style.background = avatarColor(user.username);
  }
}

// ── Identity ──────────────────────────────────────────────────────

function renderIdentity(user) {
  document.getElementById('profile-username').textContent = user.username || '';
  const bioEl = document.getElementById('profile-bio');
  bioEl.textContent = user.bio || 'Ajouter une bio…';
  bioEl.classList.toggle('profile-bio-empty', !user.bio);
}

// ── Key stats ─────────────────────────────────────────────────────

function renderStats(data) {
  const items = [
    { label: 'Chansons jouées',   value: data.played },
    { label: 'Émissions jouées',  value: data.emissions },
    { label: 'Apprises',          value: data.maitrisee },
    { label: 'Taux de réussite',  value: (data.successRate ?? 0) + '%' },
  ];
  document.getElementById('profile-stats').innerHTML = items.map(i => `
    <div class="profile-stat-card">
      <div class="profile-stat-value">${i.value ?? 0}</div>
      <div class="profile-stat-label">${i.label}</div>
    </div>`).join('');
}

// ── Weekly streak timeline (Duolingo style) ──────────────────────

const DAY_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

function flameImg(cls = '') {
  return `<img class="flame ${cls}" src="/img/flame.webp" alt="" draggable="false">`;
}
const MISS_ICON = '<svg class="miss-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const NODE_ICON = { lit: () => flameImg(), pending: () => flameImg('dim'), missed: () => MISS_ICON, future: () => '' };

// 'YYYY-MM-DD' arithmetic at UTC noon so DST never shifts the day.
function addDays(key, n) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayTooltip(info) {
  const parts = [];
  if (info.plays)   parts.push(`${info.plays} chanson${info.plays > 1 ? 's' : ''} jouée${info.plays > 1 ? 's' : ''}`);
  if (info.learned) parts.push(`${info.learned} apprise${info.learned > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

function renderWeek({ today, days, streak, maxStreak, totalActiveDays }) {
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  const dow    = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;   // Mon = 0
  const monday = addDays(today, -dow);

  const week = DAY_FR.map((label, i) => {
    const date = addDays(monday, i);
    return { label, date, info: byDate[date], isToday: date === today, future: date > today };
  });

  const track = week.map((d, i) => {
    const state = d.info ? 'lit' : d.future ? 'future' : d.isToday ? 'pending' : 'missed';
    const tip   = d.info ? dayTooltip(d.info) : (d.future ? '' : 'Aucune activité');
    const link  = i < 6
      ? `<div class="week-link${d.info && week[i + 1].info ? ' lit' : ''}"></div>`
      : '';
    return `
      <div class="week-day ${state}${d.isToday ? ' today' : ''}" title="${tip}">
        <div class="week-node">${NODE_ICON[state]()}</div>
        <div class="week-label">${d.label}</div>
        <div class="week-date">${Number(d.date.slice(8))}</div>
      </div>${link}`;
  }).join('');

  document.getElementById('profile-activity').innerHTML = `
    <div class="week-head">
      <div class="week-streak${streak > 0 ? ' on' : ''}">
        ${flameImg(streak > 0 ? 'big' : 'big dim')}
        <div>
          <div class="week-streak-num">${streak}</div>
          <div class="week-streak-lbl">jour${streak > 1 ? 's' : ''} de suite</div>
        </div>
      </div>
      <div class="week-meta">
        <span><strong>${totalActiveDays}</strong> jour${totalActiveDays > 1 ? 's' : ''} actif${totalActiveDays > 1 ? 's' : ''}</span>
        <span class="week-meta-sep">·</span>
        <span>Meilleure série : <strong>${maxStreak}</strong></span>
      </div>
    </div>
    <div class="week-track">${track}</div>`;
}

// ── Mastery donuts ────────────────────────────────────────────────

const DONUT_SEGS = [
  { key: 'maitrisee',     from: '#3fbf7a', to: '#1e7d47', css: '--m-maitrisee', label: 'Apprises'     },
  { key: 'prevue',        from: '#4a8fe0', to: '#1a4d8f', css: '--m-prevue',    label: 'En cours'     },
  { key: 'revision',      from: '#f5ad55', to: '#c26a10', css: '--m-revision',  label: 'À revoir'     },
  { key: 'non_maitrisee', from: '#e0605a', to: '#a0281e', css: '--m-non',       label: 'Non révisées' },
];

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function buildDonutSvg(id, counts, total) {
  const r = 36, cx = 50, cy = 50, sw = 14;
  const defs = DONUT_SEGS.map(s => `
    <linearGradient id="${id}-${s.key}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${s.from}"/><stop offset="1" stop-color="${s.to}"/>
    </linearGradient>`).join('');
  let angle = 0;
  const paths = DONUT_SEGS.map(seg => {
    const val = counts[seg.key] || 0;
    if (!val || !total) return '';
    const share    = val / total;
    const endAngle = Math.min(angle + share * 360, 359.999);
    // Hover pushes each sector outward along its bisector (a full ring stays put)
    const mid  = ((angle + endAngle) / 2 - 90) * Math.PI / 180;
    const push = share < 0.999 ? 6 : 0;
    const d = describeArc(cx, cy, r, angle, endAngle);
    angle = endAngle;
    return `<path class="donut-seg" d="${d}" fill="none" stroke="url(#${id}-${seg.key})" stroke-width="${sw}"
              style="--dx:${(Math.cos(mid) * push).toFixed(2)}px;--dy:${(Math.sin(mid) * push).toFixed(2)}px"/>`;
  }).join('');
  const pct = total > 0 ? Math.round(((counts.maitrisee || 0) / total) * 100) : 0;
  return {
    svg: `<defs>${defs}</defs><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="${sw}"/>${paths}`,
    pct,
  };
}

function donutCard(id, title, counts, total) {
  const { svg, pct } = buildDonutSvg(id, counts, total);
  return `
    <div class="donut-card" tabindex="0">
      <div class="donut-title">${title}</div>
      <div class="donut-stage">
        <div class="donut-wrap">
          <svg viewBox="0 0 100 100" class="donut-svg">${svg}</svg>
          <div class="donut-center">${pct}<span class="donut-pct-sign">%</span></div>
        </div>
        <div class="donut-legend">
          ${DONUT_SEGS.map(s => {
            const v = counts[s.key] || 0;
            return `
            <div class="donut-leg-row">
              <span class="donut-leg-dot" style="background:var(${s.css})"></span>
              <span class="donut-leg-lbl">${s.label}</span>
              <b class="donut-leg-val">${v}</b>
              <span class="donut-leg-pct">${total ? Math.round(v / total * 100) : 0}%</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>`;
}

function renderMasteryDonuts(data) {
  const total = data.total_songs || 1;
  const all = {
    maitrisee:     data.maitrisee     || 0,
    prevue:        data.prevue        || 0,
    revision:      data.revision      || 0,
    non_maitrisee: data.non_maitrisee || 0,
  };
  const bt = data.byType || {};
  const tt = data.totals || {};

  document.getElementById('profile-mastery-row').innerHTML = `
    <div class="donut-grid">
      ${donutCard('dn-all', 'Tout', all, total)}
      ${donutCard('dn-mc', 'Même chanson', bt.mc || {}, tt.mc || 0)}
      ${donutCard('dn-fn', 'Finale', bt.fn || {}, tt.fn || 0)}
      ${donutCard('dn-other', 'Autres', bt.other || {}, tt.other || 0)}
    </div>`;
}

// ── Top lists ─────────────────────────────────────────────────────

function renderTopArtists(artists) {
  const el = document.getElementById('profile-top-artists');
  if (!artists?.length) { el.innerHTML = `<p class="profile-empty">Aucune chanson révisée</p>`; return; }
  const max = artists[0].tagged;
  el.innerHTML = artists.map((a, i) => `
    <div class="top-row">
      <span class="top-rank">${i + 1}</span>
      <div class="top-bar-wrap">
        <div class="top-bar-label">${esc(a.artist)}</div>
        <div class="top-bar-track"><div class="top-bar-fill" style="width:${Math.round(a.tagged/max*100)}%"></div></div>
      </div>
      <span class="top-count">${a.tagged}</span>
    </div>`).join('');
}

// ── Favorite songs (user-curated) ────────────────────────────────

let _favSongs = [];   // [{ id, title, artist }]
const favIds = () => _favSongs.map(s => s.id);

// Update the list at once, persist in the background, roll back on failure
async function saveFavorites(next) {
  const prev = _favSongs;
  renderFavoriteSongs(next);
  try { await api.put('/api/profile/favorites', { ids: favIds() }); }
  catch { renderFavoriteSongs(prev); showToast('Erreur de sauvegarde'); }
}

function renderFavoriteSongs(songs) {
  _favSongs = songs;
  const el = document.getElementById('profile-top-songs');
  el.innerHTML = `
    <div class="fav-list" id="fav-list">
      ${songs.length
        ? songs.map((s, i) => `
            <div class="top-row fav-item" data-id="${esc(s.id)}">
              <span class="top-rank">${i + 1}</span>
              <div class="top-bar-wrap">
                <div class="top-bar-label">${esc(s.title)} <span class="top-artist">${esc(s.artist)}</span></div>
              </div>
              <button class="fav-remove-btn" data-id="${esc(s.id)}" title="Retirer">✕</button>
            </div>`).join('')
        : `<p class="profile-empty">Aucune chanson favorite définie</p>`}
    </div>
    ${songs.length < 5
      ? `<button class="fav-add-btn" id="fav-add-btn">+ Ajouter une chanson</button>`
      : ''}`;

  el.querySelectorAll('.fav-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => saveFavorites(_favSongs.filter(s => s.id !== btn.dataset.id)));
  });

  document.getElementById('fav-add-btn')?.addEventListener('click', () => openFavPicker());
}

function openFavPicker() {
  const existing = document.getElementById('fav-picker-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'fav-picker-modal';
  modal.className = 'fav-picker-modal';
  modal.innerHTML = `
    <div class="fav-picker-box">
      <div class="fav-picker-header">
        <span>Choisir une chanson favorite</span>
        <button class="fav-picker-close" id="fav-picker-close">✕</button>
      </div>
      <input type="text" id="fav-picker-search" class="fav-picker-input" placeholder="Rechercher titre ou artiste…" autocomplete="off">
      <div class="fav-picker-results" id="fav-picker-results"></div>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('fav-picker-close').addEventListener('click', () => modal.remove());

  let debounce;
  const search = document.getElementById('fav-picker-search');
  search.addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => searchFavSongs(e.target.value), 120);
  });
  search.focus();
}

async function searchFavSongs(q) {
  if (q.trim().length < 2) { document.getElementById('fav-picker-results').innerHTML = ''; return; }
  const data = await api.get(`/api/songs?search=${encodeURIComponent(q)}&limit=8&offset=0`);
  const results = document.getElementById('fav-picker-results');
  if (!results) return;
  const ids = favIds();
  results.innerHTML = (data.songs || []).map(s => `
    <div class="fav-picker-row ${ids.includes(s.id) ? 'fav-picker-already' : ''}"
         data-id="${esc(s.id)}" data-title="${esc(s.title)}" data-artist="${esc(s.artist)}">
      <span class="fav-picker-title">${esc(s.title)}</span>
      <span class="fav-picker-artist">${esc(s.artist)}</span>
      ${ids.includes(s.id) ? '<span class="fav-picker-check">✓</span>' : ''}
    </div>`).join('');

  results.querySelectorAll('.fav-picker-row:not(.fav-picker-already)').forEach(row => {
    row.addEventListener('click', () => {
      if (_favSongs.length >= 5) { showToast('Maximum 5 chansons favorites'); return; }
      document.getElementById('fav-picker-modal')?.remove();
      const { id, title, artist } = row.dataset;
      saveFavorites([..._favSongs, { id, title, artist }]);
    });
  });
}
