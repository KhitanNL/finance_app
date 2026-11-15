-- Upgrade v1 -> v2: split the old "players" table into CHARACTERS (the roster) and PLAYERS (the people).
-- tools/deploy.sh runs this once, only when the old players table (with a legacy_id column) exists.
-- In v1 a "profile" was a roster row owned by a device (device_token_hash), results stored the runner
-- (player_id) and the profile on the phone (by_player_id).

-- 1. The old roster becomes the characters table.
ALTER TABLE players RENAME TO characters;
ALTER TABLE characters ADD COLUMN claim_hash TEXT;

-- 2. New players table.
CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  avatar_key TEXT,
  avatar_character_id INTEGER,
  linked_character_id INTEGER,
  recovery_hash TEXT,
  spent_points INTEGER NOT NULL DEFAULT 0,
  name_confirmed INTEGER NOT NULL DEFAULT 1,
  is_unknown INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX players_name ON players(club_id, name_key);
CREATE UNIQUE INDEX players_link ON players(linked_character_id) WHERE linked_character_id IS NOT NULL;

-- 3. Every roster row that belonged to a device (or raced from a phone) becomes a player, linked to
--    that character ("this is me"). Same names in one club get the character id added to stay unique.
--    name_confirmed = 0 asks them to confirm their player name on the next launch.
INSERT INTO players (club_id, name, name_key, avatar_character_id, linked_character_id, recovery_hash, spent_points, name_confirmed, banned, removed, created_at)
SELECT c.club_id,
       CASE WHEN EXISTS (SELECT 1 FROM characters d WHERE d.club_id = c.club_id AND d.id < c.id AND lower(trim(d.name)) = lower(trim(c.name))
                         AND (d.device_token_hash IS NOT NULL OR d.id IN (SELECT player_id FROM player_devices) OR d.id IN (SELECT by_player_id FROM results WHERE by_player_id IS NOT NULL)))
            THEN substr(trim(c.name), 1, 14) || ' ' || c.id ELSE substr(trim(c.name), 1, 20) END,
       CASE WHEN EXISTS (SELECT 1 FROM characters d WHERE d.club_id = c.club_id AND d.id < c.id AND lower(trim(d.name)) = lower(trim(c.name))
                         AND (d.device_token_hash IS NOT NULL OR d.id IN (SELECT player_id FROM player_devices) OR d.id IN (SELECT by_player_id FROM results WHERE by_player_id IS NOT NULL)))
            THEN lower(substr(trim(c.name), 1, 14) || ' ' || c.id) ELSE lower(substr(trim(c.name), 1, 20)) END,
       c.id, c.id, c.recovery_hash, c.spent_points, 0, c.banned, c.removed, c.created_at
FROM characters c
WHERE c.device_token_hash IS NOT NULL OR c.id IN (SELECT player_id FROM player_devices)
   OR c.id IN (SELECT by_player_id FROM results WHERE by_player_id IS NOT NULL);

-- 4. Devices: phones added with a recovery code first (they still point at the old roster id), then the first phone.
UPDATE player_devices SET player_id = (SELECT p.id FROM players p WHERE p.linked_character_id = player_devices.player_id);
INSERT OR IGNORE INTO player_devices (token_hash, player_id, created_at)
SELECT c.device_token_hash, p.id, c.created_at FROM characters c JOIN players p ON p.linked_character_id = c.id WHERE c.device_token_hash IS NOT NULL;

-- 5. A recovery code made by the captain for a roster row nobody used yet becomes that character's claim code.
UPDATE characters SET claim_hash = recovery_hash
 WHERE recovery_hash IS NOT NULL AND id NOT IN (SELECT linked_character_id FROM players WHERE linked_character_id IS NOT NULL);

-- 6. Results: the runner becomes character_id, the phone's profile becomes player_id.
ALTER TABLE results RENAME COLUMN player_id TO character_id;
ALTER TABLE results ADD COLUMN player_id INTEGER;
UPDATE results SET player_id = (SELECT p.id FROM players p WHERE p.linked_character_id = results.by_player_id) WHERE by_player_id IS NOT NULL;

-- 7. Results raced without a profile have no device: they go to one "Unknown player" per club (character kept).
INSERT INTO players (club_id, name, name_key, is_unknown, name_confirmed, created_at)
SELECT DISTINCT club_id, 'Unknown player', 'unknown player', 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM results WHERE player_id IS NULL;
UPDATE results SET player_id = (SELECT p.id FROM players p WHERE p.club_id = results.club_id AND p.is_unknown = 1) WHERE player_id IS NULL;
DROP INDEX IF EXISTS results_by;
ALTER TABLE results DROP COLUMN by_player_id;
CREATE INDEX IF NOT EXISTS results_player ON results(player_id, mode);
CREATE INDEX IF NOT EXISTS results_character ON results(character_id, mode);

-- 8. Reports pointed at the roster row: that is a character.
ALTER TABLE reports RENAME COLUMN player_id TO character_id;
ALTER TABLE reports ADD COLUMN player_id INTEGER;

-- 9. Player progress no longer lives on characters.
ALTER TABLE characters DROP COLUMN device_token_hash;
ALTER TABLE characters DROP COLUMN recovery_hash;
ALTER TABLE characters DROP COLUMN spent_points;
DROP INDEX IF EXISTS players_club;
CREATE INDEX IF NOT EXISTS characters_club ON characters(club_id);
