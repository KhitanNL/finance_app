-- Wolfpack Run database (Cloudflare D1 / SQLite), schema v2.
-- Privacy: no raw IP addresses are ever stored. Visitors are identified only by a
-- SHA-256 hash of IP + User-Agent + a random salt that rotates every UTC day.
--
-- Two different things, like a fighting game:
--   players    = the real people holding a phone (gamer tag, device, points, streaks, results)
--   characters = the runners in a club roster that anyone can race as (photo, real-life PBs, game stats)
-- A player can be linked to one character ("this is me"); that only allows editing that character's
-- photo, story and real PBs. Older databases are upgraded by worker/migrate-v2.sql (see tools/deploy.sh).

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

-- CHARACTERS: the club roster. Anyone in the club can race as any character.
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  legacy_id TEXT,                 -- built-in Wolfpack runners keep their hand-made sprite, stats and perk
  name TEXT NOT NULL,
  nickname TEXT,
  tagline TEXT,
  pb5k INTEGER, pb10k INTEGER, pbhalf INTEGER, pbmar INTEGER,   -- REAL-LIFE PBs in seconds (never game times)
  photo_key TEXT,                 -- R2 key (u/...) or static:img/... for built-in photos
  story TEXT,
  fast INTEGER NOT NULL DEFAULT 3, slow INTEGER NOT NULL DEFAULT 3,
  love INTEGER NOT NULL DEFAULT 4, jump INTEGER NOT NULL DEFAULT 4,
  stats_locked INTEGER NOT NULL DEFAULT 0,      -- 1 once the captain has set the stats by hand
  color TEXT,
  claim_hash TEXT,                -- one-time code from the captain so the real person can link ("this is me")
  banned INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_club ON characters(club_id);

-- PLAYERS: the people holding the phone. They own their progress.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  name TEXT NOT NULL,             -- player name / gamer tag, 2 to 20 characters
  name_key TEXT NOT NULL,         -- lower case, unique within the club
  avatar_key TEXT,                -- own uploaded avatar (R2 u/...)
  avatar_character_id INTEGER,    -- or: use this character's photo as avatar
  linked_character_id INTEGER,    -- optional "this is me"
  recovery_hash TEXT,             -- hash of the recovery code (no email, no password)
  spent_points INTEGER NOT NULL DEFAULT 0,      -- for the shoe shop
  name_confirmed INTEGER NOT NULL DEFAULT 1,    -- 0 = created by the v2 migration, asked to confirm the name
  is_unknown INTEGER NOT NULL DEFAULT 0,        -- 1 = "Unknown player" that holds old anonymous results
  banned INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS players_name ON players(club_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS players_link ON players(linked_character_id) WHERE linked_character_id IS NOT NULL;

-- Devices of a player (first phone, and phones added later with the recovery code).
CREATE TABLE IF NOT EXISTS player_devices (
  token_hash TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_devices_p ON player_devices(player_id);

-- Every finished race: WHO raced (player) as WHICH runner (character).
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  time_s INTEGER NOT NULL,
  taps INTEGER NOT NULL,
  max_cad INTEGER NOT NULL,
  day TEXT NOT NULL,              -- Amsterdam date, for the daily top score
  created_at INTEGER NOT NULL,
  visitor TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  player_id INTEGER
);
CREATE INDEX IF NOT EXISTS results_board ON results(club_id, mode, day, time_s);
CREATE INDEX IF NOT EXISTS results_player ON results(player_id, mode);
CREATE INDEX IF NOT EXISTS results_character ON results(character_id, mode);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- photo or story (of a character), avatar (of a player)
  character_id INTEGER,
  club_id INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  visitor TEXT,
  player_id INTEGER
);

CREATE TABLE IF NOT EXISTS banned_devices (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,           -- e.g. upload:<visitor>:<day>
  n INTEGER NOT NULL
);
