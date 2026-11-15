-- Wolfpack Run database (Cloudflare D1 / SQLite)
-- Privacy: no raw IP addresses are ever stored. Visitors are identified only by a
-- SHA-256 hash of IP + User-Agent + a random salt that rotates every UTC day.

CREATE TABLE IF NOT EXISTS salts (
  day  TEXT PRIMARY KEY,          -- UTC date YYYY-MM-DD; only today's row is kept
  salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- unix ms
  day TEXT NOT NULL,              -- UTC date
  hour INTEGER NOT NULL,          -- UTC hour 0-23
  type TEXT NOT NULL,             -- page_view, race_start, race_finish, result_shared, club_created, club_joined
  visitor TEXT NOT NULL,          -- daily visitor hash (not an IP)
  country TEXT, region TEXT, city TEXT,
  referrer TEXT,                  -- domain only
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  device TEXT,                    -- mobile or desktop
  path TEXT,
  club TEXT, runner TEXT, mode TEXT, time_s INTEGER
);
CREATE INDEX IF NOT EXISTS events_day_type ON events(day, type);
CREATE INDEX IF NOT EXISTS events_visitor ON events(visitor);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  visitor TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_v ON login_attempts(visitor, ts);

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  course TEXT,
  color TEXT,
  captain_name TEXT,
  captain_token_hash TEXT,
  captain_email TEXT,
  join_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_by TEXT,                -- daily visitor hash, only used for the clubs-per-day limit
  removed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  legacy_id TEXT,                 -- built-in Wolfpack runners keep their hand-made sprite and perk
  name TEXT NOT NULL,
  nickname TEXT,
  tagline TEXT,
  pb5k INTEGER, pb10k INTEGER, pbmar INTEGER,   -- seconds
  photo_key TEXT,                 -- R2 key (u/...) or static:img/... for built-in photos
  story TEXT,
  fast INTEGER NOT NULL DEFAULT 3, slow INTEGER NOT NULL DEFAULT 3,
  love INTEGER NOT NULL DEFAULT 4, jump INTEGER NOT NULL DEFAULT 4,
  stats_locked INTEGER NOT NULL DEFAULT 0,      -- 1 once the captain has set the stats
  color TEXT,
  device_token_hash TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_club ON players(club_id);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,     -- the runner that was raced
  by_player_id INTEGER,           -- the profile on this device, if any
  mode TEXT NOT NULL,
  time_s INTEGER NOT NULL,
  taps INTEGER NOT NULL,
  max_cad INTEGER NOT NULL,
  day TEXT NOT NULL,              -- Amsterdam date, for the daily top score
  created_at INTEGER NOT NULL,
  visitor TEXT
);
CREATE INDEX IF NOT EXISTS results_board ON results(club_id, mode, day, time_s);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- photo or story
  player_id INTEGER NOT NULL,
  club_id INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  visitor TEXT
);

CREATE TABLE IF NOT EXISTS banned_devices (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Extra devices of one player (a profile recovered on a new phone with its recovery code).
CREATE TABLE IF NOT EXISTS player_devices (
  token_hash TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_devices_p ON player_devices(player_id);
CREATE INDEX IF NOT EXISTS results_by ON results(by_player_id, mode);

CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,           -- e.g. upload:<visitor>:<day>
  n INTEGER NOT NULL
);

-- Later columns (players.pbhalf, players.recovery_hash, players.spent_points, results.points)
-- are added by worker/migrations.sql.
