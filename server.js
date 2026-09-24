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

const VALID_MASTERY = ['prevue', 'revision', 'maitrisee', 'non_maitrisee'];

// Enforce REFERENCES clauses (off by default in SQLite) so user data can't
// point at missing rows and playlist deletion really cascades to its songs.
db.pragma('foreign_keys = ON');

// Created first: the ALTERs below and every other user table depend on it.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now'))
  );
`);

// Add karaoke_url to songs table if it doesn't exist yet
try { db.exec(`ALTER TABLE songs ADD COLUMN karaoke_url TEXT`); } catch(_) {}
try { db.exec(`ALTER TABLE songs ADD COLUMN chosen_count INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE songs ADD COLUMN not_chosen_count INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE songs ADD COLUMN aired_12m INTEGER DEFAULT 0`); } catch(_) {}

// Profile fields
try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch(_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch(_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN favorite_songs_json TEXT`); } catch(_) {}
// Public counters, kept on the user row so future leaderboards are one indexed query
try { db.exec(`ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN bells INTEGER NOT NULL DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN final_winnings INTEGER NOT NULL DEFAULT 0`); } catch(_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    song_id   TEXT,
    played_at TEXT NOT NULL DEFAULT (date('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, day, kind),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS daily_challenges (
    user_id   INTEGER NOT NULL,
    day       TEXT NOT NULL,
    song_id   TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS emissions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now')),
    source    TEXT,
    mode      TEXT,
    score     INTEGER,
    opp_score INTEGER,
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

try { db.exec(`ALTER TABLE emissions ADD COLUMN final_gain INTEGER`); } catch(_) {}
try { db.exec(`ALTER TABLE emissions ADD COLUMN xp INTEGER NOT NULL DEFAULT 0`); } catch(_) {}

db.exec(`
  -- XP ledger: every award is one row, users.xp is its running total
  CREATE TABLE IF NOT EXISTS xp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    amount     INTEGER NOT NULL,
    ref        TEXT,
    day        TEXT    NOT NULL DEFAULT (date('now','localtime')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_xp_events_user_day ON xp_events(user_id, kind, day);
  CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id, played_at);
  CREATE INDEX IF NOT EXISTS idx_emissions_user     ON emissions(user_id, played_at);
  CREATE INDEX IF NOT EXISTS idx_daily_song         ON daily_challenges(user_id, song_id);
  CREATE INDEX IF NOT EXISTS idx_users_xp           ON users(xp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_winnings     ON users(final_winnings DESC);
`);
// Rows left behind while foreign keys were not enforced
db.exec(`DELETE FROM playlist_songs WHERE playlist_id NOT IN (SELECT id FROM playlists)`);
// Usernames are unique regardless of case ("Bob" can't impersonate "bob").
// Skipped silently if an older database already holds such a pair.
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)`); } catch(_) {}

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

// ─── XP & LEVELS ──────────────────────────────────────────────────────────────
// XP is earned by actions and written to the xp_events ledger at the moment
// they happen; users.xp caches the total. Self-declared progress (marking a
// song "apprise") earns none, so XP can't be inflated with one click.
const XP = {
  song:         10,   // finished song, any score
  songGood:      5,   // bonus at 50 % or more
  songPerfect:   5,   // extra bonus at 100 %
  songDailyCap:  3,   // XP-earning plays per song per day (anti-farming)
  emission:     40,   // finished emission, win or lose
  emissionWin:  40,   // duel won
  emissionTie:  20,   // duel tied
  emissionDailyCap: 10,
  challenge:    50,   // daily challenge passed
  finalePerXp: 200,   // 1 XP per 200 € won in the final (20 000 € → 100 XP)
};
const FINAL_GAINS = [0, 1000, 2000, 5000, 10000, 20000];

const songXp = score => XP.song + (score >= 50 ? XP.songGood : 0) + (score >= 100 ? XP.songPerfect : 0);

// Solo has no opponent: the category points (max 150) add up to 30 XP instead
function emissionXp({ mode, score, oppScore }) {
  if (mode === 'duel') {
    return XP.emission + (score > oppScore ? XP.emissionWin : score === oppScore ? XP.emissionTie : 0);
  }
  return XP.emission + Math.min(30, Math.floor((score || 0) / 5));
}

// Level L starts at 50·L·(L−1) XP: 100, 300, 600, 1 000, 1 500… — each
// level takes 100 XP more than the previous one (≈ one more emission).
const xpForLevel = L => 50 * L * (L - 1);
const LEVEL_TITLES = [
  [75, 'Légende du plateau'], [50, 'Maître des paroles'], [40, 'Champion'], [30, 'Maestro'],
  [20, 'Virtuose'], [15, 'Expert'], [10, 'Confirmé'], [5, 'Novice'], [1, 'Débutant'],
];

function levelFromXp(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const [, title] = LEVEL_TITLES.find(([min]) => level >= min);
  const nextTier = [...LEVEL_TITLES].reverse().find(([min]) => min > level);
  return {
    level, xp, title,
    levelStart: xpForLevel(level),
    nextLevel: xpForLevel(level + 1),
    nextTitle: nextTier ? { level: nextTier[0], title: nextTier[1] } : null,
  };
}

const stmtXpEvent = db.prepare(`INSERT INTO xp_events (user_id, kind, amount, ref) VALUES (?, ?, ?, ?)`);
const stmtXpAdd   = db.prepare(`UPDATE users SET xp = xp + ? WHERE id = ?`);
const stmtXpGet   = db.prepare(`SELECT xp FROM users WHERE id = ?`);

// Awards XP atomically; returns what the client needs for a "+N XP" toast.
function awardXp(uid, kind, amount, ref = null) {
  const before = stmtXpGet.get(uid)?.xp ?? 0;
  if (amount > 0) {
    db.transaction(() => {
      stmtXpEvent.run(uid, kind, amount, ref);
      stmtXpAdd.run(amount, uid);
    })();
  }
  const after = levelFromXp(before + Math.max(0, amount));
  return { gained: Math.max(0, amount), level: after, leveledUp: after.level > levelFromXp(before).level };
}

// One-time: turn the history recorded before the ledger existed into XP
if (!db.prepare(`SELECT 1 FROM app_meta WHERE key = 'xp_backfill'`).get()) {
  db.transaction(() => {
    for (const { id } of db.prepare(`SELECT id FROM users`).all()) {
      const plays = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).get(id).n;
      const challenges = db.prepare(`SELECT COUNT(*) AS n FROM daily_challenges WHERE user_id = ? AND completed = 1`).get(id).n;
      const emissionTotal = db.prepare(`SELECT mode, score, opp_score AS oppScore FROM emissions WHERE user_id = ?`).all(id)
        .reduce((sum, e) => sum + emissionXp(e), 0);
      const parts = [['backfill_songs', plays * XP.song], ['backfill_challenges', challenges * XP.challenge],
                     ['backfill_emissions', emissionTotal]];
      for (const [kind, amount] of parts) if (amount > 0) stmtXpEvent.run(id, kind, amount, null);
      db.prepare(`UPDATE users SET xp = (SELECT COALESCE(SUM(amount), 0) FROM xp_events WHERE user_id = ?) WHERE id = ?`).run(id, id);
    }
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('xp_backfill', datetime('now'))`).run();
  })();
}

// ─── SESSION STORE ────────────────────────────────────────────────────────────
// Sessions live in SQLite instead of express-session's MemoryStore (which
// leaks and logs everyone out on restart). Only the session id is in the
// cookie; the row holds the user id and CSRF token.
class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    database.exec(`
      CREATE TABLE IF NOT EXISTS http_sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_sessions_expires ON http_sessions(expires);
    `);
    this.getStmt   = database.prepare(`SELECT sess FROM http_sessions WHERE sid = ? AND expires > ?`);
    this.setStmt   = database.prepare(`INSERT INTO http_sessions (sid, sess, expires) VALUES (?, ?, ?)
                                       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`);
    this.touchStmt = database.prepare(`UPDATE http_sessions SET expires = ? WHERE sid = ?`);
    this.delStmt   = database.prepare(`DELETE FROM http_sessions WHERE sid = ?`);
    this.purgeStmt = database.prepare(`DELETE FROM http_sessions WHERE expires <= ?`);
    this.purgeStmt.run(Date.now());
    setInterval(() => this.purgeStmt.run(Date.now()), 3600 * 1000).unref();
  }
  static expiry(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(exp) ? exp : Date.now() + 24 * 3600 * 1000;
  }
  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.setStmt.run(sid, JSON.stringify(sess), SqliteSessionStore.expiry(sess)); cb?.(null); }
    catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) {
    try { this.touchStmt.run(SqliteSessionStore.expiry(sess), sid); cb?.(null); }
    catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb?.(null); }
    catch (e) { cb?.(e); }
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 10,                   // max 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de créations de compte, réessayez plus tard' },
});

// Behind a TLS-terminating reverse proxy, set TRUST_PROXY=1 so secure cookies work
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(session({
  store: new SqliteSessionStore(db),
  secret: process.env.SESSION_SECRET,
  name: 'noplr.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'strict',
    secure: 'auto',                   // Secure flag whenever the request came over HTTPS
  },
}));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  next();
}

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  // Generate a CSRF token on first load (handles sessions created before this feature was added).
  const user = db.prepare(`SELECT id, username, avatar_url FROM users WHERE id = ?`).get(req.session.userId);
  if (!user) {
    req.session.destroy(() => res.status(401).json({ error: 'Non authentifié' }));
    return;
  }
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ ...user, csrfToken: req.session.csrfToken });
});

// Public-facing names (future leaderboards and profiles): 3–24 letters, digits,
// spaces and . _ - ' — no markup, no invisible characters.
const USERNAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]{1,22})[\p{L}\p{N}]$/u;
const usernameError = name =>
  typeof name !== 'string' || !USERNAME_RE.test(name)
    ? 'Pseudo : 3 à 24 caractères (lettres, chiffres, espace, . _ - \')'
    : null;
const stmtUsernameTaken = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?`);

// New session id on every login: a session id planted before login
// (session fixation) never becomes an authenticated one.
function startUserSession(req, res, user) {
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erreur de session' });
    req.session.userId    = user.id;
    req.session.username  = user.username;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({ ok: true, user: { id: user.id, username: user.username, avatar_url: user.avatar_url || null },
               csrfToken: req.session.csrfToken });
  });
}

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Champs requis' });
  }
  const name = username.trim().normalize('NFC');
  const nameErr = usernameError(name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  if (password.length < 8)   return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  if (password.length > 128) return res.status(400).json({ error: 'Mot de passe trop long' });
  if (stmtUsernameTaken.get(name, 0)) {
    return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
  }
  const hash = await bcrypt.hash(password, 12);
  let id;
  try {
    ({ lastInsertRowid: id } = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?,?)`).run(name, hash));
  } catch (_) {
    return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
  }
  startUserSession(req, res, { id, username: name });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Champs requis' });
  }
  // Reject absurdly long inputs before bcrypt touches them (event-loop DoS prevention).
  if (username.length > 64 || password.length > 128) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username.trim())
            || db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(username.trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  startUserSession(req, res, user);
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
  s == null ? s : s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`´]/g, "'").toLowerCase()
);
const unaccentJs = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`´]/g, "'").toLowerCase();

const UA_ARTIST = 'unaccent(s.artist)';
const UA_TITLE  = 'unaccent(s.title)';
const DEFAULT_ORDER = `${UA_ARTIST}, ${UA_TITLE}`;

function refreshAired12m() {
  const cutoff = db.prepare(`SELECT date('now','localtime','-365 days') AS d`).get().d;
  const rows = db.prepare(`SELECT id, show_dates_json FROM songs`).all();
  const upd  = db.prepare(`UPDATE songs SET aired_12m = ? WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      let n = 0;
      try { n = (JSON.parse(r.show_dates_json) || []).filter(d => d >= cutoff).length; } catch (_) {}
      upd.run(n, r.id);
    }
  })();
}
refreshAired12m();
setInterval(refreshAired12m, 12 * 3600 * 1000).unref();

const SORT_MAP = {
  aired_desc:      `s.aired_12m DESC, ${DEFAULT_ORDER}`,
  z_a:             `${UA_ARTIST} DESC, ${UA_TITLE} DESC`,
  word_count_asc:  `s.word_count ASC NULLS LAST, ${DEFAULT_ORDER}`,
  word_count_desc: `s.word_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  mc_count_desc:   `s.mc_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  fn_count_desc:   `s.fn_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  show_count_desc: `s.show_count DESC NULLS LAST, ${DEFAULT_ORDER}`,
  year_asc:        `s.year ASC NULLS LAST, ${DEFAULT_ORDER}`,
  mal_aimees:      `CASE WHEN s.chosen_count + s.not_chosen_count = 0 THEN NULL ELSE CAST(s.chosen_count AS REAL) / (s.chosen_count + s.not_chosen_count) END ASC NULLS LAST, (s.chosen_count + s.not_chosen_count) DESC, ${DEFAULT_ORDER}`,
};

app.get('/api/songs', (req, res) => {
  const { search, artist, type, mastery, sort, playlist, limit = 50, offset = 0 } = req.query;
  const playlistId = playlist ? (parseInt(playlist) || null) : null;
  const uid = req.session.userId;

  let where = `1=1`;
  const params = [uid];

  if (search) {
    // Case- and accent-insensitive: "a toi" finds "À toi"
    const term = `%${unaccentJs(search.trim())}%`;
    where += ` AND (${UA_TITLE} LIKE ? OR ${UA_ARTIST} LIKE ?)`;
    params.push(term, term);
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
  } else if (type === 'mal_aimees') {
    where += ` AND (s.chosen_count + s.not_chosen_count) > 0`;
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
  // "Mal aimées" ranks by pick rate unless another sort was chosen explicitly
  const sortBy  = sort || (type === 'mal_aimees' ? 'mal_aimees' : '');
  const orderBy = SORT_MAP[sortBy] || 's.artist, s.title';
  const inSelectedExpr = playlistId
    ? `(SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ${playlistId} AND song_id = s.id) as in_selected_playlist`
    : `0 as in_selected_playlist`;

  // Fetch all matching songs (no SQL LIMIT) so we can group duplicates
  // before paginating — SQLite is fast enough for ~3000 rows.
  const allSongs = db.prepare(`
    SELECT s.id, s.title, s.artist, s.year, s.youtube_url, s.word_count, s.show_count,
           s.mc_count, s.fn_count, s.chosen_count, s.not_chosen_count, s.aired_12m,
           s.lyrics,
           p.attempts, p.best_score, p.last_score, p.last_played,
           p.mastery,
           COALESCE(p.in_playlist, 0) as in_playlist,
           ${inSelectedExpr},
           EXISTS(SELECT 1 FROM playlist_songs ps JOIN playlists pl ON pl.id = ps.playlist_id
                  WHERE pl.user_id = ? AND pl.is_default = 1 AND ps.song_id = s.id) as in_default
    FROM songs s
    LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ?
    WHERE ${where}
    ORDER BY ${orderBy}
  `).all(uid, ...params);

  // Normalize lyrics to a fingerprint for grouping:
  // use the first 300 chars of normalized lyrics so minor typos between wiki
  // pages don't prevent grouping, while still distinguishing different songs.
  function lyricsKey(lyrics) {
    const norm = (lyrics || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '').slice(0, 300);
    if (!norm) return '__empty__';
    return crypto.createHash('md5').update(norm).digest('hex');
  }

  // Group by normalised title + lyrics fingerprint — keeps different songs with
  // the same title (e.g. "Les mots" by Keen'V vs Mylène Farmer) separate.
  const groups = new Map(); // key → [songs]
  for (const s of allSongs) {
    const key = s.title.toLowerCase().trim() + '||' + lyricsKey(s.lyrics);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const grouped = [];
  for (const versions of groups.values()) {
    versions.sort((a, b) => (b.show_count || 0) - (a.show_count || 0));
    const { lyrics: _l, ...primary } = versions[0];
    if (versions.length > 1) {
      primary.alt_versions = versions.slice(1).map(v => ({
        id: v.id, artist: v.artist, year: v.year, show_count: v.show_count,
      }));
    }
    grouped.push(primary);
  }

  // Re-sort grouped results (grouping disrupts order for multi-version songs)
  const sortKey = sortBy && SORT_MAP[sortBy];
  if (!sortKey || sortKey.startsWith('unaccent')) {
    const dir = sortBy === 'z_a' ? -1 : 1;
    grouped.sort((a, b) => dir * (
      (a.artist || '').localeCompare(b.artist || '', 'fr') || (a.title || '').localeCompare(b.title || '', 'fr')
    ));
  }

  const total = grouped.length;
  const lim   = parseInt(limit);
  const off   = parseInt(offset);
  const songs = grouped.slice(off, off + lim);

  res.json({ songs, total });
});

// GET home data (stats + recents + playlist)

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
const stmtSongPlaysToday = db.prepare(`
  SELECT COUNT(*) AS n FROM xp_events WHERE user_id = ? AND kind = 'song' AND ref = ? AND day = date('now','localtime')`);

app.post('/api/songs/:id/attempt', (req, res) => {
  const songId = req.params.id;
  const uid    = req.session.userId;
  const score  = Math.round(Number(req.body?.score));
  if (!Number.isFinite(score) || score < 0 || score > 100) return res.status(400).json({ error: 'Score invalide' });
  if (!stmtSongExists.get(songId)) return res.status(404).json({ error: 'Chanson introuvable' });

  const challengeDone = db.transaction(() => {
    db.prepare(`
      INSERT INTO progress (user_id, song_id, attempts, best_score, last_score, last_played)
      VALUES (?, ?, 1, ?, ?, datetime('now'))
      ON CONFLICT(user_id, song_id) DO UPDATE SET
        attempts    = attempts + 1,
        best_score  = MAX(COALESCE(best_score, 0), excluded.best_score),
        last_score  = excluded.last_score,
        last_played = excluded.last_played
    `).run(uid, songId, score, score);
    db.prepare(`INSERT INTO sessions (user_id, song_id, played_at) VALUES (?, ?, date('now','localtime'))`).run(uid, songId);
    if (score < CHALLENGE_PASS) return false;
    return db.prepare(`
      UPDATE daily_challenges SET completed = 1
      WHERE user_id = ? AND day = date('now','localtime') AND song_id = ? AND completed = 0
    `).run(uid, songId).changes > 0;
  })();

  const earnsXp = stmtSongPlaysToday.get(uid, songId).n < XP.songDailyCap;
  let xp = awardXp(uid, 'song', earnsXp ? songXp(score) : 0, songId);
  if (challengeDone) {
    const bonus = awardXp(uid, 'challenge', XP.challenge, songId);
    xp = { ...bonus, gained: xp.gained + bonus.gained, leveledUp: xp.leveledUp || bonus.leveledUp };
  }
  res.json({ ok: true, xp, challengeDone });
});

// PUT save timestamps (calibration)
app.put('/api/songs/:id/timestamps', (req, res) => {
  const { timestamps } = req.body || {};
  const songId = req.params.id;
  const uid    = req.session.userId;
  if (!Array.isArray(timestamps) || timestamps.length > 2000 || timestamps.some(t => !Number.isInteger(t?.lineIdx) || !Number.isFinite(t?.time))) {
    return res.status(400).json({ error: 'Timestamps invalides' });
  }
  if (!stmtSongExists.get(songId)) return res.status(404).json({ error: 'Chanson introuvable' });
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

// ── Mastery ──────────────────────────────────────────────────────────
// "non_maitrisee" clears the status but keeps the rest of the progress row
// (attempts, best score, calibrated timestamps).
const stmtSongExists  = db.prepare(`SELECT 1 FROM songs WHERE id = ?`);
const stmtGetMastery  = db.prepare(`SELECT mastery FROM progress WHERE song_id = ? AND user_id = ?`);
const stmtSetMastery  = db.prepare(`UPDATE progress SET mastery = ? WHERE song_id = ? AND user_id = ?`);
const stmtNewProgress = db.prepare(`INSERT INTO progress (user_id, song_id, mastery) VALUES (?, ?, ?)`);
const stmtLogLearned  = db.prepare(`
  INSERT INTO activity_log (user_id, day, kind, count) VALUES (?, date('now','localtime'), 'learned', ?)
  ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + excluded.count
`);

// Returns true when the song becomes "apprise" (for the activity streak)
function setMastery(uid, songId, mastery) {
  const value = mastery === 'non_maitrisee' ? null : mastery;
  const row = stmtGetMastery.get(songId, uid);
  if (row) stmtSetMastery.run(value, songId, uid);
  else if (value) stmtNewProgress.run(uid, songId, value);
  return value === 'maitrisee' && row?.mastery !== 'maitrisee';
}

app.put('/api/songs/:id/mastery', (req, res) => {
  const { mastery } = req.body;
  const uid = req.session.userId;
  if (!VALID_MASTERY.includes(mastery)) return res.status(400).json({ error: 'Invalid mastery value' });
  if (!stmtSongExists.get(req.params.id)) return res.status(404).json({ error: 'Chanson introuvable' });
  if (setMastery(uid, req.params.id, mastery)) stmtLogLearned.run(uid, 1);
  res.json({ ok: true });
});

// PUT one status for many songs (list import)
app.put('/api/mastery/bulk', (req, res) => {
  const { ids, mastery } = req.body || {};
  const uid = req.session.userId;
  if (!VALID_MASTERY.includes(mastery)) return res.status(400).json({ error: 'Invalid mastery value' });
  if (!Array.isArray(ids) || !ids.length || ids.length > 3000 || ids.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: 'ids invalides' });
  }
  const known = [...new Set(ids)].filter(id => stmtSongExists.get(id));
  const learned = db.transaction(() => known.reduce((n, id) => n + (setMastery(uid, id, mastery) ? 1 : 0), 0))();
  if (learned) stmtLogLearned.run(uid, learned);
  res.json({ ok: true, updated: known.length });
});

// POST match free-text lines ("Titre", "Artiste - Titre", "Titre (Artiste)")
// against the catalogue. Returns candidates best-first per line.
const stmtTitleExact = db.prepare(`
  SELECT id, title, artist, year, show_count FROM songs WHERE unaccent(title) = ? ORDER BY show_count DESC NULLS LAST LIMIT 6`);
const stmtTitleLike = db.prepare(`
  SELECT id, title, artist, year, show_count FROM songs WHERE unaccent(title) LIKE ? ORDER BY show_count DESC NULLS LAST LIMIT 6`);

function matchLine(line) {
  const clean = line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim();
  let parts;
  const paren = clean.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (paren) parts = [paren[1], paren[2]];
  else parts = clean.split(/\s+[-–—|]\s+/);
  parts = parts.map(p => unaccentJs(p.trim())).filter(Boolean);

  const scored = new Map();
  const add = (row, score) => {
    const prev = scored.get(row.id);
    if (!prev || prev.score < score) scored.set(row.id, { ...row, score });
  };
  parts.forEach((part, i) => {
    const hint = parts.filter((_, j) => j !== i).join(' ');
    const artistOk = row => hint && (unaccentJs(row.artist).includes(hint) || hint.includes(unaccentJs(row.artist)));
    for (const row of stmtTitleExact.all(part)) add(row, artistOk(row) ? 4 : hint ? 2 : 3);
    if (part.length >= 3) {
      for (const row of stmtTitleLike.all(`%${part}%`)) add(row, artistOk(row) ? 2.5 : 1);
    }
  });
  const candidates = [...scored.values()]
    .sort((a, b) => b.score - a.score || (b.show_count || 0) - (a.show_count || 0))
    .slice(0, 5)
    .map(({ id, title, artist, year, score }) => ({ id, title, artist, year, score }));
  return { line, candidates };
}

app.post('/api/songs/match', (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const clean = lines.map(l => String(l).trim()).filter(Boolean).slice(0, 1000);
  res.json(clean.map(matchLine));
});

// PUT toggle playlist
app.put('/api/songs/:id/playlist', (req, res) => {
  const { in_playlist } = req.body || {};
  const songId = req.params.id;
  const uid    = req.session.userId;
  const val    = in_playlist ? 1 : 0;
  if (!stmtSongExists.get(songId)) return res.status(404).json({ error: 'Chanson introuvable' });
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

// Everything shown on a profile. Only whitelisted, non-sensitive fields, so the
// same payload can later back public profiles and leaderboards (other users).
function profileData(uid) {
  const user = db.prepare(`
    SELECT id, username, bio, avatar_url, created_at, xp, bells, final_winnings, favorite_songs_json
    FROM users WHERE id = ?`).get(uid);
  if (!user) return null;
  const played     = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND attempts > 0`).get(uid).c;
  const maitrisee  = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'maitrisee'`).get(uid).c;
  const revision   = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'revision'`).get(uid).c;
  const prevue     = db.prepare(`SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND mastery = 'prevue'`).get(uid).c;
  const emissions  = db.prepare(`SELECT COUNT(*) as c FROM emissions WHERE user_id = ?`).get(uid).c;
  const total_songs = db.prepare(`SELECT COUNT(*) as c FROM songs`).get().c;
  const non_maitrisee = Math.max(0, total_songs - maitrisee - revision - prevue);

  // Mastery breakdown by song type (MC / FN / other)
  const masteryByType = db.prepare(`
    SELECT
      CASE
        WHEN s.mc_enabled = 1 AND s.fn_enabled = 1 THEN 'both'
        WHEN s.mc_enabled = 1 THEN 'mc'
        WHEN s.fn_enabled = 1 THEN 'fn'
        ELSE 'other'
      END as stype,
      COALESCE(p.mastery, 'non_maitrisee') as mastery,
      COUNT(*) as c
    FROM songs s LEFT JOIN progress p ON s.id = p.song_id AND p.user_id = ?
    GROUP BY stype, mastery
  `).all(uid);

  const byType = { mc: {}, fn: {}, other: {} };
  const totals = { mc: 0, fn: 0, other: 0 };
  for (const row of masteryByType) {
    const types = row.stype === 'both' ? ['mc', 'fn'] : [row.stype === 'other' ? 'other' : row.stype];
    for (const t of types) {
      byType[t][row.mastery] = (byType[t][row.mastery] || 0) + row.c;
      totals[t] += row.c;
    }
  }

  // Top artists by number of songs with any mastery tag
  const topArtists = db.prepare(`
    SELECT s.artist, COUNT(*) as tagged
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.mastery IS NOT NULL
    GROUP BY s.artist ORDER BY tagged DESC LIMIT 5
  `).all(uid);

  // Favorites: user-curated list stored as JSON
  let favIds = [];
  try { favIds = JSON.parse(user.favorite_songs_json || '[]'); } catch (_) {}
  const favSongs = favIds.length
    ? db.prepare(`SELECT id, title, artist FROM songs WHERE id IN (${favIds.map(() => '?').join(',')})`)
        .all(...favIds)
        .sort((a, b) => favIds.indexOf(a.id) - favIds.indexOf(b.id))
    : [];

  const { favorite_songs_json: _f, xp, bells, final_winnings, ...identity } = user;
  return { user: identity, level: levelFromXp(xp), bells, finalWinnings: final_winnings,
           played, total_songs, maitrisee, revision, prevue, non_maitrisee, emissions,
           byType, totals, topArtists, favSongs };
}

app.get('/api/profile', (req, res) => {
  const data = profileData(req.session.userId);
  if (!data) return res.status(404).json({ error: 'Profil introuvable' });
  res.json(data);
});

app.put('/api/profile/favorites', (req, res) => {
  const uid = req.session.userId;
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length > 5 || ids.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: 'ids invalides' });
  }
  const clean = [...new Set(ids)].filter(id => stmtSongExists.get(id));
  db.prepare(`UPDATE users SET favorite_songs_json = ? WHERE id = ?`).run(JSON.stringify(clean), uid);
  res.json({ ok: true });
});

app.get('/api/revision-queue', (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Non connecté' });
  const { mastery, count = 5, mc, source, id } = req.query;
  const n = Math.min(Math.max(1, parseInt(count) || 5), 50);
  let songs;
  if (source === 'queue') {
    songs = db.prepare(`
      SELECT s.id, s.title, s.artist, s.year
      FROM songs s JOIN progress p ON p.song_id = s.id AND p.user_id = ?
      WHERE p.mastery IN ('revision','prevue')
      ORDER BY (p.mastery = 'revision') DESC, p.last_played IS NOT NULL, p.last_played ASC
      LIMIT ?`).all(uid, n);
  } else if (source === 'playlist') {
    songs = db.prepare(`
      SELECT s.id, s.title, s.artist, s.year
      FROM playlist_songs ps
      JOIN playlists pl ON pl.id = ps.playlist_id
      JOIN songs s ON s.id = ps.song_id
      WHERE pl.id = ? AND pl.user_id = ?
      ORDER BY RANDOM() LIMIT ?`).all(parseInt(id) || 0, uid, n);
  } else if (mc === '1' || source === 'mc') {
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
    const name = typeof username === 'string' ? username.trim().normalize('NFC') : username;
    const nameErr = usernameError(name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    if (stmtUsernameTaken.get(name, uid)) return res.status(409).json({ error: 'Ce nom est déjà pris' });
    try {
      db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(name, uid);
    } catch (_) {
      return res.status(409).json({ error: 'Ce nom est déjà pris' });
    }
    req.session.username = name;
  }
  if (bio !== undefined) {
    if (bio !== null && typeof bio !== 'string') return res.status(400).json({ error: 'Bio invalide' });
    // Control and bidi-override characters stripped: the bio will be shown to other users
    const clean = (bio || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, '').trim().slice(0, 200);
    db.prepare(`UPDATE users SET bio = ? WHERE id = ?`).run(clean || null, uid);
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
  if (!ext || typeof data !== 'string') return res.status(400).json({ error: 'Format non supporté' });
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image trop grande (max 4 Mo)' });
  // The declared type must match the file's real signature (no HTML/SVG disguised as an image)
  const MAGIC = {
    jpg:  b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
    png:  b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
    gif:  b => b.subarray(0, 4).toString('ascii') === 'GIF8',
    webp: b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!MAGIC[ext](buf)) return res.status(400).json({ error: 'Fichier image invalide' });
  for (const f of fs.readdirSync(AVATARS_DIR)) {
    if (f.startsWith(`${uid}.`)) fs.unlinkSync(path.join(AVATARS_DIR, f));
  }
  const filename = `${uid}.${ext}`;
  fs.writeFileSync(path.join(AVATARS_DIR, filename), buf);
  const avatar_url = `/avatars/${filename}?v=${Date.now()}`;
  db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(avatar_url, uid);
  res.json({ ok: true, avatar_url });
});

// 'YYYY-MM-DD' arithmetic at UTC noon so DST never shifts the day
function shiftDay(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A day counts as active if a song was played (revision or emission round)
// or a song was marked as learned. A streak stays alive until the end of the
// day: without activity yet today, it counts up to yesterday ("at risk").
function activityStats(uid) {
  const days = db.prepare(`
    SELECT date, SUM(plays) as plays, SUM(learned) as learned FROM (
      SELECT played_at as date, COUNT(*) as plays, 0 as learned
      FROM sessions WHERE user_id = ? GROUP BY played_at
      UNION ALL
      SELECT day as date, 0 as plays, count as learned
      FROM activity_log WHERE user_id = ? AND kind = 'learned'
    ) GROUP BY date ORDER BY date DESC
  `).all(uid, uid);
  const today = db.prepare(`SELECT date('now','localtime') as d`).get().d;
  const activeToday = days[0]?.date === today;

  let streak = 0;
  let check = activeToday ? today : shiftDay(today, -1);
  for (const { date } of days) {
    if (date > check) continue;
    if (date !== check) break;
    streak++;
    check = shiftDay(check, -1);
  }

  let maxStreak = 0, cur = 0, prev = null;
  for (const { date } of [...days].reverse()) {
    cur = prev && shiftDay(prev, 1) === date ? cur + 1 : 1;
    maxStreak = Math.max(maxStreak, cur);
    prev = date;
  }

  const todayRow = activeToday ? days[0] : { plays: 0, learned: 0 };
  return {
    today, days, streak, maxStreak, totalActiveDays: days.length,
    streakAtRisk: streak > 0 && !activeToday,
    todayCount: (todayRow.plays || 0) + (todayRow.learned || 0),
  };
}

app.get('/api/profile/activity', (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Non connecté' });
  const a = activityStats(uid);
  res.json({ today: a.today, days: a.days.slice(0, 60), streak: a.streak, maxStreak: a.maxStreak,
             totalActiveDays: a.totalActiveDays, streakAtRisk: a.streakAtRisk });
});

// ── Gamification: challenge, badges ────────────────────────────────
const CHALLENGE_PASS = 50;      // % needed on the daily challenge song
const DAILY_GOAL     = 3;       // songs played or learned per day

// Today's challenge is picked once per user and stored, so it stays put all
// day. A song is never given twice to the same user: each step below only
// looks at songs this user has never had as a challenge, and not yet learned.
//   1. the 40 songs aired most often over the last 12 months, random pick;
//   2. once those run out, the 40 most-played songs of the whole archive;
//   3. only when everything was used: the challenge given longest ago.
const stmtChallengeToday = db.prepare(`SELECT song_id, completed FROM daily_challenges WHERE user_id = ? AND day = date('now','localtime')`);
const CHALLENGE_POOLS = [
  db.prepare(`
    SELECT s.id FROM songs s LEFT JOIN progress p ON p.song_id = s.id AND p.user_id = ?
    WHERE s.aired_12m > 0 AND (p.mastery IS NULL OR p.mastery != 'maitrisee')
      AND NOT EXISTS (SELECT 1 FROM daily_challenges d WHERE d.user_id = ? AND d.song_id = s.id)
    ORDER BY s.aired_12m DESC LIMIT 40`),
  db.prepare(`
    SELECT s.id FROM songs s LEFT JOIN progress p ON p.song_id = s.id AND p.user_id = ?
    WHERE s.show_count > 0 AND (p.mastery IS NULL OR p.mastery != 'maitrisee')
      AND NOT EXISTS (SELECT 1 FROM daily_challenges d WHERE d.user_id = ? AND d.song_id = s.id)
    ORDER BY s.show_count DESC LIMIT 40`),
];
const stmtChallengeOldest = db.prepare(`
  SELECT d.song_id AS id FROM daily_challenges d
  LEFT JOIN progress p ON p.song_id = d.song_id AND p.user_id = d.user_id
  WHERE d.user_id = ? AND (p.mastery IS NULL OR p.mastery != 'maitrisee')
  GROUP BY d.song_id ORDER BY MAX(d.day) ASC LIMIT 1`);

function dailyChallenge(uid) {
  let row = stmtChallengeToday.get(uid);
  if (!row) {
    let pick = null;
    for (const pool of CHALLENGE_POOLS) {
      const ids = pool.all(uid, uid);
      if (ids.length) { pick = ids[crypto.randomInt(ids.length)].id; break; }
    }
    pick ??= stmtChallengeOldest.get(uid)?.id;
    if (!pick) return null;
    // Two tabs opening at once must not create two different challenges
    db.prepare(`INSERT OR IGNORE INTO daily_challenges (user_id, day, song_id) VALUES (?, date('now','localtime'), ?)`).run(uid, pick);
    row = stmtChallengeToday.get(uid);
  }
  const song = db.prepare(`SELECT id, title, artist, year, aired_12m FROM songs WHERE id = ?`).get(row.song_id);
  return song && { ...song, completed: !!row.completed, xp: XP.challenge, pass: CHALLENGE_PASS };
}

const BADGES = [
  { id: 'learn_1',      label: 'Premiers pas',        icon: '1',   tier: 'green',  stat: 'learned',     goal: 1,    desc: 'Apprendre une chanson' },
  { id: 'learn_50',     label: '50 apprises',         icon: '50',  tier: 'green',  stat: 'learned',     goal: 50,   desc: 'Apprendre 50 chansons' },
  { id: 'learn_100',    label: '100 apprises',        icon: '100', tier: 'green',  stat: 'learned',     goal: 100,  desc: 'Apprendre 100 chansons' },
  { id: 'learn_250',    label: '250 apprises',        icon: '250', tier: 'green',  stat: 'learned',     goal: 250,  desc: 'Apprendre 250 chansons' },
  { id: 'learn_500',    label: '500 apprises',        icon: '500', tier: 'green',  stat: 'learned',     goal: 500,  desc: 'Apprendre 500 chansons' },
  { id: 'learn_1000',   label: '1 000 apprises',      icon: '1K',  tier: 'green',  stat: 'learned',     goal: 1000, desc: 'Apprendre 1 000 chansons' },
  { id: 'mc_25',        label: 'Même chanson',        icon: 'MC',  tier: 'blue',   stat: 'mcLearned',   goal: 25,   desc: 'Apprendre 25 chansons « Même chanson »' },
  { id: 'mc_100',       label: 'Pilier du MC',        icon: 'MC',  tier: 'blue',   stat: 'mcLearned',   goal: 100,  desc: 'Apprendre 100 chansons « Même chanson »' },
  { id: 'fn_50',        label: 'Finaliste',           icon: 'FN',  tier: 'blue',   stat: 'fnLearned',   goal: 50,   desc: 'Apprendre 50 chansons de finale' },
  { id: 'perfect',      label: 'Sans faute',          icon: '100%',tier: 'gold',   stat: 'perfect',     goal: 1,    desc: 'Obtenir 100 % sur une chanson' },
  { id: 'streak_3',     label: 'Sur la lancée',       icon: '3j',  tier: 'orange', stat: 'maxStreak',   goal: 3,    desc: '3 jours d\u2019activité de suite' },
  { id: 'streak_7',     label: 'Une semaine',         icon: '7j',  tier: 'orange', stat: 'maxStreak',   goal: 7,    desc: '7 jours d\u2019activité de suite' },
  { id: 'streak_30',    label: 'Inarrêtable',         icon: '30j', tier: 'orange', stat: 'maxStreak',   goal: 30,   desc: '30 jours d\u2019activité de suite' },
  { id: 'challenge_1',  label: 'Défi relevé',         icon: '★',   tier: 'gold',   stat: 'challenges',  goal: 1,    desc: 'Réussir un défi du jour' },
  { id: 'challenge_10', label: 'Collectionneur',      icon: '★10', tier: 'gold',   stat: 'challenges',  goal: 10,   desc: 'Réussir 10 défis du jour' },
  { id: 'emission_1',   label: 'En plateau',          icon: 'TV',  tier: 'blue',   stat: 'emissions',   goal: 1,    desc: 'Terminer une émission' },
  { id: 'emission_10',  label: 'Habitué du plateau',  icon: 'TV',  tier: 'blue',   stat: 'emissions',   goal: 10,   desc: 'Terminer 10 émissions' },
  { id: 'coverage_25',  label: 'Prêt pour le plateau',icon: '25%', tier: 'gold',   stat: 'coveragePct', goal: 25,   desc: 'Connaître 25 % du répertoire de l\u2019année' },
];

function gamification(uid, activity) {
  const c = db.prepare(`
    SELECT
      COUNT(CASE WHEN p.mastery = 'maitrisee' THEN 1 END)                     AS learned,
      COUNT(CASE WHEN p.mastery = 'maitrisee' AND s.mc_count > 0 THEN 1 END)  AS mcLearned,
      COUNT(CASE WHEN p.mastery = 'maitrisee' AND s.fn_count > 0 THEN 1 END)  AS fnLearned,
      COUNT(CASE WHEN p.best_score >= 100 THEN 1 END)                         AS perfect
    FROM progress p JOIN songs s ON s.id = p.song_id WHERE p.user_id = ?
  `).get(uid);
  const plays      = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).get(uid).n;
  const challenges = db.prepare(`SELECT COUNT(*) AS n FROM daily_challenges WHERE user_id = ? AND completed = 1`).get(uid).n;
  const emissions  = db.prepare(`SELECT COUNT(*) AS n FROM emissions WHERE user_id = ?`).get(uid).n;
  const cov = db.prepare(`
    SELECT COUNT(*) AS aired, COUNT(CASE WHEN p.mastery = 'maitrisee' THEN 1 END) AS known
    FROM songs s LEFT JOIN progress p ON p.song_id = s.id AND p.user_id = ?
    WHERE s.aired_12m > 0
  `).get(uid);
  const coveragePct = cov.aired ? Math.round(cov.known / cov.aired * 100) : 0;

  const stats = { ...c, plays, challenges, emissions, coveragePct, maxStreak: activity.maxStreak };
  const xp = stmtXpGet.get(uid)?.xp ?? 0;
  const badges = BADGES.map(({ stat, goal, ...b }) => ({
    ...b, goal, value: Math.min(stats[stat], goal), unlocked: stats[stat] >= goal,
  }));
  return { level: levelFromXp(xp), stats, coverage: { ...cov, pct: coveragePct }, badges };
}

// GET everything the home screen needs in one round trip
app.get('/api/home', (req, res) => {
  const uid = req.session.userId;
  const activity = activityStats(uid);
  const g = gamification(uid, activity);

  const queueCounts = db.prepare(`
    SELECT COUNT(CASE WHEN mastery = 'revision' THEN 1 END) AS revision,
           COUNT(CASE WHEN mastery = 'prevue'   THEN 1 END) AS prevue
    FROM progress WHERE user_id = ?
  `).get(uid);
  const next = db.prepare(`
    SELECT s.id, s.title, s.artist, s.year, p.mastery, p.last_score, p.last_played
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.mastery IN ('revision','prevue')
    ORDER BY (p.mastery = 'revision') DESC, p.last_played IS NOT NULL, p.last_played ASC
    LIMIT 1
  `).get(uid) || null;

  const priority = db.prepare(`
    SELECT s.id, s.title, s.artist, s.aired_12m AS aired
    FROM songs s LEFT JOIN progress p ON p.song_id = s.id AND p.user_id = ?
    WHERE s.aired_12m > 0 AND (p.mastery IS NULL OR p.mastery != 'maitrisee')
    ORDER BY s.aired_12m DESC, ${DEFAULT_ORDER} LIMIT 5
  `).all(uid);

  ensureDefaultPlaylist(uid);
  const playlists = db.prepare(`
    SELECT p.id, p.name, p.is_default, COUNT(ps.song_id) AS count
    FROM playlists p LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
    WHERE p.user_id = ? GROUP BY p.id ORDER BY p.is_default DESC, p.created_at
  `).all(uid);
  const mcCount = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE mc_count > 0`).get().n;

  const recentSongs = db.prepare(`
    SELECT 'song' AS type, s.id, s.title, s.artist, p.last_score AS score, p.last_played AS at
    FROM progress p JOIN songs s ON s.id = p.song_id
    WHERE p.user_id = ? AND p.last_played IS NOT NULL
    ORDER BY p.last_played DESC LIMIT 4
  `).all(uid);
  const recentEmissions = db.prepare(`
    SELECT 'emission' AS type, source, mode, score, opp_score AS oppScore, played_at AS at
    FROM emissions WHERE user_id = ? ORDER BY played_at DESC LIMIT 4
  `).all(uid);
  const recent = [...recentSongs, ...recentEmissions].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 4);

  res.json({
    level: g.level,
    streak: { current: activity.streak, best: activity.maxStreak, atRisk: activity.streakAtRisk,
              today: activity.todayCount, goal: DAILY_GOAL },
    queue: { ...queueCounts, total: queueCounts.revision + queueCounts.prevue, next },
    challenge: dailyChallenge(uid),
    coverage: { ...g.coverage, priority },
    playlists,
    smart: { mc: mcCount },
    badges: g.badges,
    recent,
  });
});

// POST a finished emission (score history, badges, XP, final winnings).
// Needs the one-time token handed out by /api/emission/generate, so each
// generated emission can be recorded (and rewarded) only once.
const stmtEmissionsToday = db.prepare(`
  SELECT COUNT(*) AS n FROM xp_events WHERE user_id = ? AND kind = 'emission' AND day = date('now','localtime')`);

app.post('/api/emission/complete', (req, res) => {
  const uid = req.session.userId;
  const { source, mode, score, oppScore, finalGain = null, token } = req.body || {};
  const okScore = v => v == null || (Number.isInteger(v) && v >= 0 && v <= 1000);
  if (!['real', 'episode', 'generated'].includes(source) || !['solo', 'duel'].includes(mode)
      || !okScore(score) || !okScore(oppScore) || (finalGain !== null && !FINAL_GAINS.includes(finalGain))) {
    return res.status(400).json({ error: 'Données invalides' });
  }
  if (!token || typeof token !== 'string' || token !== req.session.emissionToken) {
    return res.status(409).json({ error: 'Émission déjà enregistrée ou inconnue' });
  }
  delete req.session.emissionToken;

  const entry = { mode, score: score ?? 0, oppScore: mode === 'duel' ? (oppScore ?? 0) : null };
  const underCap = stmtEmissionsToday.get(uid).n < XP.emissionDailyCap;
  const gain = finalGain ?? 0;
  const amount = underCap ? emissionXp(entry) + Math.floor(gain / XP.finalePerXp) : 0;

  const { lastInsertRowid: emissionId } = db.transaction(() => {
    const r = db.prepare(`INSERT INTO emissions (user_id, source, mode, score, opp_score, final_gain, xp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(uid, source, mode, entry.score, entry.oppScore, finalGain, amount);
    if (gain) db.prepare(`UPDATE users SET final_winnings = final_winnings + ? WHERE id = ?`).run(gain, uid);
    return r;
  })();
  const xp = awardXp(uid, 'emission', amount, String(emissionId));
  res.json({ ok: true, xp });
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

// The default playlist was called "Révision"; it is the ★ list, now "Favoris"
db.prepare(`UPDATE playlists SET name = 'Favoris' WHERE is_default = 1 AND name = 'Révision'`).run();

function ensureDefaultPlaylist(uid) {
  const existing = db.prepare(`SELECT id FROM playlists WHERE user_id = ? AND is_default = 1`).get(uid);
  if (existing) return existing.id;
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO playlists (user_id, name, is_default) VALUES (?, 'Favoris', 1)`
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
  if (!stmtSongExists.get(req.params.songId)) return res.status(404).json({ error: 'Chanson introuvable' });
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
    req.session.emissionToken = crypto.randomBytes(16).toString('hex');

    res.json({
      token: req.session.emissionToken,
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
  console.log(`\nNOPLR - http://localhost:${PORT}\n`);
});

process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err);
});
