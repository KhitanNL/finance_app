-- First club: Wolfpack Zuiderpark, with the original hand-made runners.
-- The captain link is created later from the admin dashboard (Clubs tab), so no secret lives in this file.
INSERT OR IGNORE INTO clubs (id, slug, name, course, color, captain_name, join_code, created_at)
VALUES (1, 'wolfpack-zuiderpark', 'Wolfpack Zuiderpark', 'Zuiderpark, Den Haag', '#f26a1b', 'Mao', 'WOLF01', 1763164800000);

INSERT OR IGNORE INTO players (id, club_id, legacy_id, name, nickname, tagline, pb5k, photo_key, fast, slow, love, jump, stats_locked, created_at) VALUES
 (1,  1, 'julian',  'Julian',         'JULIAN',   'Asics addict.',                   1095, 'static:img/julian.jpg', 5, 1, 2, 3, 1, 1763164800000),
 (2,  1, 'jordi',   'Jordi',          'JORDI',    'Mr. 5K.',                         1129, 'static:img/jordi.jpg',  4, 2, 5, 3, 1, 1763164800000),
 (3,  1, 'luca',    'Luca',           'LUCA',     'Mr 17:38 5K and 4h marathon.',    1058, 'static:img/luca.jpg',   1, 5, 2, 3, 1, 1763164800000),
 (4,  1, 'singho',  'Sing',           'SING',     'Free energy gel collector.',      1150, 'static:img/singho.jpg', 3, 3, 2, 2, 1, 1763164800000),
 (5,  1, 'ronald',  'Ronald',         'RONALD',   'The flying postman.',             1120, 'static:img/ronald.jpg', 3, 3, 2, 4, 1, 1763164800000),
 (6,  1, 'ivan',    'Ivan',           'IVAN',     'Personal trainer.',               1100, 'static:img/ivan.jpg',   4, 2, 3, 4, 1, 1763164800000),
 (7,  1, 'jeroen',  'Jeroen',         'JEROEN',   'Chief running officer.',          1230, 'static:img/jeroen.jpg', 2, 4, 2, 3, 1, 1763164800000),
 (8,  1, 'blake',   'Dr Blake',       'DR BLAKE', 'The running re-aligner.',         1065, 'static:img/blake.jpg',  4, 2, 2, 3, 1, 1763164800000),
 (9,  1, 'mao',     'Mao',            'MAO',      'The dealer.',                     1030, 'static:img/mao.jpg',    3, 3, 2, 3, 1, 1763164800000),
 (10, 1, 'rodi',    'Rody',           'RODY',     'Mystery animal. A true diesel.',  1110, NULL,                    1, 5, 2, 1, 1, 1763164800000),
 (11, 1, 'draakie', 'Jony (Draakie)', 'JONY',     'Gelletje!!!',                     1120, NULL,                    3, 3, 1, 4, 1, 1763164800000);
