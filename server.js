require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set — create a .env file. See .env.example.');
  process.exit(1);
}

const app = express();
const PORT = 3000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'src/data/songs.db');
let db;

try {
  db = new Database(DB_PATH, { readonly: false });
  console.log('Connected to songs.db');
} catch (e) {
  console.error('Cannot open songs.db at', DB_PATH);
  process.exit(1);
}

const VALID_MASTERY = ['prevue', 'revision', 'maitrisee'];

// Add karaoke_url to songs table if it doesn't exist yet
try { db.exec(`ALTER TABLE songs ADD COLUMN karaoke_url TEXT`); } catch(_) {}
try { db.exec(`ALTER TABLE songs ADD COLUMN chosen_count INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE songs ADD COLUMN not_chosen_count INTEGER DEFAULT 0`); } catch(_) {}

// Profile fields
try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch(_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch(_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    song_id   TEXT,
    played_at TEXT NOT NULL DEFAULT (date('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id INTEGER NOT NULL,
    song_id     TEXT NOT NULL,
    added_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY(song_id) REFERENCES songs(id)
  );
`);

const AVATARS_DIR = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// Migrate progress table to support multiple users (one-time, idempotent).
// Existing single-user rows become user_id = 1.
const _progressCols = db.prepare(`PRAGMA table_info(progress)`).all().map(c => c.name);
if (!_progressCols.includes('user_id')) {
  if (_progressCols.length === 0) {
    // Fresh install — create the multi-user table directly
    db.exec(`
      CREATE TABLE progress (
        user_id         INTEGER NOT NULL DEFAULT 1,
        song_id         TEXT    NOT NULL,
        attempts        INTEGER DEFAULT 0,
        best_score      INTEGER DEFAULT 0,
        last_score      INTEGER DEFAULT 0,
        last_played     TEXT,
        timestamps_json TEXT,
        mastery         TEXT    DEFAULT 'non_maitrisee',
        in_playlist     INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, song_id),
        FOREIGN KEY(song_id) REFERENCES songs(id)
      );
    `);
  } else {
    // Existing DB — rename old table, create new one, migrate rows
    db.exec(`
      BEGIN;
      ALTER TABLE progress RENAME TO _progress_v1;
      CREATE TABLE progress (
        user_id         INTEGER NOT NULL DEFAULT 1,
        song_id         TEXT    NOT NULL,
        attempts        INTEGER DEFAULT 0,
        best_score      INTEGER DEFAULT 0,
        last_score      INTEGER DEFAULT 0,
        last_played     TEXT,
        timestamps_json TEXT,
        mastery         TEXT    DEFAULT 'non_maitrisee',
        in_playlist     INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, song_id),
        FOREIGN KEY(song_id) REFERENCES songs(id)
      );
      INSERT INTO progress
        SELECT 1, song_id,
          COALESCE(attempts,0), COALESCE(best_score,0), COALESCE(last_score,0),
          last_played, timestamps_json,
          COALESCE(mastery,'non_maitrisee'), COALESCE(in_playlist,0)
        FROM _progress_v1;
      DROP TABLE _progress_v1;
      COMMIT;
    `);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now'))
  );
`);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 10,                   // max 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});

app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'strict',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  next();
}

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  // Generate a CSRF token on first load (handles sessions created before this feature was added).
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ id: req.session.userId, username: req.session.username, csrfToken: req.session.csrfToken });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Champs requis' });
  if (username.trim().length > 64 || password.length > 128) {
    return res.status(400).json({ error: "Nom d'utilisateur ou mot de passe trop long" });
  }
  if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim())) {
    return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
  }
  const hash = await bcrypt.hash(password, 10);
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO users (username, password_hash) VALUES (?,?)`
  ).run(username.trim(), hash);
  req.session.userId   = id;
  req.session.username = username.trim();
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ ok: true, user: { id, username: username.trim() }, csrfToken: req.session.csrfToken });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });
  // Reject absurdly long inputs before bcrypt touches them (event-loop DoS prevention).
  if (username.length > 64 || password.length > 128) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username.trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  req.session.userId    = user.id;
  req.session.username  = user.username;
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ ok: true, user: { id: user.id, username: user.username }, csrfToken: req.session.csrfToken });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// All routes below this line require a valid session and a valid CSRF token.
app.use('/api', requireAuth);
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Token CSRF invalide' });
    }
  }
  next();
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET all songs (list view)
// Accent-insensitive, case-insensitive key for alphabetical ordering, so
// "é" sorts between "e" and "f" instead of after "z" (SQLite's default
// orders by raw code point). NFD decomposition splits accented letters into
// base char + combining mark, which we then strip.
db.function('unaccent', { deterministic: true }, (s) =>
  s == null ? s : s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
);

const UA_ARTIST = 'unaccent(s.artist)';
const UA_TITLE  = 'unaccent(s.title)';
const DEFAULT_ORDER = `${UA_ARTIST}, ${UA_TITLE}`;

const SORT_MAP = {
  z_a:             `${UA_ARTIST} DESC, ${UA_TITLE} DESC`,
  word_count_asc:  `s.word_count ASC NULLS LAST, ${DEFAULT_ORDER}`,
  word_count_desc: `s.word_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  mc_count_desc:   `s.mc_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  fn_count_desc:   `s.fn_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  show_count_desc: `s.show_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  year_asc:        `s.year ASC NULLS LAST, ${DEFAULT_ORDER}`,
  mal_aimees:      `CASE WHEN s.chosen_count + s.not_chosen_count = 0 THEN NULL ELSE CAST(s.chosen_count AS REAL) / (s.chosen_count + s.not_chosen_count) END ASC NULLS LAST, ${DEFAULT_ORDER}`,
};

app.get('/api/songs', (req, res) => {
  const { search, artist, type, mastery, sort, playlist, limit = 50, offset = 0 } = req.query;
  const playlistId = playlist ? (parseInt(playlist) || null) : null;
  const uid = req.session.userId;

  let where = `1=1`;
  const params = [uid];

  if (search) {
    where += ` AND (s.title LIKE ? OR s.artist LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  if (artist) {
    where += ` AND s.artist = ?`;
    params.push(artist);
  }
  if (type === 'mc') {
    where += ` AND s.mc_count > 0`;
  } else if (type === 'fn') {
    where += ` AND s.fn_count > 0`;
  } else if (type === 'none') {
    where += ` AND (s.mc_count = 0 OR s.mc_count IS NULL) AND (s.fn_count = 0 OR s.fn_count IS NULL)`;
  }
  if (mastery === 'non_maitrisee') {
    where += ` AND (p.mastery = 'non_maitrisee' OR p.mastery IS NULL)`;
  } else if (mastery) {
    where += ` AND p.mastery = ?`;
    params.push(mastery);
  }
  if (playlistId) {
    where += ` AND s.id IN (SELECT song_id FROM playlist_songs WHERE playlist_id = ?)`;
    params.push(playlistId);
  }

  const orderBy = SORT_MAP[sort] || 's.artist, s.title';
  const inSelectedExpr = playlistId
    ? `(SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ${playlistId} AND song_id = s.id) as in_selected_playlist`
    : `0 as in_selected_playlist`;

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM songs s LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ? WHERE ${where}`
  ).get(...params).c;

  const songs = db.prepare(`
    SELECT s.id, s.title, s.artist, s.year, s.youtube_url, s.word_count, s.show_count,
           s.mc_count, s.fn_count, s.chosen_count, s.not_chosen_count,
           p.attempts, p.best_score, p.last_score, p.last_played,
           p.mastery,
           COALESCE(p.in_playlist, 0) as in_playlist,
           ${inSelectedExpr}
    FROM songs s
    LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ?
    WHERE ${where}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  res.json({ songs, total });
});

// GET home data (stats + recents + playlist)
app.get('/api/home', (req, res) => {
  const uid = req.session.userId;

  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN p.mastery = 'maitrisee'     THEN 1 END) as mastered,
      COUNT(CASE WHEN p.mastery = 'revision'      THEN 1 END) as in_revision,
      COUNT(CASE WHEN p.mastery = 'prevue'        THEN 1 END) as prevue,
      COUNT(CASE WHEN p.in_playlist = 1           THEN 1 END) as in_playlist,
      MAX(p.best_score) as best_score,
      COUNT(CASE WHEN p.attempts > 0              THEN 1 END) as played
    FROM progress p WHERE p.user_id = ?
  `).get(uid) || {};

  const recents = db.prepare(`
    SELECT s.id, s.title, s.artist, p.last_played, p.best_score, p.last_score
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.last_played IS NOT NULL
    ORDER BY p.last_played DESC LIMIT 5
  `).all(uid);

  const playlist = db.prepare(`
    SELECT s.id, s.title, s.artist
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.in_playlist = 1
    ORDER BY s.artist, s.title LIMIT 8
  `).all(uid);

  const totalPlaylist = db.prepare(
    `SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND in_playlist = 1`
  ).get(uid).c;

  res.json({ stats, recents, playlist, totalPlaylist });
});

// GET distinct artists
app.get('/api/artists', (req, res) => {
  const artists = db.prepare(
    `SELECT DISTINCT artist FROM songs WHERE youtube_url IS NOT NULL AND youtube_url != '' ORDER BY artist`
  ).all();
  res.json(artists.map(a => a.artist));
});

// GET single song with full data
app.get('/api/songs/:id', (req, res) => {
  const song = db.prepare(`SELECT * FROM songs WHERE id = ?`).get(req.params.id);
  if (!song) return res.status(404).json({ error: 'Not found' });
  const prog = db.prepare(`SELECT * FROM progress WHERE song_id = ? AND user_id = ?`).get(req.params.id, req.session.userId);
  res.json({ ...song, progress: prog || null, mastery: prog?.mastery || null, timestamps_json: prog?.timestamps_json || null });
});

// POST save attempt after a game session
app.post('/api/songs/:id/attempt', (req, res) => {
  const { score } = req.body;
  const songId = req.params.id;
  const uid    = req.session.userId;
  const existing = db.prepare(`SELECT song_id FROM progress WHERE song_id = ? AND user_id = ?`).get(songId, uid);
  if (existing) {
    db.prepare(`
      UPDATE progress SET
        attempts = attempts + 1,
        best_score = MAX(best_score, ?),
        last_score = ?,
        last_played = datetime('now')
      WHERE song_id = ? AND user_id = ?
    `).run(score, score, songId, uid);
  } else {
    db.prepare(`
      INSERT INTO progress (user_id, song_id, attempts, best_score, last_score, last_played)
      VALUES (?, ?, 1, ?, ?, datetime('now'))
    `).run(uid, songId, score, score);
  }
  db.prepare(`INSERT INTO sessions (user_id, song_id, played_at) VALUES (?, ?, date('now','localtime'))`).run(uid, songId);
  res.json({ ok: true });
});

// PUT save timestamps (calibration)
app.put('/api/songs/:id/timestamps', (req, res) => {
  const { timestamps } = req.body;
  const songId = req.params.id;
  const uid    = req.session.userId;
  const existing = db.prepare(`SELECT song_id FROM progress WHERE song_id = ? AND user_id = ?`).get(songId, uid);
  if (existing) {
    db.prepare(`UPDATE progress SET timestamps_json = ? WHERE song_id = ? AND user_id = ?`)
      .run(JSON.stringify(timestamps), songId, uid);
  } else {
    db.prepare(`INSERT INTO progress (user_id, song_id, timestamps_json) VALUES (?, ?, ?)`)
      .run(uid, songId, JSON.stringify(timestamps));
  }
  res.json({ ok: true });
});

// GET playlists containing a specific song
app.get('/api/songs/:id/playlists', (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Non connecté' });
  const rows = db.prepare(`
    SELECT ps.playlist_id FROM playlist_songs ps
    JOIN playlists pl ON pl.id = ps.playlist_id
    WHERE ps.song_id = ? AND pl.user_id = ?`).all(req.params.id, uid);
  res.json(rows);
});

// PUT set mastery manually
app.put('/api/songs/:id/mastery', (req, res) => {
  const { mastery } = req.body;
  const songId = req.params.id;
  const uid    = req.session.userId;
  if (!VALID_MASTERY.includes(mastery)) return res.status(400).json({ error: 'Invalid mastery value' });
  const existing = db.prepare(`SELECT song_id FROM progress WHERE song_id = ? AND user_id = ?`).get(songId, uid);
  if (existing) {
    db.prepare(`UPDATE progress SET mastery = ? WHERE song_id = ? AND user_id = ?`).run(mastery, songId, uid);
  } else {
    db.prepare(`INSERT INTO progress (user_id, song_id, mastery) VALUES (?, ?, ?)`).run(uid, songId, mastery);
  }
  res.json({ ok: true });
});

// PUT toggle playlist
app.put('/api/songs/:id/playlist', (req, res) => {
  const { in_playlist } = req.body;
  const songId = req.params.id;
  const uid    = req.session.userId;
  const val    = in_playlist ? 1 : 0;
  const existing = db.prepare(`SELECT song_id FROM progress WHERE song_id = ? AND user_id = ?`).get(songId, uid);
  if (existing) {
    db.prepare(`UPDATE progress SET in_playlist = ? WHERE song_id = ? AND user_id = ?`).run(val, songId, uid);
  } else {
    db.prepare(`INSERT INTO progress (user_id, song_id, in_playlist) VALUES (?, ?, ?)`).run(uid, songId, val);
  }
  res.json({ ok: true });
});

// GET dashboard stats (scoped to the logged-in user)
app.get('/api/stats', (req, res) => {
  const uid = req.session.userId;

  const total    = db.prepare(`SELECT COUNT(*) as c FROM songs`).get().c;
  const played   = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND attempts > 0`).get(uid).c;
  const attempts = db.prepare(`SELECT SUM(attempts) as c FROM progress WHERE user_id = ?`).get(uid).c || 0;
  const avgScore = db.prepare(`SELECT AVG(best_score) as v FROM progress WHERE user_id = ? AND attempts > 0`).get(uid).v;

  // Count each named mastery status directly; everything else is implicitly non-mastered
  const maitrisee     = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'maitrisee'`).get(uid).c;
  const revision      = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'revision'`).get(uid).c;
  const prevue        = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'prevue'`).get(uid).c;
  const non_maitrisee = total - maitrisee - revision - prevue;
  const masteryCounts = { maitrisee, revision, prevue, non_maitrisee };

  const songs = db.prepare(`
    SELECT s.id, s.title, s.artist, s.year, s.mc_count, s.fn_count,
           p.attempts, p.best_score,
           p.mastery,
           COALESCE(p.in_playlist, 0) as in_playlist
    FROM songs s
    LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ?
    ORDER BY s.artist, s.title
  `).all(uid);

  const playlist = songs.filter(s => s.in_playlist);

  const top = db.prepare(`
    SELECT s.title, s.artist, p.best_score, p.attempts
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.attempts > 0
    ORDER BY p.best_score DESC LIMIT 20
  `).all(uid);

  const by_artist = db.prepare(`
    SELECT s.artist, COUNT(*) as total,
           SUM(CASE WHEN p.attempts > 0 THEN 1 ELSE 0 END) as played,
           AVG(CASE WHEN p.attempts > 0 THEN p.best_score END) as avg_score
    FROM songs s LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ?
    GROUP BY s.artist ORDER BY total DESC LIMIT 30
  `).all(uid);

  res.json({ total, played, attempts, avg_score: avgScore, ...masteryCounts, songs, playlist, top, by_artist });
});

// ─── PROFILE ──────────────────────────────────────────────────────────────────

app.get('/api/profile', (req, res) => {
  const uid = req.session.userId;
  const user = db.prepare(`SELECT id, username, bio, avatar_url FROM users WHERE id = ?`).get(uid);
  const played     = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND attempts > 0`).get(uid).c;
  const maitrisee  = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'maitrisee'`).get(uid).c;
  const revision   = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'revision'`).get(uid).c;
  const prevue     = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'prevue'`).get(uid).c;
  // Distinct days with a session → rough emission count (2 per day on average)
  const emissionsRow = db.prepare(`SELECT COUNT(DISTINCT played_at) as c FROM sessions WHERE user_id = ?`).get(uid);
  const emissions  = emissionsRow.c;
  // Average best_score across all played songs (as % success rate)
  const avgRow = db.prepare(`SELECT ROUND(AVG(best_score)) as avg FROM progress WHERE user_id = ? AND attempts > 0`).get(uid);
  const successRate = avgRow.avg ?? 0;
  const total_songs = db.prepare(`SELECT COUNT(*) as c FROM songs`).get().c;
  const non_maitrisee = Math.max(0, total_songs - maitrisee - revision - prevue);
  const topArtists = db.prepare(`
    SELECT s.artist, COUNT(*) as plays
    FROM sessions se JOIN songs s ON s.id = se.song_id
    WHERE se.user_id = ?
    GROUP BY s.artist ORDER BY plays DESC LIMIT 5
  `).all(uid);
  const topSongs = db.prepare(`
    SELECT s.title, s.artist, COUNT(*) as plays
    FROM sessions se JOIN songs s ON s.id = se.song_id
    WHERE se.user_id = ?
    GROUP BY se.song_id ORDER BY plays DESC LIMIT 5
  `).all(uid);
  res.json({ user, played, total_songs, maitrisee, revision, prevue, non_maitrisee, emissions, successRate, topArtists, topSongs });
});

app.get('/api/revision-queue', (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Non connecté' });
  const { mastery, count = 5, mc } = req.query;
  const n = Math.min(Math.max(1, parseInt(count) || 5), 50);
  let songs;
  if (mc === '1') {
    songs = db.prepare(`
      SELECT s.id, s.title, s.artist, s.year
      FROM songs s WHERE s.mc_count > 0
      ORDER BY RANDOM() LIMIT ?`).all(n);
  } else if (mastery) {
    songs = db.prepare(`
      SELECT s.id, s.title, s.artist, s.year
      FROM songs s JOIN progress p ON p.song_id = s.id AND p.user_id = ?
      WHERE p.mastery = ?
      ORDER BY RANDOM() LIMIT ?`).all(uid, mastery, n);
  } else {
    songs = db.prepare(`SELECT id, title, artist, year FROM songs ORDER BY RANDOM() LIMIT ?`).all(n);
  }
  res.json(songs);
});

app.put('/api/profile', (req, res) => {
  const uid = req.session.userId;
  const { username, bio } = req.body || {};
  if (username !== undefined) {
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 64)
      return res.status(400).json({ error: 'Nom invalide' });
    try {
      db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(username.trim(), uid);
    } catch (_) {
      return res.status(409).json({ error: 'Ce nom est déjà pris' });
    }
    req.session.username = username.trim();
  }
  if (bio !== undefined) {
    db.prepare(`UPDATE users SET bio = ? WHERE id = ?`).run((bio || '').slice(0, 200), uid);
  }
  const user = db.prepare(`SELECT id, username, bio, avatar_url FROM users WHERE id = ?`).get(uid);
  res.json({ ok: true, user });
});

app.post('/api/profile/avatar', (req, res) => {
  const uid = req.session.userId;
  const { data, type } = req.body || {};
  if (!data || !type) return res.status(400).json({ error: 'Données manquantes' });
  const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const ext = ALLOWED[type];
  if (!ext) return res.status(400).json({ error: 'Format non supporté' });
  for (const f of fs.readdirSync(AVATARS_DIR)) {
    if (f.startsWith(`${uid}.`)) fs.unlinkSync(path.join(AVATARS_DIR, f));
  }
  const filename = `${uid}.${ext}`;
  fs.writeFileSync(path.join(AVATARS_DIR, filename), Buffer.from(data, 'base64'));
  const avatar_url = `/avatars/${filename}`;
  db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(avatar_url, uid);
  res.json({ ok: true, avatar_url });
});

app.get('/api/profile/activity', (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Non connecté' });

  const activity = db.prepare(`
    SELECT played_at as date, COUNT(*) as count
    FROM sessions WHERE user_id = ?
    AND played_at >= date('now', 'localtime', '-364 days')
    GROUP BY played_at ORDER BY played_at
  `).all(uid);

  const allDays = db.prepare(`
    SELECT DISTINCT played_at as date FROM sessions WHERE user_id = ? ORDER BY played_at DESC
  `).all(uid).map(r => r.date);

  const today = db.prepare(`SELECT date('now','localtime') as d`).get().d;
  let streak = 0, check = today;
  for (const day of allDays) {
    if (day === check) {
      streak++;
      const d = new Date(check); d.setDate(d.getDate() - 1);
      check = d.toISOString().slice(0, 10);
    } else break;
  }

  // Max streak over all-time activity
  const asc = [...allDays].reverse();
  let maxStreak = 0, cur = 0;
  for (let i = 0; i < asc.length; i++) {
    if (i === 0) { cur = 1; }
    else {
      const prev = new Date(asc[i - 1]); prev.setDate(prev.getDate() + 1);
      cur = prev.toISOString().slice(0, 10) === asc[i] ? cur + 1 : 1;
    }
    if (cur > maxStreak) maxStreak = cur;
  }

  res.json({ activity, streak, maxStreak, totalActiveDays: allDays.length });
});

app.get('/api/emission/episodes', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  try {
    const rows = db.prepare(`
      SELECT id, air_date, emission_no
      FROM real_episodes
      WHERE air_date IS NOT NULL
      ORDER BY air_date DESC, emission_no ASC
      LIMIT 600
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PLAYLISTS ────────────────────────────────────────────────────────────────

function ensureDefaultPlaylist(uid) {
  const existing = db.prepare(`SELECT id FROM playlists WHERE user_id = ? AND is_default = 1`).get(uid);
  if (existing) return existing.id;
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO playlists (user_id, name, is_default) VALUES (?, 'Révision', 1)`
  ).run(uid);
  const ins = db.prepare(`INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)`);
  for (const s of db.prepare(`SELECT song_id FROM progress WHERE user_id = ? AND in_playlist = 1`).all(uid)) {
    ins.run(id, s.song_id);
  }
  return id;
}

app.get('/api/playlists', (req, res) => {
  const uid = req.session.userId;
  ensureDefaultPlaylist(uid);
  const playlists = db.prepare(`
    SELECT p.id, p.name, p.is_default, COUNT(ps.song_id) as song_count
    FROM playlists p LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
    WHERE p.user_id = ? GROUP BY p.id ORDER BY p.is_default DESC, p.created_at
  `).all(uid);
  res.json(playlists);
});

app.post('/api/playlists', (req, res) => {
  const uid = req.session.userId;
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO playlists (user_id, name) VALUES (?, ?)`
  ).run(uid, name.trim().slice(0, 64));
  res.json({ id, name: name.trim(), is_default: 0, song_count: 0 });
});

app.delete('/api/playlists/:id', (req, res) => {
  const uid = req.session.userId;
  const pl = db.prepare(`SELECT id, is_default FROM playlists WHERE id = ? AND user_id = ?`).get(req.params.id, uid);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  if (pl.is_default) return res.status(400).json({ error: 'La playlist par défaut ne peut pas être supprimée' });
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(pl.id);
  res.json({ ok: true });
});

app.post('/api/playlists/:id/songs/:songId', (req, res) => {
  const uid = req.session.userId;
  const pl = db.prepare(`SELECT id FROM playlists WHERE id = ? AND user_id = ?`).get(req.params.id, uid);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  db.prepare(`INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)`).run(pl.id, req.params.songId);
  res.json({ ok: true });
});

app.delete('/api/playlists/:id/songs/:songId', (req, res) => {
  const uid = req.session.userId;
  const pl = db.prepare(`SELECT id FROM playlists WHERE id = ? AND user_id = ?`).get(req.params.id, uid);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  db.prepare(`DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?`).run(pl.id, req.params.songId);
  res.json({ ok: true });
});

// ─── EMISSION ─────────────────────────────────────────────────────────────────

const EMISSION_LEVELS = [50, 40, 30, 20, 10];

// ── Anti-repetition memory ────────────────────────────────────────
// Remember what the last few emissions used so the next one feels fresh.
// Each entry: { themes:Set, labels:Set (antonyms+clever names), artists:Set }.
const RECENT_EMISSIONS = [];
const RECENT_KEEP = 3; // span over which a theme/name/artist won't recur

function recentAvoid(key) {
  const out = new Set();
  for (const e of RECENT_EMISSIONS) for (const v of e[key]) out.add(v);
  return out;
}
function rememberEmission(pairs) {
  const entry = { themes: new Set(), labels: new Set(), artists: new Set() };
  for (const p of pairs) {
    if (!p) continue;
    if (p.themeId) entry.themes.add(p.themeId);
    if (p.categoryName) entry.labels.add(norm(p.categoryName));
    if (p.tagType === 'artist' && p.songs?.[0]) entry.artists.add(norm(p.songs[0].artist));
  }
  RECENT_EMISSIONS.unshift(entry);
  while (RECENT_EMISSIONS.length > RECENT_KEEP) RECENT_EMISSIONS.pop();
}

// gemini-2.0-flash no longer has a free tier (quota limit 0); 2.5-flash does.
// We use ONLY gemini-2.5-flash for clever pairing: flash-lite is cheaper but
// forces weak, unrelated pairings. When flash's daily free quota is spent (429),
// callGemini returns null and we fall back to the clean deterministic engine
// (antonyms / themes) — genuine links beat a weaker model's forced ones.
const GEMINI_MODELS = ['gemini-2.5-flash'];

// POST a prompt to Gemini, trying each model until one answers (skips 429s).
// Returns the raw text, or null if every model is rate-limited / failed.
async function callGemini(prompt, apiKey) {
  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 1.0,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        }
      );
      if (response.status === 429) { continue; } // quota spent on this model — try next
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (err) {
      console.error(`Gemini (${model}) error:`, err.message);
    }
  }
  return null;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function norm(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ── Nationality lists (normalized artist names) ───────────────────
const BELGIANS = new Set([
  'axelle red','stromae','arno','adamo','salvatore adamo','maurane','lara fabian',
  'angele','blanche','loic nottet','alice on the roof','hooverphonic','vaya con dios',
  'milow','selah sue','plastic bertrand','dany brillant','annie cordy','lio',
  'marie-francoise','sttellla','frederic francois','william sheller','zap mama',
  'puggy','suarez','ozark henry','k\'s choice','sharko','girls in hawaii',
  'ben l\'oncle soul','kate ryan','babs',
]);
// Note: Dalida was born in Egypt, raised in France — not Belgian
const CANADIANS = new Set([
  'celine dion','cœur de pirate','coeur de pirate','roch voisine','diane dufresne',
  'isabelle boulay','lynda lemay','daniel belanger','marie-mai','garou','ginette reno',
  'jean leloup','kevin parent','zachary richard','natasha st-pier','felix leclerc',
  'gilles vigneault','claude leveillee','robert charlebois','beau dommage',
  'michel rivard','plume latraverse','paul anka','rene simard','mes aieux',
  'les cowboys fringants','les trois accords','jean-pierre ferland','harmonium',
]);
const SWISS = new Set([
  'bastian baker','dj bobo','stress','marco polo','sinplus','takasa',
  'anna aaron','jan bureau','seven','troubadour','gotthard',
]);

// ── Infinitive verb list ──────────────────────────────────────────
const INFINITIVES = new Set([
  'aimer','dire','tomber','chanter','marcher','parler','faire','jouer','ecrire',
  'prendre','laisser','danser','aller','entrer','voir','ecouter','siffler','vouloir',
  'savoir','partir','emmener','demander','courir','dormir','vivre','mourir','rester',
  'revenir','croire','attendre','comprendre','sentir','tenir','finir','rire','pleurer',
  'nager','voler','briller','grandir','mentir','oublier','aider','trouver','choisir',
  'esperer','penser','suivre','apprendre','garder','donner','toucher','regarder',
  'chercher','arriver','rentrer','sortir','monter','descendre','avancer','bouger',
  'commencer','raconter','expliquer','repondre','appeler','manger','boire','sourire',
  'crier','passer','changer','vieillir','souffrir','guerir','fuir','courir','plaire',
  'trahir','mentir','subir','unir','agir','reagir','saisir','detenir','obtenir',
  'retenir','appartenir','prevenir','intervenir','soutenir','maintenir','parvenir',
]);

// ── Theme catalogue ───────────────────────────────────────────────
// label = what's shown on the board (short, punchy, real NOPLP style)

const THEMES = [
  // ── Nationalities ─────────────────────────────────────────────
  { id: 'belges',    label: 'Les Belges',          hint: 'artistes belges', test: s => BELGIANS.has(norm(s.artist)) },
  { id: 'canadiens', label: 'Les Canadiens',        hint: 'artistes canadiens', test: s => CANADIANS.has(norm(s.artist)) },
  { id: 'suisses',   label: 'Les Suisses',          hint: 'artistes suisses', test: s => SWISS.has(norm(s.artist)) },

  // ── Couleurs ──────────────────────────────────────────────────
  { id: 'couleur',   label: 'Arc-en-ciel',          hint: 'couleur dans le titre',
    test: s => /\b(rouge|bleu|verte?|jaune|blanche?|noire?|rose|violet|orange|gris|dore|argente|beige|mauve|ecarlate|pourpre|cyan|indigo)\b/.test(norm(s.title)) },

  // ── Animaux ───────────────────────────────────────────────────
  { id: 'animal',    label: 'La ménagerie',         hint: 'animal dans le titre',
    test: s => /\b(chat|chien|oiseau|lion|aigle|tigre|renard|loup|hibou|canard|mouton|cheval|agneau|colombe|hirondelle|papillon|abeille|serpent|cochon|vache|ane|lapin|corbeau|cygne|dauphin|baleine|requin|cerf|biche|sanglier|ours|singe|elephant|girafe|zebre|rhinoceros|crocodile|tortue|grenouille|poisson|poulpe|crevette|homard|mouche|fourmi|cigale|rossignol|moineau|merle|pie|perroquet|ara|toucan)\b/.test(norm(s.title)) },

  // ── Prénoms ───────────────────────────────────────────────────
  { id: 'prenom_f',  label: 'Portraits de femmes',  hint: 'prénom féminin dans le titre',
    test: s => /\b(marie|helene|isabelle|claire|anne|sarah|julie|emma|sophie|alice|laura|nina|rosa|diane|celine|patricia|caroline|nathalie|juliette|madeleine|lola|eva|manon|lea|elisa|victoria|angela|nadine|sylvie|josiane|brigitte|francoise|josephine|margot|camille|adele|beatrice|amelie|valerie|veronique|dominique|christiane|monique|irene|yvette|simone|odette|jeanne|renee|suzanne|paulette|georgette|arlette|ginette|huguette|jacqueline|martine|michele|nicole|claudette|mireille|edith|barbara|dalida|lili|rosa|rita|anna|elena|angela|virginia|noelle|cecile|constance|delphine|elodie|faustine|gaelle|heloise|ingrid|jessica|karine|laetitia|lucie|mathilde|melanie|noemie|oceane|pauline|rachel|sabine|zoe|elsa|ines|luna|clara|leonie|victoire|rosalie|ophelie|perrine|solene|clemence|anais|maeva|naomi|coralie|fanny|laure|lilou|maelle|melissa|morgane|nadege|oriane|romane|sandrine|tatiana|agathe|bernadette|chantal|danielle|eliane|fabienne|ghislaine|hermine|marguerite|nadia|regine|therese|valentina|xenia|yolande)\b/.test(norm(s.title)) },

  { id: 'prenom_m',  label: 'Portraits d\'hommes',  hint: 'prénom masculin dans le titre',
    test: s => /\b(jean|pierre|paul|michel|david|marc|thomas|julien|vincent|charles|louis|victor|frederic|olivier|daniel|gabriel|raphael|alexandre|sebastien|antoine|nicolas|maxime|hugo|leo|felix|emile|theo|arthur|baptiste|valentin|eddy|johnny|serge|claude|guy|gilbert|gaston|armand|raymond|andre|roger|henri|marcel|georges|rene|lucien|fernand|albert|ernest|eugene|augustin|etienne|francois|xavier|benoit|christophe|jerome|laurent|mathieu|florian|alexis|quentin|robin|adrien|anthony|axel|benjamin|celestin|damien|edouard|fabien|gautier|hadrien|igor|kevin|lancelot|mael|noel|octave|pascal|romain|samuel|timothee|ulysse|valere|william|yann|zacharie|adam|boris|corentin|diego|eloi|fabrice|gregory|hector|ivan|jonathan|kylian|lionel|martin|nathan|oscar|philippe|renaud|simon|tristan|ugo|yvon)\b/.test(norm(s.title)) },

  // ── Géographie ────────────────────────────────────────────────
  { id: 'paris',     label: 'Sous le ciel de Paris', hint: 'Paris dans le titre',
    test: s => /\bparis\b/.test(norm(s.title)) },

  { id: 'pays',      label: 'Tour du monde',         hint: 'pays ou ville dans le titre',
    test: s => /\b(france|italia|italie|espagne|espana|america|amerique|mexique|cuba|afrique|bresil|japon|angleterre|portugal|russie|allemagne|grece|london|berlin|rome|lisbonne|amsterdam|madrid|venise|florence|barcelone|marseille|lyon|bordeaux|toulouse|lille|nice|bruxelles|montreal|quebec|alger|tunis|casablanca|dakar|abidjan|haiti|guadeloupe|martinique|reunion|tahiti|new york|chicago|los angeles|moscou|beijing|shanghai|tokyo|seoul|sydney|dublin|oslo|stockholm|geneve|zurich|vienne|prague|varsovie|budapest|copenhague|helsinki|athenes|istanbul|cairo|nairobi)\b/.test(norm(s.title)) },

  // ── Chiffres ──────────────────────────────────────────────────
  { id: 'chiffre',   label: 'Les chiffres',          hint: 'chiffre dans le titre',
    test: s => /\b(zero|un |une |deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille|million|milliard|\d+)\b/.test(norm(s.title)) },

  // ── Corps humain ──────────────────────────────────────────────
  { id: 'corps',     label: 'De la tête aux pieds',  hint: 'partie du corps dans le titre',
    test: s => /\b(yeux|main|mains|bras|jambe|jambes|pied|pieds|bouche|levre|levres|visage|dos|ventre|tete|cheveux|dent|dents|oeil|oreille|oreilles|nez|epaule|epaules|gorge|coude|genou|hanche|poitrine|sein|seins|sang|os|chair|peau|corps)\b/.test(norm(s.title)) },

  // ── Saisons ───────────────────────────────────────────────────
  { id: 'saison',    label: 'Au fil des saisons',    hint: 'saison dans le titre',
    test: s => /\b(printemps|ete|automne|hiver|summer|winter|spring|autumn)\b/.test(norm(s.title)) },

  // ── Mer ───────────────────────────────────────────────────────
  { id: 'mer',       label: 'En bord de mer',        hint: 'mer/ocean dans le titre',
    test: s => /\b(mer|ocean|vague|vagues|marin|marine|bateau|voile|plage|rivage|port|ile|cote|littoral|flots|maree|tempete|phare|cap|golfe|detroit|archipel|lagune|recif)\b/.test(norm(s.title)) },

  // ── Questions ─────────────────────────────────────────────────
  { id: 'question',  label: 'On se pose des questions', hint: 'titre en forme de question',
    test: s => s.title.includes('?') },

  // ── À l'infinitif ─────────────────────────────────────────────
  { id: 'infinitif', label: "À l'infinitif",         hint: 'titre commence par un infinitif',
    test: s => INFINITIVES.has(norm(s.title).split(/\s+/)[0]) },

  // ── Mots dans le titre — labels accessibles ──────────────────
  { id: 'nuit',      label: 'La nuit',            hint: 'nuit',     test: s => /\bnuit\b/.test(norm(s.title)) },
  { id: 'soleil',    label: 'Plein soleil',       hint: 'soleil',   test: s => /\bsoleil\b/.test(norm(s.title)) },
  { id: 'amour',     label: "Histoires d'amour",  hint: 'amour',    test: s => /\bamour\b/.test(norm(s.title)) },
  { id: 'vie',       label: "C'est la vie",       hint: 'vie',      test: s => /\bvie\b/.test(norm(s.title)) },
  { id: 'coeur',     label: 'Affaires de cœur',   hint: 'cœur',     test: s => /\bc(o|oe)ur\b/.test(norm(s.title)) },
  { id: 'monde',     label: 'Le monde entier',    hint: 'monde',    test: s => /\bmonde\b/.test(norm(s.title)) },
  { id: 'reve',      label: 'Comme dans un rêve', hint: 'rêve',     test: s => /\breve\b/.test(norm(s.title)) },
  { id: 'temps',     label: 'Le temps qui passe', hint: 'temps',    test: s => /\btemps\b/.test(norm(s.title)) },
  { id: 'chanson',   label: 'En chanson',         hint: 'chanson',  test: s => /\bchanson\b/.test(norm(s.title)) },
  { id: 'enfant',    label: 'Comme des enfants',  hint: 'enfant',   test: s => /\benfants?\b/.test(norm(s.title)) },
  { id: 'pluie',     label: 'Sous la pluie',      hint: 'pluie',    test: s => /\bpluie\b/.test(norm(s.title)) },
  { id: 'feu',       label: 'Tout feu tout flamme', hint: 'feu',    test: s => /\bfeu\b/.test(norm(s.title)) },
  { id: 'voyage',    label: 'Bon voyage',         hint: 'voyage',   test: s => /\bvoyage\b/.test(norm(s.title)) },
  { id: 'musique',   label: 'En musique',         hint: 'musique',  test: s => /\bmusique\b/.test(norm(s.title)) },
  { id: 'liberte',   label: 'En liberté',         hint: 'liberté',  test: s => /\b(liberte|freedom|libre)\b/.test(norm(s.title)) },
  { id: 'bonheur',   label: 'Tout le bonheur du monde', hint: 'bonheur', test: s => /\b(bonheur|heureux|heureuse|joie)\b/.test(norm(s.title)) },
  { id: 'ete',       label: "C'est l'été",        hint: 'été',      test: s => /\bete\b/.test(norm(s.title)) },
  { id: 'danse',     label: 'On danse',           hint: 'danse',    test: s => /\b(danse|danser|valse|tango|salsa|twist|samba|rumba|boogie|mambo|swing)\b/.test(norm(s.title)) },
  { id: 'noel',      label: 'En rouge et vert',  hint: 'Noël',     test: s => /\b(noel|christmas)\b/.test(norm(s.title)) },

  // ── Thèmes variés — style vraies catégories de l'émission ─────
  { id: 'famille',   label: 'Affaires de famille', hint: 'famille',
    test: s => /\b(maman|papa|mere|pere|frere|soeur|fils|famille|parents|mamie|papy|tonton|cousin|cousine)\b/.test(norm(s.title)) },
  { id: 'gourmand',  label: 'Gourmandises',       hint: 'nourriture',
    test: s => /\b(pain|vin|cafe|chocolat|sucre|miel|pomme|cerise|cerises|fraise|gateau|bonbon|fruit|biscuit|tarte|citron|banane|fromage|champagne|biere|gateaux)\b/.test(norm(s.title)) },
  { id: 'fleur',     label: 'Fleur bleue',        hint: 'fleur',
    test: s => /\b(fleur|fleurs|marguerite|violette|lilas|coquelicot|tulipe|petale|bouquet|jasmin|muguet|fleurit)\b/.test(norm(s.title)) },
  { id: 'route',     label: 'Sur la route',       hint: 'transport',
    test: s => /\b(route|voiture|train|avion|moto|auto|camion|velo|bus|metro|autoroute|bagnole|scooter|taxi|tram|chemin)\b/.test(norm(s.title)) },
  { id: 'ville',     label: 'Au coin de la rue',  hint: 'ville/rue',
    test: s => /\b(rue|ville|quartier|trottoir|boulevard|avenue|banlieue|faubourg|ruelle|cite)\b/.test(norm(s.title)) },
  { id: 'larme',     label: 'Cœurs brisés',       hint: 'chagrin',
    test: s => /\b(larme|larmes|chagrin|triste|tristesse|peine|pleurs|sanglot|melancolie|blessure)\b/.test(norm(s.title)) },
  { id: 'maison',    label: 'À la maison',        hint: 'maison',
    test: s => /\b(maison|maisons|chambre|fenetre|toit|escalier|cuisine|salon|cabane)\b/.test(norm(s.title)) },
  { id: 'etoile',    label: 'La tête dans les étoiles', hint: 'étoile/ciel',
    test: s => /\b(etoile|etoiles|cosmos|galaxie|planete|univers|astre|comete)\b/.test(norm(s.title)) },
  { id: 'argent',    label: "Question d'argent",  hint: 'argent',
    test: s => /\b(argent|million|millions|fortune|dollar|euro|franc|richesse|billet|or)\b/.test(norm(s.title)) },
  { id: 'telephone', label: 'Ne quittez pas',     hint: 'téléphone/lettre',
    test: s => /\b(telephone|telephoner|allo|lettre|lettres|message|numero)\b/.test(norm(s.title)) },
  { id: 'ange',      label: 'Au paradis',         hint: 'ange/ciel',
    test: s => /\b(ange|anges|paradis|ciel|nuage|nuages|aile|ailes)\b/.test(norm(s.title)) },
  { id: 'route_mot', label: 'Au bout du monde',   hint: 'loin/ailleurs',
    test: s => /\b(loin|ailleurs|horizon|frontiere|exil|errance)\b/.test(norm(s.title)) },
];

// ── Pair finders ──────────────────────────────────────────────────

// Theme/opposition pairs must feature TWO DIFFERENT artists — two Stromae
// songs in "Les Belges" is lazy. (The artist category is the only exception.)
function differentArtists(a, b) {
  const x = norm(a.artist), y = norm(b.artist);
  return x && y && x !== y;
}

function findArtistPair(available, avoidArtists = new Set()) {
  const byArtist = {};
  for (const s of shuffle(available)) {
    const key = norm(s.artist);
    if (!key || avoidArtists.has(key)) continue;   // skip recently-used artists
    if (!byArtist[key]) byArtist[key] = [];
    byArtist[key].push(s);
  }
  const valid = shuffle(Object.values(byArtist).filter(g => g.length >= 2));
  if (!valid.length) return null;
  const [a, b] = shuffle(valid[0]).slice(0, 2);
  return { songs: [a, b], tag: a.artist, tagType: 'artist', label: a.artist, hint: `artiste : ${a.artist}` };
}

function findDecadePair(available) {
  const byDecade = {};
  for (const s of shuffle(available)) {
    if (!s.year) continue;
    const decade = Math.floor(parseInt(s.year) / 10) * 10;
    if (isNaN(decade)) continue;
    if (!byDecade[decade]) byDecade[decade] = [];
    byDecade[decade].push(s);
  }
  const valid = shuffle(Object.entries(byDecade).filter(([, g]) => g.length >= 2));
  for (const [decade, group] of valid) {
    const pool = shuffle(group);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!differentArtists(pool[i], pool[j])) continue;
        // "1980" → "80", but keep full year for 2000+
        const shortDecade = decade >= 2000 ? String(decade) : String(decade).slice(-2);
        return { songs: [pool[i], pool[j]], tag: `années ${decade}`, tagType: 'decade',
                 label: `Les années ${shortDecade}`, hint: `chansons des années ${decade}` };
      }
    }
  }
  return null;
}

// themeOrder is pre-shuffled once per emission so every emission gets
// a completely different theme distribution — no theme is systematically preferred.
function findThemePair(available, usedThemeIds, themeOrder) {
  for (const theme of themeOrder) {
    if (usedThemeIds.has(theme.id)) continue;
    const matching = shuffle(available.filter(s => theme.test(s)));
    if (matching.length < 2) continue;
    for (let i = 0; i < matching.length; i++) {
      for (let j = i + 1; j < matching.length; j++) {
        if (!differentArtists(matching[i], matching[j])) continue;
        if (nameClashesWithTitle(theme.label, [matching[i], matching[j]])) continue;
        return { songs: [matching[i], matching[j]], tag: theme.id, tagType: 'theme',
                 themeId: theme.id, label: theme.label, hint: theme.hint };
      }
    }
  }
  return null;
}

// Words too common or too short to make an interesting category
const TITLE_STOPS = new Set([
  'les','des','une','que','qui','est','son','sur','par','tout','mais','comme',
  'plus','bien','alors','quand','aussi','sans','cette','tres','aux','mes','ses',
  'nos','mon','ton','lui','moi','toi','elle','eux','nous','vous','ils','elles',
  'ont','fait','sous','entre','avant','apres','vers','dont','meme','encore',
  'toujours','jamais','peut','veux','faut','suis','sont','sera','dire','voir',
  'venir','avoir','faire','etre','aller','pas','cet','ces','peu','ici','pour',
  'dans','avec','tout','the','and','for','not','but','you','all','can','her',
  'was','one','our','out','his','has','had','him','how','she','its','let','did',
  'get','that','this','with','from','they','will','when','what','have','been',
  'your','into','them','more','than','now','yes','got',
]);

function extractTitleWords(title) {
  return [...new Set(
    norm(title)
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !TITLE_STOPS.has(w))
  )];
}

// Find a pair of songs that share a meaningful word in their titles.
// usedWords prevents reusing the same connecting word in one emission.
function findTitleWordPair(available, usedWords) {
  const wordIndex = {};
  for (const song of available) {
    for (const w of extractTitleWords(song.title)) {
      if (!wordIndex[w]) wordIndex[w] = [];
      wordIndex[w].push(song);
    }
  }
  const candidates = shuffle(
    Object.entries(wordIndex)
      .filter(([word, songs]) => songs.length >= 2 && !usedWords.has(word))
      .map(([word, songs]) => ({ word, songs }))
  );
  for (const { word, songs } of candidates) {
    const label = word.charAt(0).toUpperCase() + word.slice(1);
    const pool = shuffle(songs);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!differentArtists(pool[i], pool[j])) continue;
        // Skip pairs where a song is titled exactly the connecting word.
        if (nameClashesWithTitle(label, [pool[i], pool[j]])) continue;
        return {
          songs: [pool[i], pool[j]],
          tag: word, tagType: 'title_word', titleWord: word,
          label,
          hint: `mot "${word}" présent dans les deux titres`,
        };
      }
    }
  }
  return null;
}

// ── Antonym / opposition pairs ────────────────────────────────────
// Two songs whose titles carry opposite words → a clever "X ou Y" category.
// [wordA regex, wordB regex, label]
const ANTONYM_PAIRS = [
  [/\boui\b/,                  /\bnon\b/,                    'Oui ou non'],
  [/\bami(e|es|s)?\b/,         /\bennemie?s?\b/,             'Amis-ennemis'],
  [/\bjour\b/,                 /\bnuit\b/,                   'Jour et nuit'],
  [/\bciel\b/,                 /\benfer\b/,                  'Ciel et enfer'],
  [/\bange\b/,                 /\b(demon|diable)\b/,         'Anges et démons'],
  [/\bhomme\b/,                /\bfemme\b/,                  'Hommes et femmes'],
  [/\b(jeune|jeunesse)\b/,     /\b(vieux|vieille|vieillir)\b/, 'Jeunes et vieux'],
  [/\briche\b/,                /\bpauvre\b/,                 'Riches et pauvres'],
  [/\bamour\b/,                /\b(haine|guerre)\b/,         'Amour et haine'],
  [/\bguerre\b/,               /\bpaix\b/,                   'Guerre et paix'],
  [/\b(noir|noire)\b/,         /\b(blanc|blanche)\b/,        'Noir et blanc'],
  [/\bsoleil\b/,               /\b(lune|pluie)\b/,           'Soleil et lune'],
  [/\b(rire|rit)\b/,           /\b(pleure|pleurer|larmes?)\b/, 'Rire et pleurer'],
  [/\b(partir|adieu|depart)\b/, /\b(revenir|retour|reste)\b/, 'Partir ou rester'],
  [/\b(debut|commence|commencer)\b/, /\b(fin|finir|termine)\b/, 'Du début à la fin'],
  [/\b(ete|soleil)\b/,         /\bhiver\b/,                  'Été comme hiver'],
  [/\bhaut\b/,                 /\bbas\b/,                    'De haut en bas'],
  [/\bgrand\b/,                /\bpetit\b/,                  'Grand et petit'],
  [/\bvie\b/,                  /\bmort\b/,                   'La vie, la mort'],
  [/\bvrai\b/,                 /\b(faux|mensonge|menteur)\b/, 'Le vrai du faux'],
  [/\broi\b/,                  /\breine\b/,                  'Le roi et la reine'],
];

// Find two songs whose titles sit on opposite sides of an antonym pair.
function findAntonymPair(available, usedLabels) {
  const order = shuffle([...ANTONYM_PAIRS.entries()]);
  for (const [, [reA, reB, label]] of order) {
    if (usedLabels.has(norm(label))) continue;  // recently/already used (normalized)
    const aSongs = shuffle(available.filter(s => reA.test(norm(s.title))));
    const bSongs = shuffle(available.filter(s => reB.test(norm(s.title))));
    for (const a of aSongs) {
      for (const b of bSongs) {
        if (b.id === a.id) continue;
        if (!differentArtists(a, b)) continue;
        // Skip combos where the label would reproduce a hidden title
        // (e.g. label "Oui ou non" with the song actually titled "Oui ou non").
        if (nameClashesWithTitle(label, [a, b])) continue;
        return {
          songs: [a, b],
          tag: label, tagType: 'antonym', antonymLabel: label,
          label, hint: `opposition entre les deux titres : ${label}`,
        };
      }
    }
  }
  return null;
}

// A category name must NEVER reproduce one of the two hidden song titles
// (that would spoil the answer). Returns true when the name clashes.
// Note: a short thematic word that naturally appears inside both titles
// (e.g. "Paris", "La nuit") is NOT a clash — that's a legit theme label.
function nameClashesWithTitle(name, songs) {
  const clean = str => norm(str).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const phrase = (hay, needle) => ` ${hay} `.includes(` ${needle} `);
  const n = clean(name);
  if (!n) return true;
  const nWords    = n.split(' ').filter(Boolean);
  const nContent  = nWords.filter(w => w.length > 2);
  for (const s of songs) {
    const t = clean(s.title);
    if (!t) continue;
    const tWords = t.split(' ').filter(Boolean);
    if (n === t) return true;                            // identical to a title
    if (phrase(n, t)) return true;                       // name contains a whole title
    // name is contained in a title AND covers nearly the whole title → it IS that title
    if (phrase(t, n) && nWords.length >= tWords.length - 1 && nWords.length >= 2) return true;
    // all of the name's content words belong to one title (reordered) → that title
    const setT = new Set(tWords);
    if (nContent.length >= 2 && nContent.every(w => setT.has(w))) return true;
  }
  return false;
}

// ── Gemini-driven CLEVER pairing ──────────────────────────────────
// Instead of pairing deterministically and only naming with the LLM,
// we hand Gemini the candidate pool for each open slot and let it FIND
// the cleverest two-song connection itself (a word from each title, an
// opposition, a hidden expression) — the kind of link a regex can't see.
// slots: [{ level, pool: [song…] }]  →  returns aligned [{ song0, song1, name } | null]
async function generateCleverPairs(slots, apiKey, avoidNames = new Set()) {
  if (!apiKey || !slots.length) return slots.map(() => null);

  // Build a numbered master list from the union of all pools (capped per slot).
  const master = [];
  const idToNum = new Map();
  const addSong = s => {
    if (idToNum.has(s.id)) return idToNum.get(s.id);
    const n = master.length;
    master.push(s);
    idToNum.set(s.id, n);
    return n;
  };
  const slotNums = slots.map(slot => {
    const sample = shuffle(slot.pool).slice(0, 28);
    return { level: slot.level, nums: sample.map(addSong) };
  });

  const catalogue = master
    .map((s, n) => `${n}. "${s.title}" — ${s.artist}${s.year ? ` (${s.year})` : ''}`)
    .join('\n');

  const slotLines = slotNums
    .map(s => `Catégorie ${s.level} pts → chansons éligibles : ${s.nums.join(', ')}`)
    .join('\n');

  const prompt = `Tu es l'auteur des catégories de "N'oubliez pas les paroles". Ton talent : repérer DEUX chansons reliées par un VRAI lien, et nommer ce lien par une expression française qui EXISTE DÉJÀ dans la langue (locution figée, proverbe, expression courante, titre célèbre).

DEUX RÈGLES ABSOLUES, non négociables :

RÈGLE 1 — Le nom doit être une expression LEXICALISÉE qui existe indépendamment des deux chansons. Test : est-ce que cette expression se trouverait dans un dictionnaire ou serait reconnue par tout francophone ? Si tu l'as fabriquée toi-même en recollant des mots, elle est INTERDITE.
- VALIDE : "Tour de magie" (expression réelle), "Reine de cœur" (carte à jouer), "Quartier de lune", "Oui ou non", "Amie-ennemie".
- INVALIDE : "Le temps de la nuit" (n'existe pas, mots recollés), "Liberté écris l'histoire" (deux titres recollés), "Bruxelles Stach Stach", "Africa Adieu".

RÈGLE 2 — Le nom ne doit JAMAIS être, contenir, ni reprendre l'un des deux titres cachés (ça donnerait la réponse).
- INVALIDE : chansons "Si j'étais un homme" + "Comme un homme" -> nom "Si j'étais un homme" (c'est un des titres). Ici le bon lien serait "Être un homme" si c'était une vraie expression, sinon NE RIEN proposer.

Le lien entre les deux chansons peut venir : d'un mot de chaque titre qui forme une expression réelle ; d'une opposition (oui/non, ami/ennemi) ; d'un thème commun fort ; d'un point commun entre les deux artistes. Mais le NOM final doit toujours respecter les Règles 1 et 2.

Si AUCUNE paire ne permet de respecter les deux règles pour une catégorie, alors NE propose RIEN (omets-la). Mieux vaut 2 catégories irréprochables que 5 catégories bancales.

Catalogue de chansons (numéro. "titre" — artiste) :
${catalogue}

Catégories à remplir (avec leurs chansons éligibles) :
${slotLines}

Contraintes :
- Une même chanson (numéro) ne peut servir que dans UNE seule catégorie.
- Choisis uniquement parmi les numéros éligibles listés pour chaque catégorie.
- Le nom : 1-4 mots, une expression qui existe vraiment, jamais "Le mot X", jamais un des titres cachés.
- Dans le doute sur l'existence réelle de l'expression : abstiens-toi, laisse la catégorie vide.${
  avoidNames.size ? `\n- Noms DÉJÀ utilisés récemment, à NE PAS réutiliser : ${[...avoidNames].join(', ')}.` : ''}

Réponds UNIQUEMENT par un tableau JSON, uniquement les catégories que tu remplis :
[{"level": 50, "a": 3, "b": 17, "name": "Tour de magie"}, …]`;

  try {
    const text = await callGemini(prompt, apiKey);
    if (!text) return slots.map(() => null); // all models rate-limited
    const clean = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('not an array');

    // Gemini may return several options per level — collect them all, then
    // pick the FIRST valid one per slot (eligible indices, no reuse, no clash).
    const byLevel = new Map();
    for (const o of parsed) {
      if (!byLevel.has(o.level)) byLevel.set(o.level, []);
      byLevel.get(o.level).push(o);
    }
    const takenIds = new Set();
    return slotNums.map(slot => {
      for (const o of byLevel.get(slot.level) || []) {
        const a = master[o.a], b = master[o.b];
        if (!a || !b || a.id === b.id) continue;
        if (!slot.nums.includes(o.a) || !slot.nums.includes(o.b)) continue;
        if (takenIds.has(a.id) || takenIds.has(b.id)) continue;
        const name = (typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : null;
        if (!name) continue;
        if (avoidNames.has(norm(name))) continue;         // used in a recent emission
        if (nameClashesWithTitle(name, [a, b])) continue; // never reproduce a hidden title
        takenIds.add(a.id); takenIds.add(b.id);
        return { song0: a, song1: b, name };
      }
      return null;
    });
  } catch (err) {
    console.error('Gemini clever-pair error:', err.message);
    return slots.map(() => null);
  }
}

// ── Real (scraped) category builders ──────────────────────────────
function songBlanksAt(blanks_json, level) {
  try {
    const b = JSON.parse(blanks_json || '{}');
    const a = b[level] ?? b[String(level)];
    return Array.isArray(a) && a.length > 0;
  } catch { return false; }
}

// For episode replay: find the closest available blank level for a song.
// Blanks are scraped for levels 10-50; episode categories can be 10-90.
const BLANK_LEVELS = [50, 40, 30, 20, 10];
function songBestLevel(blanks_json, preferredLevel) {
  try {
    const b = JSON.parse(blanks_json || '{}');
    // Try exact level first, then descend from 50
    const ordered = [preferredLevel, ...BLANK_LEVELS].filter((v, i, a) => a.indexOf(v) === i);
    for (const lvl of ordered) {
      const a = b[lvl] ?? b[String(lvl)];
      if (Array.isArray(a) && a.length > 0) return lvl;
    }
  } catch {}
  return null;
}

function realPairFromRow(c) {
  return {
    level: c.level, label: c.name, categoryName: c.name,
    tag: 'real', tagType: 'real', themeId: null, titleWord: null,
    songs: [
      { id: c.id1, title: c.t1, artist: c.a1, year: c.y1 },
      { id: c.id2, title: c.t2, artist: c.a2, year: c.y2 },
    ],
  };
}

// Variant used for episode replay: per-song fallback level stored so the
// game server can pick blanks at the right difficulty even when the category
// level exceeds what was scraped.
function realPairFromRowEpisode(c, lvl1, lvl2) {
  return {
    level: c.level, label: c.name, categoryName: c.name,
    tag: 'real', tagType: 'real', themeId: null, titleWord: null,
    songs: [
      { id: c.id1, title: c.t1, artist: c.a1, year: c.y1, blankLevel: lvl1 },
      { id: c.id2, title: c.t2, artist: c.a2, year: c.y2, blankLevel: lvl2 },
    ],
  };
}

const realCatByLevelStmt = db.prepare(`
  SELECT rc.level, rc.name,
         s1.id id1, s1.title t1, s1.artist a1, s1.year y1, s1.blanks_json b1,
         s2.id id2, s2.title t2, s2.artist a2, s2.year y2, s2.blanks_json b2
  FROM real_categories rc
  JOIN songs s1 ON s1.id = rc.song1_id
  JOIN songs s2 ON s2.id = rc.song2_id
  WHERE rc.level = ?
  ORDER BY RANDOM() LIMIT 600
`);

// Assemble 5 authentic, 100%-playable categories (one per level) from the pool.
function buildRealPairs() {
  const avoid     = recentAvoid('labels');
  const used      = new Set();   // song ids used this emission
  const usedNames = new Set();   // category names used this emission
  const out       = {};
  let decadeUsed  = false;       // at most one "Les années XX" per emission
  for (const level of EMISSION_LEVELS) {
    const cands = realCatByLevelStmt.all(level);
    const ok = (c, useAvoid) => {
      const nm = norm(c.name);
      if (c.id1 === c.id2 || used.has(c.id1) || used.has(c.id2)) return false;
      if (usedNames.has(nm)) return false;                       // no duplicate name on the board
      if (/^les annees\b/.test(nm) && decadeUsed) return false;  // cap decades at 1
      if (useAvoid && avoid.has(nm)) return false;               // avoid recent emissions
      return songBlanksAt(c.b1, level) && songBlanksAt(c.b2, level);
    };
    const c = cands.find(x => ok(x, true)) || cands.find(x => ok(x, false));
    if (!c) { out[level] = null; continue; }
    used.add(c.id1); used.add(c.id2);
    usedNames.add(norm(c.name));
    if (/^les annees\b/.test(norm(c.name))) decadeUsed = true;
    out[level] = realPairFromRow({ ...c, name: c.name, level });
  }
  return out;
}

const epCatsStmt = db.prepare(`
  SELECT rc.level, rc.name, rc.chosen,
         s1.id id1, s1.title t1, s1.artist a1, s1.year y1, s1.blanks_json b1,
         s2.id id2, s2.title t2, s2.artist a2, s2.year y2, s2.blanks_json b2
  FROM real_categories rc
  LEFT JOIN songs s1 ON s1.id = rc.song1_id
  LEFT JOIN songs s2 ON s2.id = rc.song2_id
  WHERE rc.episode_id = ? ORDER BY rc.level DESC
`);

function episodePlayablePairs(episodeId) {
  const out = {};
  for (const c of epCatsStmt.all(episodeId)) {
    if (out[c.level]) continue;
    const nonPrise = c.chosen === null;
    // Non-prise category: include for display (grayed out on board) but mark unplayable
    if (nonPrise) {
      out[c.level] = {
        level: c.level, label: c.name, categoryName: c.name,
        tag: 'real', tagType: 'real', themeId: null, titleWord: null,
        nonPrise: true,
        songs: [
          c.id1 ? { id: c.id1, title: c.t1, artist: c.a1, year: c.y1 } : null,
          c.id2 ? { id: c.id2, title: c.t2, artist: c.a2, year: c.y2 } : null,
        ].filter(Boolean),
      };
      continue;
    }
    // Playable category: find best available blank level for each song
    const lvl1 = songBestLevel(c.b1, c.level) ?? 30;
    const lvl2 = songBestLevel(c.b2, c.level) ?? 30;
    out[c.level] = realPairFromRowEpisode(c, lvl1, lvl2);
  }
  return out;
}

// Replay a real episode: its actually-played, fully-playable categories.
// Pass specificId to pin a chosen episode; omit for a random well-filled one.
function buildEpisodePairs(specificId = null) {
  if (specificId) {
    const pairs = episodePlayablePairs(specificId);
    return { pairsByLevel: pairs, episodeId: specificId };
  }
  const candidates = db.prepare('SELECT id FROM real_episodes ORDER BY RANDOM() LIMIT 60').all();
  let best = {}, bestN = 0, bestId = null;
  for (const e of candidates) {
    const p = episodePlayablePairs(e.id);
    const n = Object.keys(p).length;
    if (n > bestN) { best = p; bestN = n; bestId = e.id; if (n >= 4) break; }
  }
  return { pairsByLevel: best, episodeId: bestId };
}

function pickMcSong(episodeId) {
  if (episodeId) {
    const mc = db.prepare(`
      SELECT s.id, s.title, s.artist, s.year FROM real_episodes re
      JOIN songs s ON s.id = re.mc_song_id
      WHERE re.id = ? AND s.mc_count > 0 AND s.mc_json IS NOT NULL AND s.mc_json != ''`).get(episodeId);
    if (mc) return mc;
  }
  // A random authentic MC song (one that actually aired as a "Même chanson")
  return db.prepare(`
    SELECT s.id, s.title, s.artist, s.year FROM real_episodes re
    JOIN songs s ON s.id = re.mc_song_id
    WHERE s.mc_count > 0 AND s.mc_json IS NOT NULL AND s.mc_json != ''
    ORDER BY RANDOM() LIMIT 1`).get()
    || db.prepare(`
    SELECT id, title, artist, year FROM songs
    WHERE mc_count > 0 AND mc_json IS NOT NULL AND mc_json != ''
    ORDER BY RANDOM() LIMIT 1`).get();
}

// ── Generated category builder (fallback / "Catégories inventées" mode) ──
async function buildGeneratedPairs() {
  {
    const songs = db.prepare(`SELECT id, title, artist, year, blanks_json FROM songs`).all();

    const parsed = songs.map(s => {
      let blanksMap = {};
      try { blanksMap = JSON.parse(s.blanks_json || '{}'); } catch (_) {}
      return { ...s, blanksMap };
    });

    const usedIds = new Set();
    let artistPairUsed  = false;
    let decadePairUsed  = false;
    let antonymPairUsed = false;          // at most one "X et Y" opposition per emission

    // Seed the "already used" sets with the last few emissions so categories
    // don't recur from one emission to the next (anti-repetition memory).
    const avoidArtists  = recentAvoid('artists');
    const usedThemeIds  = recentAvoid('themes');   // recent themes are skipped
    const usedLabels    = recentAvoid('labels');   // recent antonym/clever names skipped
    const usedTitleWords = new Set();

    // Shuffle themes ONCE per emission — each emission gets a unique ordering
    // so no single theme is systematically favoured across emissions.
    const themeOrder = shuffle(THEMES);

    // Shuffle level processing order so special types land on random point values
    const levelOrder   = shuffle(EMISSION_LEVELS);
    const pairsByLevel = {};         // level -> assembled pair (categoryName may be null)

    const poolFor = level => parsed.filter(s => {
      if (usedIds.has(s.id)) return false;
      const arr = s.blanksMap[String(level)] || s.blanksMap[level];
      return Array.isArray(arr) && arr.length > 0;
    });

    const assign = (level, pair, categoryName) => {
      usedIds.add(pair.songs[0].id);
      usedIds.add(pair.songs[1].id);
      pairsByLevel[level] = {
        level,
        songs: pair.songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, year: s.year })),
        tag: pair.tag, tagType: pair.tagType,
        themeId: pair.themeId || null,
        titleWord: pair.titleWord || null,
        label: pair.label,
        categoryName: categoryName || null,
      };
    };

    // Levels with enough material to host a category
    const openLevels = [];
    for (const level of levelOrder) {
      if (poolFor(level).length < 2) pairsByLevel[level] = null;
      else openLevels.push(level);
    }

    // ── Reserve at most one ARTIST and one DECADE slot ────────────
    for (const level of openLevels) {
      if (artistPairUsed || pairsByLevel[level]) continue;
      const pair = findArtistPair(poolFor(level), avoidArtists);
      if (pair) { assign(level, pair, pair.label); artistPairUsed = true; }
    }
    for (const level of openLevels) {
      if (decadePairUsed || pairsByLevel[level]) continue;
      const pair = findDecadePair(poolFor(level));
      if (pair) { assign(level, pair, pair.label); decadePairUsed = true; }
    }
    // Reserve at most ONE opposition slot, so "X et Y" antonym categories
    // can't dominate the board — themes carry the rest of the variety.
    for (const level of openLevels) {
      if (antonymPairUsed || pairsByLevel[level]) continue;
      const pair = findAntonymPair(poolFor(level), usedLabels);
      if (pair) { assign(level, pair, pair.label); usedLabels.add(norm(pair.antonymLabel)); antonymPairUsed = true; }
    }

    // ── Remaining slots: let Gemini FIND the cleverest pairings ───
    const apiKey       = process.env.NOPLP_GEMINI || process.env.GEMINI_NOPLP;
    const cleverLevels = openLevels.filter(l => !pairsByLevel[l]);
    const slots        = cleverLevels.map(level => ({ level, pool: poolFor(level) }));
    const clever       = await generateCleverPairs(slots, apiKey, usedLabels);

    slots.forEach((slot, i) => {
      const c = clever[i];
      if (c && !usedIds.has(c.song0.id) && !usedIds.has(c.song1.id)) {
        assign(slot.level,
          { songs: [c.song0, c.song1], tag: 'clever', tagType: 'clever', label: c.name },
          c.name);
      }
    });

    // ── Deterministic fallback for any slot Gemini left empty ─────
    for (const level of cleverLevels) {
      if (pairsByLevel[level]) continue;
      const available = poolFor(level);
      if (available.length < 2) { pairsByLevel[level] = null; continue; }

      // Themes are the richest, most varied source of real-show-style names,
      // so they lead the fallback. Antonyms only if the single reserved slot
      // wasn't filled and nothing else worked.
      let pair = findThemePair(available, usedThemeIds, themeOrder);
      if (pair) usedThemeIds.add(pair.themeId);
      if (!pair) {
        pair = findTitleWordPair(available, usedTitleWords);
        if (pair) usedTitleWords.add(pair.titleWord);
      }
      if (!pair && !antonymPairUsed) {
        pair = findAntonymPair(available, usedLabels);
        if (pair) { usedLabels.add(norm(pair.antonymLabel)); antonymPairUsed = true; }
      }
      if (!pair) {
        const [a, b] = shuffle(available).slice(0, 2);
        pair = { songs: [a, b], tag: 'variété française', tagType: 'generic', label: 'Variété française' };
      }
      assign(level, pair, null); // named below
    }

    // Generated fallback pairs keep their own deterministic label.
    for (const lvl of EMISSION_LEVELS) {
      const p = pairsByLevel[lvl];
      if (p && !p.categoryName) p.categoryName = p.label;
    }
    return pairsByLevel;
  }
}

// ── Endpoint ──────────────────────────────────────────────────────
// source: 'real' (pool of authentic categories, default) | 'episode'
//         (replay a real episode) | 'generated' (invented categories)
app.post('/api/emission/generate', async (req, res) => {
  try {
    const source = (req.body && req.body.source) || 'real';

    let pairsByLevel, episodeId = null;
    if (source === 'generated') {
      pairsByLevel = await buildGeneratedPairs();
    } else if (source === 'episode') {
      const specificId = req.body.episodeId ? parseInt(req.body.episodeId) : null;
      ({ pairsByLevel, episodeId } = buildEpisodePairs(specificId));
    } else {
      pairsByLevel = buildRealPairs();
    }

    const pairs = EMISSION_LEVELS.map(l => pairsByLevel[l] ?? null);
    for (const p of pairs) if (p && !p.categoryName) p.categoryName = p.label;

    rememberEmission(pairs);

    res.json({
      source,
      pairs: pairs.map(p => p
        ? { ...p, categoryName: p.categoryName || `Catégorie ${p.level} pts` }
        : null),
      mcSong: pickMcSong(episodeId) || null,
    });
  } catch (err) {
    console.error('Emission generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nNOPLP Revision - http://localhost:${PORT}\n`);
});
