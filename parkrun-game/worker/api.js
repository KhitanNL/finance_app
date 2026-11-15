// Wolfpack Run API + static site (Cloudflare Pages advanced mode, _worker.js).
// Bindings: DB (D1), BUCKET (R2), ADMIN_PASSWORD_HASH (secret), ASSETS (Pages static assets).
// Privacy rule: the client IP is only used in memory to compute a daily visitor hash.
// It is never written to the database and never logged.

/* PAGES and verifyPassword are injected by tools/build.mjs */

const enc = new TextEncoder();
const MAX_UPLOAD = 2 * 1024 * 1024;
const CLUBS_PER_VISITOR_PER_DAY = 3;
const JOINS_PER_VISITOR_PER_DAY = 20;
const UPLOADS_PER_VISITOR_PER_DAY = 30;
const REPORTS_PER_VISITOR_PER_DAY = 20;
const RESULTS_PER_VISITOR_PER_DAY = 300;
const RECOVER_TRIES_PER_VISITOR_PER_DAY = 10;
const POINTS = { race: 10, pb: 20, streak: 5 };   // per finished race, new personal best, raced the day before too
const SESSION_HOURS = 12;
const TS = 15;                    // race seconds per real second (must match the game)
const EVENT_TYPES = new Set(['page_view', 'race_start', 'race_finish', 'result_shared', 'club_created', 'club_joined']);
const MODES = new Set(['classic']);

/* ---------- small helpers ---------- */
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const amsDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const bad = (msg, status = 400) => json({ error: msg }, status);

function deviceType(ua) { return /Mobi|Android|iPhone|iPad|iPod/i.test(ua || '') ? 'mobile' : 'desktop'; }
function refDomain(ref, host) {
  try { const h = new URL(ref).hostname.replace(/^www\./, ''); return h && h !== host ? h.slice(0, 80) : null; } catch { return null; }
}

/* ---------- daily salt + visitor hash (no raw IP stored) ---------- */
async function dailySalt(env) {
  const day = utcDay();
  let row = await env.DB.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').bind(day, randomHex(32)).run();
    await env.DB.prepare('DELETE FROM salts WHERE day <> ?').bind(day).run();    // old salts are gone for good
    row = await env.DB.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first();
  }
  return row.salt;
}
async function visitorHash(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '';
  const ua = req.headers.get('user-agent') || '';
  return sha256(ip + '|' + ua + '|' + await dailySalt(env));
}
async function bump(env, key, max) {
  const row = await env.DB.prepare('SELECT n FROM limits WHERE key = ?').bind(key).first();
  if (row && row.n >= max) return false;
  await env.DB.prepare('INSERT INTO limits (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1').bind(key).run();
  return true;
}
async function track(req, env, type, extra = {}) {
  const now = new Date(), cf = req.cf || {};
  await env.DB.prepare(`INSERT INTO events (ts, day, hour, type, visitor, country, region, city, referrer,
      utm_source, utm_medium, utm_campaign, device, path, club, runner, mode, time_s)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    now.getTime(), utcDay(now), now.getUTCHours(), type, await visitorHash(req, env),
    clean(cf.country, 8) || null, clean(cf.region, 60) || null, clean(cf.city, 60) || null,
    extra.referrer || null, extra.utm_source || null, extra.utm_medium || null, extra.utm_campaign || null,
    deviceType(req.headers.get('user-agent')), extra.path || null,
    extra.club || null, extra.runner || null, extra.mode || null, extra.time_s ?? null
  ).run();
}

/* ---------- Riegel stat helper (same budget as the game: FAST+SLOW = 6, total = 14) ---------- */
function suggestStats(pb5, pb10, pbm) {
  let lean = 0;                                     // + means endurance (slow twitch)
  if (pb5 && pb10) { const r = pb10 / (pb5 * Math.pow(10 / 5, 1.06)); if (r < 0.985) lean++; else if (r > 1.03) lean--; }
  if (pb5 && pbm) { const r = pbm / (pb5 * Math.pow(42.195 / 5, 1.06)); if (r < 0.99) lean++; else if (r > 1.08) lean--; }
  const slow = Math.max(1, Math.min(5, 3 + lean));
  return { fast: 6 - slow, slow, love: 4, jump: 4 };
}
function validStats(s) {
  const v = ['fast', 'slow', 'love', 'jump'].map(k => int(s?.[k], 1, 5));
  if (v.some(x => x === null)) return null;
  const [fast, slow, love, jump] = v;
  if (fast + slow !== 6 || fast + slow + love + jump !== 14) return null;
  return { fast, slow, love, jump };
}

/* ---------- clubs, characters (the roster) and players (the people) ---------- */
// CHARACTER = a runner in the club roster that anyone can race as.
// PLAYER    = the person holding the phone: player name, devices, points, streaks and all results.
const PUBLIC_CHAR = 'id, club_id, legacy_id, name, nickname, tagline, pb5k, pb10k, pbhalf, pbmar, photo_key, story, fast, slow, love, jump, stats_locked, color';
const photoUrl = k => !k ? null : k.startsWith('static:') ? '/' + k.slice(7) : '/img/u/' + k.slice(2);
function charOut(c) {
  return { id: c.id, legacy_id: c.legacy_id, name: c.name, nickname: c.nickname, tagline: c.tagline,
    pb5k: c.pb5k, pb10k: c.pb10k, pbhalf: c.pbhalf, pbmar: c.pbmar, photo: photoUrl(c.photo_key), story: c.story,
    stats_locked: !!c.stats_locked, stats: { fast: c.fast, slow: c.slow, love: c.love, jump: c.jump }, color: c.color };
}
const PLAYER_SQL = `SELECT p.*, ac.photo_key AS av_photo, lc.nickname AS linked_name, lc.photo_key AS linked_photo
  FROM players p LEFT JOIN characters ac ON ac.id = p.avatar_character_id AND ac.removed = 0
  LEFT JOIN characters lc ON lc.id = p.linked_character_id AND lc.removed = 0`;
function playerOut(p) {
  return { id: p.id, name: p.name, avatar: p.avatar_key ? photoUrl(p.avatar_key) : photoUrl(p.av_photo),
    avatar_custom: !!p.avatar_key, avatar_character_id: p.avatar_character_id || null,
    linked_character_id: p.linked_character_id || null, linked_name: p.linked_name || null,
    unknown: !!p.is_unknown, needs_name: !p.name_confirmed };
}
async function clubBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM clubs WHERE slug = ? AND removed = 0').bind(clean(slug, 60)).first();
}
async function isCaptain(req, env, club) {
  const t = req.headers.get('x-captain-token');
  return !!(t && club.captain_token_hash && await sha256(t) === club.captain_token_hash);
}
// The player on this phone in this club (from the private device token), or null.
async function devicePlayer(req, env, clubId) {
  const t = req.headers.get('x-device-token');
  if (!t) return null;
  return env.DB.prepare(`${PLAYER_SQL} JOIN player_devices d ON d.player_id = p.id
    WHERE d.token_hash = ? AND p.club_id = ? AND p.removed = 0 AND p.banned = 0`).bind(await sha256(t), clubId).first();
}
async function deviceBanned(req, env) {
  const t = req.headers.get('x-device-token');
  if (!t) return false;
  return !!await env.DB.prepare('SELECT 1 FROM banned_devices WHERE token_hash = ?').bind(await sha256(t)).first();
}
function slugify(s) {
  return clean(s, 60).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'club';
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function joinCode() { const b = crypto.getRandomValues(new Uint8Array(6)); return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join(''); }
const PARKRUN = 'Please leave out the word parkrun (it is a trademark).';
// Player name: 2 to 20 characters, unique within the club (not case sensitive).
async function checkPlayerName(env, clubId, raw, selfId = 0) {
  const name = clean(raw, 40);
  if (name.length < 2 || name.length > 20) return { error: 'Your player name needs 2 to 20 characters.' };
  if (/parkrun/i.test(name)) return { error: PARKRUN };
  const key = name.toLowerCase();
  if (key === 'unknown player') return { error: 'Please pick another player name.' };
  const taken = await env.DB.prepare('SELECT 1 FROM players WHERE club_id = ? AND name_key = ? AND id != ?').bind(clubId, key, selfId).first();
  if (taken) return { error: `${name} is already taken in this club. Try another name.` };
  return { name, key };
}
// Character fields. Real-life PBs only: game times never end up here.
function readCharacter(body, prev = {}) {
  const name = clean(body.name, 40);
  if (!name) return { error: 'Please give the runner a name.' };
  const pb = (k, lo, hi) => body[k] == null || body[k] === '' ? null : int(body[k], lo, hi);
  const tagline = prev.tagline && body.tagline === prev.tagline ? prev.tagline : clean(body.tagline, 30);
  const c = {
    name, nickname: clean(body.nickname, 16).toUpperCase() || name.toUpperCase().slice(0, 16),
    tagline, story: clean(body.story, 280),
    pb5k: pb('pb5k', 720, 3600), pb10k: pb('pb10k', 1500, 7200), pbhalf: pb('pbhalf', 3300, 14400), pbmar: pb('pbmar', 7200, 30000),
    color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : null,
  };
  if (/parkrun/i.test(c.name + c.nickname + c.tagline + c.story)) return { error: PARKRUN };
  for (const [k, label] of [['pb5k', '5K'], ['pb10k', '10K'], ['pbhalf', 'half marathon'], ['pbmar', 'marathon']])
    if (body[k] != null && body[k] !== '' && c[k] === null) return { error: `That ${label} time does not look right.` };
  if (!c.pb5k && !prev.legacy_id) return { error: 'Please add the 5K PB.' };
  return c;
}
// One-time codes (recovery code for a player, claim code for a character): only a hash is stored.
function oneTimeCode() { const b = crypto.getRandomValues(new Uint8Array(8)); return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join(''); }
const codeHash = (clubId, code) => sha256(clubId + ':' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''));
const showCode = c => c.slice(0, 4) + '-' + c.slice(4);
async function newRecovery(env, p) {
  const code = oneTimeCode();
  await env.DB.prepare('UPDATE players SET recovery_hash = ? WHERE id = ?').bind(await codeHash(p.club_id, code), p.id).run();
  return showCode(code);
}
async function newDevice(env, playerId) {
  const token = randomHex(24);
  await env.DB.prepare('INSERT INTO player_devices (token_hash, player_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), playerId, Date.now()).run();
  return token;
}
async function loadChar(env, id) {
  return env.DB.prepare('SELECT ch.*, c.slug, c.captain_token_hash FROM characters ch JOIN clubs c ON c.id = ch.club_id WHERE ch.id = ? AND ch.removed = 0 AND c.removed = 0').bind(id).first();
}
async function loadPlayerRow(env, id) {
  return env.DB.prepare(`${PLAYER_SQL.replace('SELECT p.*', 'SELECT p.*, c.slug, c.captain_token_hash')} JOIN clubs c ON c.id = p.club_id
    WHERE p.id = ? AND p.removed = 0 AND c.removed = 0`).bind(id).first();
}
// Who may change a character: the captain (everything) or the player linked to it (photo, story, real PBs).
async function charRights(req, env, ch) {
  const captain = await isCaptain(req, env, ch);
  const me = await devicePlayer(req, env, ch.club_id);
  const linked = !!(me && me.linked_character_id === ch.id);
  return { captain, linked, me };
}
function stripJpegMeta(buf) {
  // Removes EXIF/XMP (APP1..APP15) and comment segments, so no location or camera data is kept.
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xda) { out.push(buf.subarray(i)); break; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const n = out.reduce((a, b) => a + b.length, 0), res = new Uint8Array(n);
  let o = 0; for (const b of out) { res.set(b, o); o += b.length; }
  return res;
}
// Checks and stores an uploaded photo (already cropped and compressed in the browser). Returns the R2 key or an error Response.
async function storePhoto(req, env) {
  if (await deviceBanned(req, env)) return bad('This device is blocked.', 403);
  if (req.headers.get('x-photo-permission') !== 'yes') return bad('Please confirm you have permission to use this photo.');
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_UPLOAD) return bad('Photo is too big (max 2 MB).', 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_UPLOAD) return bad('Photo is too big (max 2 MB).', 413);
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return bad('Please upload a JPEG photo.');
  const v = await visitorHash(req, env);
  if (!await bump(env, `upload:${v}:${utcDay()}`, UPLOADS_PER_VISITOR_PER_DAY)) return bad('Too many uploads today.', 429);
  const jpg = stripJpegMeta(buf);
  if (!jpg) return bad('Please upload a JPEG photo.');
  const key = 'u/' + randomHex(16) + '.jpg';
  await env.BUCKET.put(key, jpg, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  return key;
}
const dropUpload = async (env, key) => { if (key && key.startsWith('u/')) await env.BUCKET.delete(key); };

/* ---------- admin session ---------- */
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
async function isAdmin(req, env) {
  const t = cookie(req, 'wr_admin');
  if (!t) return false;
  const row = await env.DB.prepare('SELECT expires FROM sessions WHERE token_hash = ?').bind(await sha256(t)).first();
  return !!(row && row.expires > Date.now());
}

/* ---------- route handlers ---------- */
async function handleEvent(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const type = String(b.type || '');
  if (!EVENT_TYPES.has(type)) return bad('unknown event');
  const host = new URL(req.url).hostname;
  await track(req, env, type, {
    path: clean(b.path, 120), referrer: refDomain(b.referrer, host),
    utm_source: clean(b.utm_source, 60) || null, utm_medium: clean(b.utm_medium, 60) || null, utm_campaign: clean(b.utm_campaign, 60) || null,
    club: clean(b.club, 60) || null, runner: clean(b.runner, 40) || null,
    mode: MODES.has(b.mode) ? b.mode : null, time_s: int(b.time_s, 0, 36000),
  });
  return new Response(null, { status: 204 });
}

/* ----- club ----- */
async function getClub(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then(r => r.results);
  const [chars, usage, holders, links, me] = await Promise.all([
    q(`SELECT ${PUBLIC_CHAR} FROM characters WHERE club_id = ? AND removed = 0 AND banned = 0 ORDER BY id`, club.id),
    q(`SELECT character_id, COUNT(*) AS races, MIN(time_s) AS best FROM results WHERE club_id = ? AND mode = 'classic' GROUP BY character_id`, club.id),
    // Club record per character and the player who set it (bare columns come from the MIN row in SQLite)
    q(`SELECT r.character_id, MIN(r.time_s) AS best, p.name AS by_name, p.id AS by_id FROM results r JOIN players p ON p.id = r.player_id
       WHERE r.club_id = ? AND r.mode = 'classic' AND p.removed = 0 AND p.banned = 0 GROUP BY r.character_id`, club.id),
    q(`SELECT id, name, linked_character_id FROM players WHERE club_id = ? AND linked_character_id IS NOT NULL AND removed = 0 AND banned = 0`, club.id),
    devicePlayer(req, env, club.id),
  ]);
  const U = Object.fromEntries(usage.map(u => [u.character_id, u])), H = Object.fromEntries(holders.map(h => [h.character_id, h]));
  const L = Object.fromEntries(links.map(l => [l.linked_character_id, l]));
  return json({
    club: { slug: club.slug, name: club.name, course: club.course, color: club.color, captain: club.captain_name, join_code: club.join_code },
    captain: await isCaptain(req, env, club),
    me: me ? playerOut(me) : null,
    characters: chars.map(c => ({ ...charOut(c), races: U[c.id]?.races || 0,
      record: H[c.id] ? { time_s: H[c.id].best, by: H[c.id].by_name, by_id: H[c.id].by_id } : null,
      linked: L[c.id] ? { id: L[c.id].id, name: L[c.id].name } : null })),
  });
}

async function createClub(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const name = clean(b.name, 40), course = clean(b.course, 60), captain = clean(b.captain, 20);
  if (!name || !captain) return bad('Club name and captain name are required.');
  if (captain.length < 2) return bad('Your player name needs 2 to 20 characters.');
  if (/parkrun/i.test(name + course + captain)) return bad(PARKRUN);
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#f26a1b';
  const email = clean(b.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('That email address does not look right.');
  const v = await visitorHash(req, env);
  if (!await bump(env, `club:${v}:${utcDay()}`, CLUBS_PER_VISITOR_PER_DAY)) return bad('You can create up to 3 clubs per day.', 429);
  let slug = slugify(name), n = 1;
  while (await env.DB.prepare('SELECT 1 FROM clubs WHERE slug = ?').bind(slug).first()) slug = slugify(name) + '-' + (++n);
  let code = joinCode();
  while (await env.DB.prepare('SELECT 1 FROM clubs WHERE join_code = ?').bind(code).first()) code = joinCode();
  const captainToken = randomHex(24), now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO clubs (slug, name, course, color, captain_name, captain_token_hash, captain_email, join_code, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(slug, name, course, color, captain, await sha256(captainToken), email || null, code, now, v).run();
  const clubId = r.meta.last_row_id;
  // The captain is the first player, and the first runner in the roster ("this is me").
  const st = suggestStats(null, null, null);
  const ch = await env.DB.prepare(`INSERT INTO characters (club_id, name, nickname, tagline, fast, slow, love, jump, color, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(clubId, captain, captain.toUpperCase().slice(0, 16), 'Club captain.', st.fast, st.slow, st.love, st.jump, color, now).run();
  const pr = await env.DB.prepare(`INSERT INTO players (club_id, name, name_key, linked_character_id, avatar_character_id, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(clubId, captain, captain.toLowerCase(), ch.meta.last_row_id, ch.meta.last_row_id, now).run();
  const pid = pr.meta.last_row_id;
  await track(req, env, 'club_created', { club: slug });
  return json({ slug, join_code: code, captain_token: captainToken, device_token: await newDevice(env, pid), player_id: pid,
    recovery_code: await newRecovery(env, { id: pid, club_id: clubId }) }, 201);
}

/* ----- players (people) ----- */
async function joinClub(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  if (await deviceBanned(req, env)) return bad('This device is blocked.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const n = await checkPlayerName(env, club.id, b.name);
  if (n.error) return bad(n.error);
  const v = await visitorHash(req, env);
  if (!await bump(env, `join:${v}:${utcDay()}`, JOINS_PER_VISITOR_PER_DAY)) return bad('Too many new players today. Try again tomorrow.', 429);
  const av = int(b.avatar_character_id, 1, 1e9);
  const avOk = av && await env.DB.prepare('SELECT 1 FROM characters WHERE id = ? AND club_id = ? AND removed = 0').bind(av, club.id).first();
  const r = await env.DB.prepare('INSERT INTO players (club_id, name, name_key, avatar_character_id, created_at) VALUES (?,?,?,?,?)')
    .bind(club.id, n.name, n.key, avOk ? av : null, Date.now()).run();
  const id = r.meta.last_row_id;
  await track(req, env, 'club_joined', { club: club.slug });
  const row = await env.DB.prepare(`${PLAYER_SQL} WHERE p.id = ?`).bind(id).first();
  return json({ player: playerOut(row), device_token: await newDevice(env, id), recovery_code: await newRecovery(env, { id, club_id: club.id }) }, 201);
}

const dayNum = d => Math.round(Date.parse(d + 'T00:00:00Z') / 864e5);
function streaks(days, today) {
  let best = 0, run = 0, prev = null;
  for (const d of days) { const n = dayNum(d); run = prev !== null && n === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = n; }
  return { current: prev !== null && dayNum(today) - prev <= 1 ? run : 0, best };
}
async function playerProgress(env, p) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [agg, modes, perChar, days, recent] = await Promise.all([
    q('SELECT COUNT(*) AS races, COALESCE(SUM(points), 0) AS points FROM results WHERE player_id = ?', p.id).first(),
    q('SELECT mode, MIN(time_s) AS best, COUNT(*) AS races FROM results WHERE player_id = ? GROUP BY mode', p.id).all(),
    q(`SELECT r.character_id, c.nickname AS name, r.mode, MIN(r.time_s) AS best, COUNT(*) AS races FROM results r JOIN characters c ON c.id = r.character_id
       WHERE r.player_id = ? GROUP BY r.character_id, r.mode ORDER BY races DESC, best`, p.id).all(),
    q('SELECT DISTINCT day FROM results WHERE player_id = ? ORDER BY day', p.id).all(),
    q(`SELECT r.time_s, r.mode, r.day, r.points, r.character_id, c.nickname AS character FROM results r JOIN characters c ON c.id = r.character_id
       WHERE r.player_id = ? ORDER BY r.created_at DESC LIMIT 8`, p.id).all(),
  ]);
  const s = streaks(days.results.map(d => d.day), amsDay());
  const fav = perChar.results.slice().sort((a, b) => b.races - a.races)[0] || null;
  return { races: agg.races, km: agg.races * 5, streak: s.current, best_streak: s.best,
    points: { lifetime: agg.points, balance: agg.points - (p.spent_points || 0) },
    pb: Object.fromEntries(modes.results.map(m => [m.mode, m.best])),
    per_character: perChar.results, favorite: fav ? { id: fav.character_id, name: fav.name, races: fav.races } : null,
    recent: recent.results,
    shoes: { wall: [], rotation: [null, null, null], race_day: null } };   // filled by the shoe shop step
}
async function getPlayerProfile(req, env, id) {
  const p = await loadPlayerRow(env, id);
  if (!p || p.banned) return bad('Player not found', 404);
  const me = await devicePlayer(req, env, p.club_id);
  return json({ player: playerOut(p), own: !!(me && me.id === p.id), captain: await isCaptain(req, env, p), progress: await playerProgress(env, p) });
}
async function ownPlayer(req, env, id) {
  const p = await loadPlayerRow(env, id);
  if (!p || p.banned) return { error: bad('Player not found', 404) };
  const me = await devicePlayer(req, env, p.club_id);
  if (!me || me.id !== p.id) return { error: bad('You can only change your own player profile.', 403) };
  return { p };
}
async function editPlayerProfile(req, env, id) {
  const { p, error } = await ownPlayer(req, env, id); if (error) return error;
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  let name = p.name, key = p.name_key;
  if (b.name !== undefined) { const n = await checkPlayerName(env, p.club_id, b.name, p.id); if (n.error) return bad(n.error); name = n.name; key = n.key; }
  let avChar = p.avatar_character_id, avKey = p.avatar_key;
  if (b.avatar_character_id !== undefined) {
    avChar = b.avatar_character_id === null ? null : int(b.avatar_character_id, 1, 1e9);
    if (avChar && !await env.DB.prepare('SELECT 1 FROM characters WHERE id = ? AND club_id = ? AND removed = 0').bind(avChar, p.club_id).first()) return bad('Unknown runner.');
    if (avKey) { await dropUpload(env, avKey); avKey = null; }   // picking a runner photo replaces an uploaded avatar
  }
  await env.DB.prepare('UPDATE players SET name = ?, name_key = ?, avatar_character_id = ?, avatar_key = ?, name_confirmed = 1 WHERE id = ?')
    .bind(name, key, avChar, avKey, p.id).run();
  return json({ player: playerOut(await env.DB.prepare(`${PLAYER_SQL} WHERE p.id = ?`).bind(p.id).first()) });
}
async function uploadAvatar(req, env, id) {
  const { p, error } = await ownPlayer(req, env, id); if (error) return error;
  const key = await storePhoto(req, env); if (key instanceof Response) return key;
  await dropUpload(env, p.avatar_key);
  await env.DB.prepare('UPDATE players SET avatar_key = ? WHERE id = ?').bind(key, p.id).run();
  return json({ avatar: photoUrl(key) });
}
async function removeAvatar(req, env, id) {
  const p = await loadPlayerRow(env, id);
  if (!p) return bad('Player not found', 404);
  const me = await devicePlayer(req, env, p.club_id);
  if (!(me && me.id === p.id) && !await isCaptain(req, env, p)) return bad('Not allowed.', 403);
  await dropUpload(env, p.avatar_key);
  await env.DB.prepare('UPDATE players SET avatar_key = NULL WHERE id = ?').bind(p.id).run();
  return json({ ok: true });
}
async function regenRecovery(req, env, id) {
  const p = await loadPlayerRow(env, id);
  if (!p || p.banned || p.is_unknown) return bad('Player not found', 404);
  const me = await devicePlayer(req, env, p.club_id);
  if (!(me && me.id === p.id) && !await isCaptain(req, env, p)) return bad('Only this player or the captain can do this.', 403);
  return json({ recovery_code: await newRecovery(env, p) });
}
async function recoverPlayer(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const club = await clubBySlug(env, b.club);
  if (!club) return bad('Club not found', 404);
  if (await deviceBanned(req, env)) return bad('This device is blocked.', 403);
  const v = await visitorHash(req, env);
  if (!await bump(env, `recover:${v}:${utcDay()}`, RECOVER_TRIES_PER_VISITOR_PER_DAY)) return bad('Too many tries today. Try again tomorrow.', 429);
  const p = await env.DB.prepare(`${PLAYER_SQL} WHERE p.club_id = ? AND p.recovery_hash = ? AND p.removed = 0 AND p.banned = 0`)
    .bind(club.id, await codeHash(club.id, b.code)).first();
  if (!p) return bad('That recovery code is not right for this club.', 404);
  return json({ player: playerOut(p), device_token: await newDevice(env, p.id) });
}
// "This is me": link the player on this phone to a character. The captain links directly; anyone else
// needs the claim code the captain made for that character, so nobody can take over someone else's runner.
async function linkCharacter(req, env, id) {
  const { p, error } = await ownPlayer(req, env, id); if (error) return error;
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const ch = await loadChar(env, int(b.character_id, 1, 1e9));
  if (!ch || ch.club_id !== p.club_id) return bad('Runner not found', 404);
  const holder = await env.DB.prepare('SELECT id FROM players WHERE linked_character_id = ? AND removed = 0').bind(ch.id).first();
  if (holder && holder.id !== p.id) return bad('Another player is already linked to this runner. Ask your captain.', 409);
  if (!await isCaptain(req, env, ch)) {
    const v = await visitorHash(req, env);
    if (!await bump(env, `claim:${v}:${utcDay()}`, RECOVER_TRIES_PER_VISITOR_PER_DAY)) return bad('Too many tries today. Try again tomorrow.', 429);
    if (!b.code || !ch.claim_hash || await codeHash(ch.club_id, b.code) !== ch.claim_hash) return bad('That claim code is not right. Ask your captain for the code of this runner.', 403);
  }
  await env.DB.prepare('UPDATE players SET linked_character_id = NULL WHERE linked_character_id = ? AND id != ?').bind(ch.id, p.id).run();
  await env.DB.prepare('UPDATE players SET linked_character_id = ? WHERE id = ?').bind(ch.id, p.id).run();
  await env.DB.prepare('UPDATE characters SET claim_hash = NULL WHERE id = ?').bind(ch.id).run();
  return json({ ok: true });
}
async function unlinkCharacter(req, env, id) {
  const { p, error } = await ownPlayer(req, env, id); if (error) return error;
  await env.DB.prepare('UPDATE players SET linked_character_id = NULL WHERE id = ?').bind(p.id).run();
  return json({ ok: true });
}

/* ----- characters (roster) ----- */
async function getCharacter(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch || ch.banned) return bad('Runner not found', 404);
  const { captain, linked, me } = await charRights(req, env, ch);
  const [use, rec, link] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS races, COUNT(DISTINCT player_id) AS players FROM results WHERE character_id = ? AND mode = 'classic'`).bind(ch.id).first(),
    env.DB.prepare(`SELECT r.time_s, p.name, p.id FROM results r JOIN players p ON p.id = r.player_id WHERE r.character_id = ? AND r.mode = 'classic' AND p.removed = 0 AND p.banned = 0 ORDER BY r.time_s LIMIT 1`).bind(ch.id).first(),
    env.DB.prepare('SELECT id, name FROM players WHERE linked_character_id = ? AND removed = 0 AND banned = 0').bind(ch.id).first(),
  ]);
  const mine = me ? await env.DB.prepare(`SELECT MIN(time_s) AS best, COUNT(*) AS races FROM results WHERE character_id = ? AND player_id = ? AND mode = 'classic'`).bind(ch.id, me.id).first() : null;
  return json({ character: charOut(ch), captain, linked_to_me: linked, can_edit: captain || linked, can_edit_stats: captain && !ch.legacy_id,
    usage: { races: use.races, players: use.players, record: rec ? { time_s: rec.time_s, by: rec.name, by_id: rec.id } : null,
      my_best: mine && mine.best || null, my_races: mine ? mine.races : 0 },
    linked: link || null, has_claim_code: !!ch.claim_hash, me_linked_id: me ? me.linked_character_id : null });
}
async function createCharacter(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const captain = await isCaptain(req, env, club), me = await devicePlayer(req, env, club.id);
  if (!captain && !me) return bad('Join the club first.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  // A player can add themselves once ("add me as a runner"); the captain can add anyone.
  const forMe = !captain || b.this_is_me;
  if (forMe && (!me || me.linked_character_id)) return bad(me ? 'You are already linked to a runner.' : 'Join the club first.', 409);
  const c = readCharacter(b); if (c.error) return bad(c.error);
  const v = await visitorHash(req, env);
  if (!await bump(env, `join:${v}:${utcDay()}`, JOINS_PER_VISITOR_PER_DAY)) return bad('Too many new runners today. Try again tomorrow.', 429);
  let st = suggestStats(c.pb5k, c.pb10k, c.pbmar), locked = 0;
  if (captain && b.stats) { const s = validStats(b.stats); if (!s) return bad('Stats must be 1 to 5 each, FAST + SLOW = 6 and 14 points in total.'); st = s; locked = 1; }
  const r = await env.DB.prepare(`INSERT INTO characters (club_id, name, nickname, tagline, pb5k, pb10k, pbhalf, pbmar, story, fast, slow, love, jump, stats_locked, color, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(club.id, c.name, c.nickname, c.tagline, c.pb5k, c.pb10k, c.pbhalf, c.pbmar, c.story,
    st.fast, st.slow, st.love, st.jump, locked, c.color || club.color, Date.now()).run();
  const id = r.meta.last_row_id;
  if (forMe) await env.DB.prepare('UPDATE players SET linked_character_id = ?, avatar_character_id = COALESCE(avatar_character_id, ?) WHERE id = ?').bind(id, id, me.id).run();
  return json({ character: charOut(await env.DB.prepare(`SELECT ${PUBLIC_CHAR} FROM characters WHERE id = ?`).bind(id).first()) }, 201);
}
async function editCharacter(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch || ch.banned) return bad('Runner not found', 404);
  const { captain, linked } = await charRights(req, env, ch);
  if (!captain && !linked) return bad('Only the captain or the player linked to this runner can edit it.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  // The linked player may change the tagline, story and real PBs; name, colour and game stats are for the captain.
  const base = charOut(ch);
  const input = captain ? { ...base, ...b } : { ...base, tagline: b.tagline ?? base.tagline, story: b.story ?? base.story,
    pb5k: b.pb5k !== undefined ? b.pb5k : base.pb5k, pb10k: b.pb10k !== undefined ? b.pb10k : base.pb10k,
    pbhalf: b.pbhalf !== undefined ? b.pbhalf : base.pbhalf, pbmar: b.pbmar !== undefined ? b.pbmar : base.pbmar };
  if (!captain && (b.stats || b.stats_reset)) return bad('Only the captain can change game stats.', 403);
  const c = readCharacter(input, ch); if (c.error) return bad(c.error);
  let st = { fast: ch.fast, slow: ch.slow, love: ch.love, jump: ch.jump }, locked = ch.stats_locked;
  if (!ch.legacy_id) {   // the original Wolfpack runners keep their hand-tuned stats
    if (captain && b.stats) { const s = validStats(b.stats); if (!s) return bad('Stats must be 1 to 5 each, FAST + SLOW = 6 and 14 points in total.'); st = s; locked = 1; }
    else if (captain && b.stats_reset) locked = 0;
    if (!locked) st = suggestStats(c.pb5k, c.pb10k, c.pbmar);
  }
  await env.DB.prepare(`UPDATE characters SET name=?, nickname=?, tagline=?, pb5k=?, pb10k=?, pbhalf=?, pbmar=?, story=?, color=?,
      fast=?, slow=?, love=?, jump=?, stats_locked=? WHERE id=?`).bind(c.name, c.nickname, c.tagline, c.pb5k, c.pb10k, c.pbhalf, c.pbmar, c.story,
      c.color || ch.color, st.fast, st.slow, st.love, st.jump, locked, ch.id).run();
  return json({ character: charOut(await env.DB.prepare(`SELECT ${PUBLIC_CHAR} FROM characters WHERE id = ?`).bind(ch.id).first()) });
}
async function deleteCharacter(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch) return bad('Runner not found', 404);
  if (!await isCaptain(req, env, ch)) return bad('Only the captain can remove a runner.', 403);
  if (ch.legacy_id) return bad('The original Wolfpack runners can only be hidden by the site admin.', 403);
  await dropUpload(env, ch.photo_key);
  await env.DB.prepare('UPDATE characters SET removed = 1, photo_key = NULL, story = NULL WHERE id = ?').bind(ch.id).run();
  await env.DB.prepare('UPDATE players SET linked_character_id = NULL WHERE linked_character_id = ?').bind(ch.id).run();
  return json({ ok: true });
}
async function uploadCharPhoto(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch || ch.banned) return bad('Runner not found', 404);
  const { captain, linked } = await charRights(req, env, ch);
  if (!captain && !linked) return bad('Not allowed.', 403);
  const key = await storePhoto(req, env); if (key instanceof Response) return key;
  await dropUpload(env, ch.photo_key);
  await env.DB.prepare('UPDATE characters SET photo_key = ? WHERE id = ?').bind(key, ch.id).run();
  return json({ photo: photoUrl(key) });
}
async function removeCharContent(req, env, id, kind) {
  const ch = await loadChar(env, id);
  if (!ch) return bad('Runner not found', 404);
  const { captain, linked } = await charRights(req, env, ch);
  if (!captain && !linked) return bad('Not allowed.', 403);
  if (kind === 'photo') {
    await dropUpload(env, ch.photo_key);
    // built-in runners go back to their hand-made poster
    await env.DB.prepare('UPDATE characters SET photo_key = ? WHERE id = ?').bind(ch.legacy_id && ch.photo_key && ch.photo_key.startsWith('u/') ? `static:img/${ch.legacy_id}.jpg` : null, ch.id).run();
  } else await env.DB.prepare('UPDATE characters SET story = NULL WHERE id = ?').bind(ch.id).run();
  return json({ ok: true });
}
async function claimCode(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch) return bad('Runner not found', 404);
  if (!await isCaptain(req, env, ch)) return bad('Only the captain can make a claim code.', 403);
  const code = oneTimeCode();
  await env.DB.prepare('UPDATE characters SET claim_hash = ? WHERE id = ?').bind(await codeHash(ch.club_id, code), ch.id).run();
  return json({ claim_code: showCode(code) });
}
async function captainUnlink(req, env, id) {
  const ch = await loadChar(env, id);
  if (!ch) return bad('Runner not found', 404);
  if (!await isCaptain(req, env, ch)) return bad('Only the captain can do this.', 403);
  await env.DB.prepare('UPDATE players SET linked_character_id = NULL WHERE linked_character_id = ?').bind(ch.id).run();
  return json({ ok: true });
}

/* ----- reports ----- */
async function report(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const kind = ['photo', 'story', 'avatar'].includes(b.kind) ? b.kind : null;
  if (!kind) return bad('Nothing to report.');
  let clubId, charId = null, playerId = null;
  if (kind === 'avatar') { const p = await loadPlayerRow(env, int(b.player_id, 1, 1e9)); if (!p || !p.avatar_key) return bad('Nothing to report.'); clubId = p.club_id; playerId = p.id; }
  else { const ch = await loadChar(env, int(b.character_id ?? b.player_id, 1, 1e9)); if (!ch) return bad('Nothing to report.'); clubId = ch.club_id; charId = ch.id; }
  const v = await visitorHash(req, env);
  if (!await bump(env, `report:${v}:${utcDay()}`, REPORTS_PER_VISITOR_PER_DAY)) return bad('Too many reports today.', 429);
  await env.DB.prepare('INSERT INTO reports (kind, character_id, player_id, club_id, reason, created_at, visitor) VALUES (?,?,?,?,?,?,?)')
    .bind(kind, charId, playerId, clubId, clean(b.reason, 200), Date.now(), v).run();
  return json({ ok: true }, 201);
}
const REPORT_SQL = `SELECT r.id, r.kind, r.reason, r.created_at, r.status, r.club_id, r.character_id, r.player_id,
    COALESCE(ch.name, pl.name) AS name, CASE WHEN r.kind = 'avatar' THEN pl.avatar_key ELSE ch.photo_key END AS photo_key,
    ch.story, COALESCE(ch.banned, pl.banned) AS banned, c.name AS club
  FROM reports r JOIN clubs c ON c.id = r.club_id LEFT JOIN characters ch ON ch.id = r.character_id LEFT JOIN players pl ON pl.id = r.player_id`;
const reportOut = r => ({ ...r, photo: photoUrl(r.photo_key), photo_key: undefined });
async function captainReports(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  if (!await isCaptain(req, env, club)) return bad('Only the captain can see reports.', 403);
  const { results } = await env.DB.prepare(`${REPORT_SQL} WHERE r.club_id = ? AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 50`).bind(club.id).all();
  return json({ reports: results.map(reportOut) });
}
async function captainAct(req, env, slug, id) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  if (!await isCaptain(req, env, club)) return bad('Only the captain can do this.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  if (b.action !== 'remove' && b.action !== 'dismiss') return bad('Unknown action');
  const r = await env.DB.prepare('SELECT * FROM reports WHERE id = ? AND club_id = ?').bind(id, club.id).first();
  if (!r) return bad('Report not found', 404);
  return resolveReport(env, r, b.action);
}
async function resolveReport(env, r, action) {
  if (!['remove', 'ban', 'dismiss'].includes(action)) return bad('Unknown action');
  if (action !== 'dismiss') {
    if (r.kind === 'avatar') {
      const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(r.player_id).first();
      if (p) {
        await dropUpload(env, p.avatar_key);
        await env.DB.prepare('UPDATE players SET avatar_key = NULL WHERE id = ?').bind(p.id).run();
        if (action === 'ban') {
          await env.DB.prepare('UPDATE players SET banned = 1 WHERE id = ?').bind(p.id).run();
          await env.DB.prepare('INSERT OR IGNORE INTO banned_devices (token_hash, created_at) SELECT token_hash, ? FROM player_devices WHERE player_id = ?').bind(Date.now(), p.id).run();
        }
      }
    } else {
      const ch = await env.DB.prepare('SELECT * FROM characters WHERE id = ?').bind(r.character_id).first();
      if (ch) {
        if (r.kind === 'photo' || action === 'ban') { await dropUpload(env, ch.photo_key); await env.DB.prepare('UPDATE characters SET photo_key = NULL WHERE id = ?').bind(ch.id).run(); }
        if (r.kind === 'story' || action === 'ban') await env.DB.prepare('UPDATE characters SET story = NULL WHERE id = ?').bind(ch.id).run();
        if (action === 'ban') await env.DB.prepare('UPDATE characters SET banned = 1 WHERE id = ?').bind(ch.id).run();
      }
    }
  }
  const status = action === 'dismiss' ? 'dismissed' : 'done';
  await env.DB.prepare(`UPDATE reports SET status = ? WHERE status = 'open' AND kind = ? AND COALESCE(character_id, 0) = COALESCE(?, 0) AND COALESCE(player_id, 0) = COALESCE(?, 0)`)
    .bind(status, r.kind, r.character_id, r.player_id).run();
  return json({ ok: true });
}

/* ----- results + leaderboards ----- */
async function submitResult(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const club = await clubBySlug(env, b.club);
  if (!club) return bad('Club not found', 404);
  const me = await devicePlayer(req, env, club.id);
  if (!me) return bad('Pick a player name first.', 401);
  const mode = MODES.has(b.mode) ? b.mode : null;
  const time = int(b.time_s, 1, 36000), taps = int(b.taps, 0, 100000), cad = int(b.max_cad, 0, 1000);
  const ch = await env.DB.prepare('SELECT id FROM characters WHERE id = ? AND club_id = ? AND removed = 0 AND banned = 0').bind(int(b.character_id, 1, 1e9), club.id).first();
  if (!mode || time === null || taps === null || cad === null || !ch) return bad('Invalid result.');
  // Plausibility: the game cannot go faster than about 11:00, taps are capped at ~22 per second.
  const realSeconds = time / TS;
  if (time < 660 || time > 3600) return bad('That time is not possible in this game.', 422);
  if (taps < 30 || taps / realSeconds > 23 || cad > 25) return bad('That tap rate is not possible.', 422);
  const v = await visitorHash(req, env);
  if (!await bump(env, `result:${v}:${utcDay()}`, RESULTS_PER_VISITOR_PER_DAY)) return bad('Too many results today.', 429);
  const day = amsDay();
  const yday = new Date(Date.parse(day + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  const [pb, charPb, rec, raced] = await Promise.all([
    env.DB.prepare('SELECT MIN(time_s) AS best FROM results WHERE player_id = ? AND mode = ?').bind(me.id, mode).first(),
    env.DB.prepare('SELECT MIN(time_s) AS best FROM results WHERE player_id = ? AND character_id = ? AND mode = ?').bind(me.id, ch.id, mode).first(),
    env.DB.prepare('SELECT MIN(time_s) AS best FROM results WHERE character_id = ? AND mode = ?').bind(ch.id, mode).first(),
    env.DB.prepare('SELECT 1 FROM results WHERE player_id = ? AND day = ? LIMIT 1').bind(me.id, yday).first(),
  ]);
  const playerPb = !pb?.best || time < pb.best;
  const points = POINTS.race + (playerPb ? POINTS.pb : 0) + (raced ? POINTS.streak : 0);
  await env.DB.prepare('INSERT INTO results (club_id, character_id, player_id, mode, time_s, taps, max_cad, day, created_at, visitor, points) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(club.id, ch.id, me.id, mode, time, taps, cad, day, Date.now(), v, points).run();
  return json({ ok: true, day, points, player: me.name,
    player_pb: playerPb, prev_player_pb: pb?.best || null,
    character_pb: !charPb?.best || time < charPb.best, prev_character_pb: charPb?.best || null,
    character_record: !rec?.best || time < rec.best, prev_character_record: rec?.best || null }, 201);
}
async function leaderboard(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const u = new URL(req.url);
  const mode = MODES.has(u.searchParams.get('mode')) ? u.searchParams.get('mode') : 'classic';
  const group = u.searchParams.get('group') === 'character' ? 'character' : 'player';
  const out = {};
  for (const period of ['today', 'all']) {
    // Best time per player (with the runner they used), or best time per runner (with the player who ran it).
    const stmt = env.DB.prepare(`SELECT r.player_id, p.name AS player_name, p.is_unknown AS unknown, r.character_id, c.nickname AS character_name,
        c.legacy_id, MIN(r.time_s) AS time_s
      FROM results r JOIN players p ON p.id = r.player_id JOIN characters c ON c.id = r.character_id
      WHERE r.club_id = ? AND r.mode = ? AND p.removed = 0 AND p.banned = 0 AND c.removed = 0 AND c.banned = 0 ${period === 'today' ? 'AND r.day = ?' : ''}
      GROUP BY ${group === 'player' ? 'r.player_id' : 'r.character_id'} ORDER BY time_s LIMIT 10`);
    out[period] = (await (period === 'today' ? stmt.bind(club.id, mode, amsDay()) : stmt.bind(club.id, mode)).all()).results;
  }
  return json({ mode, group, day: amsDay(), ...out });
}

/* ---------- admin ---------- */
async function adminLogin(req, env) {
  const v = await visitorHash(req, env), now = Date.now();
  await env.DB.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(now - 86400000).run();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE visitor = ? AND ts > ?').bind(v, now - 15 * 60000).first();
  if (n >= 5) return bad('Too many attempts. Wait 15 minutes and try again.', 429);
  await env.DB.prepare('INSERT INTO login_attempts (visitor, ts) VALUES (?, ?)').bind(v, now).run();
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  if (!env.ADMIN_PASSWORD_HASH) return bad('Admin password is not set up yet.', 503);
  if (!await verifyPassword(b.password, env.ADMIN_PASSWORD_HASH)) return bad('Wrong password.', 401);
  const token = randomHex(32);
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, expires) VALUES (?, ?)').bind(await sha256(token), now + SESSION_HOURS * 3600000).run();
  await env.DB.prepare('DELETE FROM login_attempts WHERE visitor = ?').bind(v).run();
  return json({ ok: true }, 200, { 'set-cookie': `wr_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
}
async function adminLogout(req, env) {
  const t = cookie(req, 'wr_admin');
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(t)).run();
  return json({ ok: true }, 200, { 'set-cookie': 'wr_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
}
async function adminStats(req, env) {
  const u = new URL(req.url), today = utcDay();
  const dayOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const to = dayOk(u.searchParams.get('to')) ? u.searchParams.get('to') : today;
  const from = dayOk(u.searchParams.get('from')) ? u.searchParams.get('from') : utcDay(new Date(Date.now() - 29 * 86400000));
  const back = n => utcDay(new Date(Date.now() - (n - 1) * 86400000));
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then(r => r.results);
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const summary = {};
  for (const [k, n] of [['today', 1], ['d7', 7], ['d30', 30]]) {
    summary[k] = await one(`SELECT COUNT(DISTINCT day || visitor) AS visitors, SUM(type = 'page_view') AS views FROM events WHERE day >= ?`, back(n));
  }
  const R = [from, to];
  return json({
    from, to, summary,
    daily: await q(`SELECT day, COUNT(DISTINCT visitor) AS visitors, SUM(type='page_view') AS views, SUM(type='race_start') AS starts, SUM(type='race_finish') AS finishes
                    FROM events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`, ...R),
    countries: await q(`SELECT country, COUNT(DISTINCT day || visitor) AS visitors FROM events WHERE day BETWEEN ? AND ? AND country IS NOT NULL GROUP BY country ORDER BY visitors DESC LIMIT 20`, ...R),
    cities: await q(`SELECT city, country, COUNT(DISTINCT day || visitor) AS visitors FROM events WHERE day BETWEEN ? AND ? AND city IS NOT NULL GROUP BY city, country ORDER BY visitors DESC LIMIT 20`, ...R),
    referrers: await q(`SELECT referrer, COUNT(*) AS views FROM events WHERE day BETWEEN ? AND ? AND type='page_view' AND referrer IS NOT NULL GROUP BY referrer ORDER BY views DESC LIMIT 20`, ...R),
    campaigns: await q(`SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS views FROM events WHERE day BETWEEN ? AND ? AND type='page_view' AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL)
                        GROUP BY utm_source, utm_medium, utm_campaign ORDER BY views DESC LIMIT 20`, ...R),
    devices: await q(`SELECT device, COUNT(DISTINCT day || visitor) AS visitors FROM events WHERE day BETWEEN ? AND ? GROUP BY device`, ...R),
    races: await one(`SELECT SUM(type='race_start') AS starts, SUM(type='race_finish') AS finishes, SUM(type='result_shared') AS shared,
                       SUM(type='club_created') AS clubs_created, SUM(type='club_joined') AS joins,
                       COUNT(DISTINCT CASE WHEN type='race_start' THEN day || visitor END) AS racers FROM events WHERE day BETWEEN ? AND ?`, ...R),
    runners: await q(`SELECT COALESCE(ch.nickname || ' (' || c.name || ')', e.runner) AS runner, COUNT(*) AS races FROM events e
                      LEFT JOIN characters ch ON (e.runner = 'p' || ch.id OR e.runner = ch.legacy_id) LEFT JOIN clubs c ON c.id = ch.club_id AND c.slug = e.club
                      WHERE e.day BETWEEN ? AND ? AND e.type='race_start' AND e.runner IS NOT NULL AND (ch.id IS NULL OR c.id IS NOT NULL)
                      GROUP BY e.runner, e.club ORDER BY races DESC LIMIT 15`, ...R),
    clubs: await q(`SELECT c.slug, c.name, c.join_code, c.captain_name, c.captain_email,
                      (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.removed = 0 AND p.banned = 0 AND p.is_unknown = 0) AS players,
                      (SELECT COUNT(*) FROM characters ch WHERE ch.club_id = c.id AND ch.removed = 0 AND ch.banned = 0) AS runners,
                      (SELECT COUNT(*) FROM events e WHERE e.club = c.slug AND e.type = 'race_finish' AND e.day BETWEEN ? AND ?) AS races
                    FROM clubs c WHERE c.removed = 0 ORDER BY races DESC, players DESC LIMIT 50`, ...R),
  });
}
async function adminReports(req, env) {
  const { results } = await env.DB.prepare(`${REPORT_SQL} WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 100`).all();
  return json({ reports: results.map(reportOut) });
}
async function adminAct(req, env, id) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const r = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
  if (!r) return bad('Report not found', 404);
  return resolveReport(env, r, b.action);
}
async function adminCaptainLink(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const token = randomHex(24);
  await env.DB.prepare('UPDATE clubs SET captain_token_hash = ? WHERE id = ?').bind(await sha256(token), club.id).run();
  return json({ link: `/c/${club.slug}#captain=${token}` });
}

/* ---------- static ---------- */
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
async function serveStatic(req, env, path) {
  const page = path === '/' || path.startsWith('/c/') ? '/index.html' : path === '/admin' ? '/admin.html' : path === '/privacy' ? '/privacy.html' : path;
  if (typeof PAGES !== 'undefined' && PAGES[page]) {
    const extra = page === '/admin.html' ? { 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex' } : {};
    return new Response(PAGES[page].body, { headers: { 'content-type': PAGES[page].type, 'cache-control': 'no-cache', ...SEC_HEADERS, ...extra } });
  }
  if (env.ASSETS) {
    const a = await env.ASSETS.fetch(new Request(new URL(page, req.url), req));
    if (a.status !== 404) return a;
  }
  if (env.BUCKET && /^\/(img|icons)\//.test(path)) {
    const obj = await env.BUCKET.get('static' + path);
    if (obj) return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'public, max-age=3600', ...SEC_HEADERS } });
  }
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname, m = req.method;
    try {
      if (path.startsWith('/img/u/')) {
        const name = path.slice(7);
        if (!/^[a-f0-9]{32}\.jpg$/.test(name)) return new Response('Not found', { status: 404 });
        const obj = await env.BUCKET.get('u/' + name);
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', ...SEC_HEADERS } });
      }
      if (!path.startsWith('/api/')) return serveStatic(req, env, path);
      if (m === 'POST' && path === '/api/e') return handleEvent(req, env);
      if (m === 'POST' && path === '/api/clubs') return createClub(req, env);
      if (m === 'POST' && path === '/api/results') return submitResult(req, env);
      if (m === 'POST' && path === '/api/report') return report(req, env);
      if (m === 'POST' && path === '/api/recover') return recoverPlayer(req, env);
      let r;
      if ((r = path.match(/^\/api\/join\/([A-Za-z0-9]{6})$/)) && m === 'GET') {
        const c = await env.DB.prepare('SELECT slug FROM clubs WHERE join_code = ? AND removed = 0').bind(r[1].toUpperCase()).first();
        return c ? json({ slug: c.slug }) : bad('No club with that code.', 404);
      }
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)$/)) && m === 'GET') return getClub(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/players$/)) && m === 'POST') return joinClub(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/characters$/)) && m === 'POST') return createCharacter(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/leaderboard$/)) && m === 'GET') return leaderboard(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/reports$/)) && m === 'GET') return captainReports(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/reports\/(\d+)$/)) && m === 'POST') return captainAct(req, env, r[1], +r[2]);
      if ((r = path.match(/^\/api\/players\/(\d+)$/))) {
        if (m === 'GET') return getPlayerProfile(req, env, +r[1]);
        if (m === 'PATCH') return editPlayerProfile(req, env, +r[1]);
      }
      if ((r = path.match(/^\/api\/players\/(\d+)\/avatar$/))) {
        if (m === 'PUT') return uploadAvatar(req, env, +r[1]);
        if (m === 'DELETE') return removeAvatar(req, env, +r[1]);
      }
      if ((r = path.match(/^\/api\/players\/(\d+)\/recovery$/)) && m === 'POST') return regenRecovery(req, env, +r[1]);
      if ((r = path.match(/^\/api\/players\/(\d+)\/link$/))) {
        if (m === 'POST') return linkCharacter(req, env, +r[1]);
        if (m === 'DELETE') return unlinkCharacter(req, env, +r[1]);
      }
      if ((r = path.match(/^\/api\/characters\/(\d+)$/))) {
        if (m === 'GET') return getCharacter(req, env, +r[1]);
        if (m === 'PATCH') return editCharacter(req, env, +r[1]);
        if (m === 'DELETE') return deleteCharacter(req, env, +r[1]);
      }
      if ((r = path.match(/^\/api\/characters\/(\d+)\/photo$/))) {
        if (m === 'PUT') return uploadCharPhoto(req, env, +r[1]);
        if (m === 'DELETE') return removeCharContent(req, env, +r[1], 'photo');
      }
      if ((r = path.match(/^\/api\/characters\/(\d+)\/story$/)) && m === 'DELETE') return removeCharContent(req, env, +r[1], 'story');
      if ((r = path.match(/^\/api\/characters\/(\d+)\/claim-code$/)) && m === 'POST') return claimCode(req, env, +r[1]);
      if ((r = path.match(/^\/api\/characters\/(\d+)\/link$/)) && m === 'DELETE') return captainUnlink(req, env, +r[1]);
      if (path === '/api/admin/login' && m === 'POST') return adminLogin(req, env);
      if (path.startsWith('/api/admin/')) {
        if (!await isAdmin(req, env)) return bad('Please log in.', 401);
        if (path === '/api/admin/logout' && m === 'POST') return adminLogout(req, env);
        if (path === '/api/admin/stats' && m === 'GET') return adminStats(req, env);
        if (path === '/api/admin/reports' && m === 'GET') return adminReports(req, env);
        if ((r = path.match(/^\/api\/admin\/reports\/(\d+)$/)) && m === 'POST') return adminAct(req, env, +r[1]);
        if ((r = path.match(/^\/api\/admin\/clubs\/([a-z0-9-]+)\/captain-link$/)) && m === 'POST') return adminCaptainLink(req, env, r[1]);
      }
      return bad('Not found', 404);
    } catch (e) {
      // Log only the message: never the request, headers or IP.
      console.error('api error', path, e && e.message);
      return bad('Server error', 500);
    }
  },
};
