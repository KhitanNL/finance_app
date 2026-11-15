-- Run statement by statement by tools/deploy.sh; "duplicate column" errors are expected on later runs.
ALTER TABLE players ADD COLUMN pbhalf INTEGER;
ALTER TABLE players ADD COLUMN recovery_hash TEXT;
ALTER TABLE players ADD COLUMN spent_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
