// ═══ PROFILE — identity, activity, stats ══════════════════════════
import { api }         from './api.js';
import { esc, showToast } from './utils.js';

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
        renderAvatar(_user);
        showToast('Avatar mis à jour');
      } catch { showToast('Erreur lors du téléchargement'); }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-edit-username').addEventListener('click', () => {
    const current = document.getElementById('profile-username').textContent;
    const val = prompt('Nouveau nom :', current);
    if (!val || val.trim() === current) return;
    api.put('/api/profile', { username: val.trim() })
      .then(({ user }) => { _user = user; renderIdentity(user); showToast('Nom mis à jour'); })
      .catch(() => showToast('Ce nom est déjà pris'));
  });

  document.getElementById('btn-edit-bio').addEventListener('click', () => {
    const current = document.getElementById('profile-bio').textContent;
    const val = prompt('Bio (200 caractères max) :', current === 'Ajouter une bio…' ? '' : current);
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
  renderActivity(actData.activity, actData.streak, actData.maxStreak, actData.totalActiveDays);
  renderMasteryBar(data);
  renderTopArtists(data.topArtists);
  renderTopSongs(data.topSongs);
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
    el.innerHTML = `<img src="${user.avatar_url}?t=${Date.now()}" alt="avatar">`;
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

// ── Activity heatmap (LeetCode style) ────────────────────────────

const MONTH_FR = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Aoû','Sep','Oct','Nov','Déc'];

// Format a Date as YYYY-MM-DD in LOCAL time (avoids the UTC shift that
// toISOString() introduces, which would misplace "today" in the grid).
function localKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function heatLevel(count) {
  if (count === 0) return 0;
  if (count <= 2)  return 1;
  if (count <= 5)  return 2;
  return 3;
}

function renderActivity(activity, streak, maxStreak = 0, totalActiveDays = 0) {
  const map = {};
  for (const r of activity) map[r.date] = r.count;

  // Build a 53-week grid aligned so today is in the rightmost week.
  // Week starts on Monday (French standard).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = localKey(today);
  const dayOfWeek = (today.getDay() + 6) % 7; // Mon=0 … Sun=6

  // Start from the Monday of the week that is 52 weeks ago
  const start = new Date(today);
  start.setDate(today.getDate() - dayOfWeek - 52 * 7);

  // Build week columns
  const weeks = [];
  const monthLabels = []; // { weekIdx, label }
  let d = new Date(start);
  let prevMonth = -1;

  for (let w = 0; w < 53; w++) {
    const week = [];
    for (let day = 0; day < 7; day++) {
      const key = localKey(d);
      const isFuture = d > today;
      const count = isFuture ? -1 : (map[key] || 0);
      const m = d.getMonth();
      // Emit a month label when the month changes and it's the start of a column
      if (day === 0 && m !== prevMonth) {
        monthLabels.push({ weekIdx: w, label: MONTH_FR[m] });
        prevMonth = m;
      }
      const title = isFuture ? '' : `${key} — ${count} session${count !== 1 ? 's' : ''}`;
      week.push({ count, title, isToday: key === todayKey });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }

  // Build month label row (CSS grid positioned by week index)
  const monthRow = monthLabels.map(({ weekIdx, label }) =>
    `<span class="hm-month" style="grid-column:${weekIdx + 1}">${label}</span>`
  ).join('');

  // Build day-of-week labels
  const dayLabels = ['L','M','M','J','V','S','D'].map((l, i) =>
    `<span class="hm-day-lbl${i % 2 === 0 ? '' : ' hm-day-lbl-hidden'}">${l}</span>`
  ).join('');

  // Build all cells as a flat CSS grid (7 rows, 53 columns, column-major)
  const cells = weeks.flatMap((week, wi) =>
    week.map((cell, di) => {
      const lvl = cell.count < 0 ? 'future' : `l${heatLevel(cell.count)}`;
      const todayCls = cell.isToday ? ' hm-today' : '';
      return `<div class="hm-cell ${lvl}${todayCls}" title="${cell.title}"
                   style="grid-column:${wi + 1};grid-row:${di + 1}"></div>`;
    })
  ).join('');

  // Streak + stats line
  const streakEl = document.getElementById('profile-streak');
  streakEl.classList.remove('hidden');
  streakEl.textContent = streak > 0
    ? `🔥 ${streak} jour${streak > 1 ? 's' : ''} de suite`
    : 'Aucun streak actif';

  document.getElementById('profile-activity').innerHTML = `
    <div class="heatmap-stats">
      <span class="hm-stat"><strong>${totalActiveDays}</strong> jours actifs</span>
      <span class="hm-stat-sep">·</span>
      <span class="hm-stat">Meilleure série : <strong>${maxStreak}</strong> jour${maxStreak > 1 ? 's' : ''}</span>
    </div>
    <div class="heatmap-wrap">
      <div class="hm-month-row" style="grid-template-columns:repeat(53,1fr)">${monthRow}</div>
      <div class="hm-body">
        <div class="hm-day-labels">${dayLabels}</div>
        <div class="hm-grid">${cells}</div>
      </div>
    </div>
    <div class="hm-legend">
      <span class="hm-legend-label">Moins</span>
      <div class="hm-cell l0 hm-legend-cell"></div>
      <div class="hm-cell l1 hm-legend-cell"></div>
      <div class="hm-cell l2 hm-legend-cell"></div>
      <div class="hm-cell l3 hm-legend-cell"></div>
      <span class="hm-legend-label">Plus</span>
    </div>`;
}

// ── Mastery bar ───────────────────────────────────────────────────

function renderMasteryBar(data) {
  const total = Math.max(data.total_songs || data.played || 1, 1);
  const segments = [
    { key: 'maitrisee',     cls: 'maitrisee',     label: 'Apprises'      },
    { key: 'revision',      cls: 'revision',      label: 'À revoir'      },
    { key: 'prevue',        cls: 'prevue',        label: 'En cours'      },
    { key: 'non_maitrisee', cls: 'non_maitrisee', label: 'Non révisées'  },
  ];
  document.getElementById('profile-mastery-row').innerHTML = `
    <div class="mastery-bar">
      ${segments.map(s => {
        const pct = Math.round((data[s.key] || 0) / total * 100);
        return pct > 0 ? `<div class="mastery-bar-seg ${s.cls}" style="width:${pct}%"></div>` : '';
      }).join('')}
    </div>
    <div class="mastery-bar-labels">
      ${segments.map(s =>
        `<span class="mastery-tag ${s.cls}">${s.label} · ${data[s.key] || 0}</span>`
      ).join('')}
    </div>`;
}

// ── Top lists ─────────────────────────────────────────────────────

function renderTopArtists(artists) {
  const el = document.getElementById('profile-top-artists');
  if (!artists?.length) { el.innerHTML = `<p class="profile-empty">Aucune session enregistrée</p>`; return; }
  const max = artists[0].plays;
  el.innerHTML = artists.map((a, i) => `
    <div class="top-row">
      <span class="top-rank">${i + 1}</span>
      <div class="top-bar-wrap">
        <div class="top-bar-label">${esc(a.artist)}</div>
        <div class="top-bar-track"><div class="top-bar-fill" style="width:${Math.round(a.plays/max*100)}%"></div></div>
      </div>
      <span class="top-count">${a.plays}</span>
    </div>`).join('');
}

function renderTopSongs(songs) {
  const el = document.getElementById('profile-top-songs');
  if (!songs?.length) { el.innerHTML = `<p class="profile-empty">Aucune session enregistrée</p>`; return; }
  const max = songs[0].plays;
  el.innerHTML = songs.map((s, i) => `
    <div class="top-row">
      <span class="top-rank">${i + 1}</span>
      <div class="top-bar-wrap">
        <div class="top-bar-label">${esc(s.title)} <span class="top-artist">${esc(s.artist)}</span></div>
        <div class="top-bar-track"><div class="top-bar-fill" style="width:${Math.round(s.plays/max*100)}%"></div></div>
      </div>
      <span class="top-count">${s.plays}</span>
    </div>`).join('');
}
