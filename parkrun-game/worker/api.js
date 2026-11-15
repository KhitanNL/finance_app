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

/* ---------- clubs + players ---------- */
const PUBLIC_PLAYER = 'id, legacy_id, name, nickname, tagline, pb5k, pb10k, pbmar, photo_key, story, fast, slow, love, jump, color';
function playerOut(p) {
  const photo = !p.photo_key ? null : p.photo_key.startsWith('static:') ? '/' + p.photo_key.slice(7) : '/img/u/' + p.photo_key.slice(2);
  return { id: p.id, legacy_id: p.legacy_id, name: p.name, nickname: p.nickname, tagline: p.tagline,
    pb5k: p.pb5k, pb10k: p.pb10k, pbmar: p.pbmar, photo, story: p.story,
    stats: { fast: p.fast, slow: p.slow, love: p.love, jump: p.jump }, color: p.color };
}
async function clubBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM clubs WHERE slug = ? AND removed = 0').bind(clean(slug, 60)).first();
}
async function isCaptain(req, env, club) {
  const t = req.headers.get('x-captain-token');
  return !!(t && club.captain_token_hash && await sha256(t) === club.captain_token_hash);
}
async function ownsPlayer(req, env, p) {
  const t = req.headers.get('x-device-token');
  return !!(t && p.device_token_hash && await sha256(t) === p.device_token_hash);
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
function readProfile(body) {
  const name = clean(body.name, 40);
  if (!name) return { error: 'Please give a name.' };
  const pb = k => body[k] == null || body[k] === '' ? null : int(body[k], 600, 30000);
  const p = {
    name, nickname: clean(body.nickname, 16).toUpperCase() || name.toUpperCase().slice(0, 16),
    tagline: clean(body.tagline, 60), story: clean(body.story, 280),
    pb5k: pb('pb5k'), pb10k: pb('pb10k'), pbmar: pb('pbmar'),
    color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : null,
  };
  if (/parkrun/i.test(p.name + p.nickname + p.tagline + p.story)) return { error: 'Please leave out the word parkrun (it is a trademark).' };
  return p;
}

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

async function getClub(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const { results } = await env.DB.prepare(`SELECT ${PUBLIC_PLAYER} FROM players WHERE club_id = ? AND removed = 0 AND banned = 0 ORDER BY id`).bind(club.id).all();
  // Shared club records: best Classic time per runner, from everyone in the club.
  const bests = await env.DB.prepare(`SELECT player_id, MIN(time_s) AS best FROM results WHERE club_id = ? AND mode = 'classic' GROUP BY player_id`).bind(club.id).all();
  const best = Object.fromEntries(bests.results.map(b => [b.player_id, b.best]));
  return json({ club: { slug: club.slug, name: club.name, course: club.course, color: club.color, captain: club.captain_name, join_code: club.join_code },
    captain: await isCaptain(req, env, club), players: results.map(p => ({ ...playerOut(p), best: best[p.id] || null })) });
}

async function createClub(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const name = clean(b.name, 40), course = clean(b.course, 60), captain = clean(b.captain, 40);
  if (!name || !captain) return bad('Club name and captain name are required.');
  if (/parkrun/i.test(name + course)) return bad('Please leave out the word parkrun (it is a trademark).');
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#f26a1b';
  const email = clean(b.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('That email address does not look right.');
  const v = await visitorHash(req, env);
  if (!await bump(env, `club:${v}:${utcDay()}`, CLUBS_PER_VISITOR_PER_DAY)) return bad('You can create up to 3 clubs per day.', 429);
  let slug = slugify(name), n = 1;
  while (await env.DB.prepare('SELECT 1 FROM clubs WHERE slug = ?').bind(slug).first()) slug = slugify(name) + '-' + (++n);
  let code = joinCode();
  while (await env.DB.prepare('SELECT 1 FROM clubs WHERE join_code = ?').bind(code).first()) code = joinCode();
  const captainToken = randomHex(24), deviceToken = randomHex(24);
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO clubs (slug, name, course, color, captain_name, captain_token_hash, captain_email, join_code, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(slug, name, course, color, captain, await sha256(captainToken), email || null, code, now, v).run();
  const clubId = r.meta.last_row_id;
  const st = suggestStats(null, null, null);
  const pr = await env.DB.prepare(`INSERT INTO players (club_id, name, nickname, tagline, fast, slow, love, jump, color, device_token_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(clubId, captain, captain.toUpperCase().slice(0, 16), 'Club captain.', st.fast, st.slow, st.love, st.jump, color, await sha256(deviceToken), now).run();
  await track(req, env, 'club_created', { club: slug });
  return json({ slug, join_code: code, captain_token: captainToken, device_token: deviceToken, player_id: pr.meta.last_row_id }, 201);
}

async function joinClub(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  if (await deviceBanned(req, env)) return bad('This device is blocked.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const p = readProfile(b);
  if (p.error) return bad(p.error);
  const v = await visitorHash(req, env);
  if (!await bump(env, `join:${v}:${utcDay()}`, JOINS_PER_VISITOR_PER_DAY)) return bad('Too many profiles today. Try again tomorrow.', 429);
  const st = suggestStats(p.pb5k, p.pb10k, p.pbmar), deviceToken = randomHex(24);
  const r = await env.DB.prepare(`INSERT INTO players (club_id, name, nickname, tagline, pb5k, pb10k, pbmar, story, fast, slow, love, jump, color, device_token_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(club.id, p.name, p.nickname, p.tagline, p.pb5k, p.pb10k, p.pbmar, p.story,
    st.fast, st.slow, st.love, st.jump, p.color || club.color, await sha256(deviceToken), Date.now()).run();
  await track(req, env, 'club_joined', { club: club.slug });
  const row = await env.DB.prepare(`SELECT ${PUBLIC_PLAYER} FROM players WHERE id = ?`).bind(r.meta.last_row_id).first();
  return json({ player: playerOut(row), device_token: deviceToken }, 201);
}

async function loadPlayer(env, id) {
  return env.DB.prepare('SELECT p.*, c.slug, c.captain_token_hash FROM players p JOIN clubs c ON c.id = p.club_id WHERE p.id = ? AND p.removed = 0 AND c.removed = 0').bind(id).first();
}

async function editPlayer(req, env, id) {
  const p = await loadPlayer(env, id);
  if (!p || p.banned) return bad('Player not found', 404);
  const captain = await isCaptain(req, env, p), owner = await ownsPlayer(req, env, p);
  if (!captain && !owner) return bad('Only this player or the captain can edit this profile.', 403);
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const q = readProfile({ ...playerOut(p), ...b });
  if (q.error) return bad(q.error);
  let st = { fast: p.fast, slow: p.slow, love: p.love, jump: p.jump }, locked = p.stats_locked;
  if (captain && b.stats) {
    const s = validStats(b.stats);
    if (!s) return bad('Stats must be 1 to 5 each, FAST + SLOW = 6 and 14 points in total.');
    st = s; locked = 1;
  } else if (!locked) st = suggestStats(q.pb5k, q.pb10k, q.pbmar);
  await env.DB.prepare(`UPDATE players SET name=?, nickname=?, tagline=?, pb5k=?, pb10k=?, pbmar=?, story=?, color=?,
      fast=?, slow=?, love=?, jump=?, stats_locked=? WHERE id=?`).bind(q.name, q.nickname, q.tagline, q.pb5k, q.pb10k, q.pbmar, q.story,
      q.color || p.color, st.fast, st.slow, st.love, st.jump, locked, p.id).run();
  const row = await env.DB.prepare(`SELECT ${PUBLIC_PLAYER} FROM players WHERE id = ?`).bind(p.id).first();
  return json({ player: playerOut(row) });
}

async function deletePlayer(req, env, id) {
  const p = await loadPlayer(env, id);
  if (!p) return bad('Player not found', 404);
  if (!await isCaptain(req, env, p) && !await ownsPlayer(req, env, p)) return bad('Not allowed.', 403);
  if (p.legacy_id) return bad('The original Wolfpack runners can only be hidden by the site admin.', 403);
  if (p.photo_key && p.photo_key.startsWith('u/')) await env.BUCKET.delete(p.photo_key);
  await env.DB.prepare('UPDATE players SET removed = 1, photo_key = NULL, story = NULL WHERE id = ?').bind(p.id).run();
  return json({ ok: true });
}

async function uploadPhoto(req, env, id) {
  const p = await loadPlayer(env, id);
  if (!p || p.banned) return bad('Player not found', 404);
  if (!await isCaptain(req, env, p) && !await ownsPlayer(req, env, p)) return bad('Not allowed.', 403);
  if (await deviceBanned(req, env)) return bad('This device is blocked.', 403);
  if (req.headers.get('x-photo-permission') !== 'yes') return bad('Please confirm you have permission to use this photo.');
  const len = +req.headers.get('content-length') || 0;
  if (len > MAX_UPLOAD) return bad('Photo is too big (max 2 MB).', 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_UPLOAD) return bad('Photo is too big (max 2 MB).', 413);
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return bad('Please upload a JPEG photo.');
  const v = await visitorHash(req, env);
  if (!await bump(env, `upload:${v}:${utcDay()}`, UPLOADS_PER_VISITOR_PER_DAY)) return bad('Too many uploads today.', 429);
  const key = 'u/' + randomHex(16) + '.jpg';
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  if (p.photo_key && p.photo_key.startsWith('u/')) await env.BUCKET.delete(p.photo_key);
  await env.DB.prepare('UPDATE players SET photo_key = ? WHERE id = ?').bind(key, p.id).run();
  return json({ photo: '/img/u/' + key.slice(2) });
}

async function removeContent(req, env, id, kind) {
  const p = await loadPlayer(env, id);
  if (!p) return bad('Player not found', 404);
  if (!await isCaptain(req, env, p) && !await ownsPlayer(req, env, p)) return bad('Not allowed.', 403);
  if (kind === 'photo') {
    if (p.photo_key && p.photo_key.startsWith('u/')) await env.BUCKET.delete(p.photo_key);
    await env.DB.prepare('UPDATE players SET photo_key = NULL WHERE id = ?').bind(p.id).run();
  } else await env.DB.prepare('UPDATE players SET story = NULL WHERE id = ?').bind(p.id).run();
  return json({ ok: true });
}

async function report(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const kind = b.kind === 'story' ? 'story' : b.kind === 'photo' ? 'photo' : null;
  const p = await loadPlayer(env, int(b.player_id, 1, 1e9));
  if (!kind || !p) return bad('Nothing to report.');
  const v = await visitorHash(req, env);
  if (!await bump(env, `report:${v}:${utcDay()}`, REPORTS_PER_VISITOR_PER_DAY)) return bad('Too many reports today.', 429);
  await env.DB.prepare('INSERT INTO reports (kind, player_id, club_id, reason, created_at, visitor) VALUES (?,?,?,?,?,?)')
    .bind(kind, p.id, p.club_id, clean(b.reason, 200), Date.now(), v).run();
  return json({ ok: true }, 201);
}

async function submitResult(req, env) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const club = await clubBySlug(env, b.club);
  if (!club) return bad('Club not found', 404);
  const mode = MODES.has(b.mode) ? b.mode : null;
  const time = int(b.time_s, 1, 36000), taps = int(b.taps, 0, 100000), cad = int(b.max_cad, 0, 1000);
  const runner = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND club_id = ? AND removed = 0 AND banned = 0').bind(int(b.runner_id, 1, 1e9), club.id).first();
  if (!mode || time === null || taps === null || cad === null || !runner) return bad('Invalid result.');
  // Plausibility: the game cannot go faster than about 12:00, taps are capped at ~22 per second.
  const realSeconds = time / TS;
  if (time < 660 || time > 3600) return bad('That time is not possible in this game.', 422);
  if (taps < 30 || taps / realSeconds > 23 || cad > 25) return bad('That tap rate is not possible.', 422);
  const v = await visitorHash(req, env);
  if (!await bump(env, `result:${v}:${utcDay()}`, RESULTS_PER_VISITOR_PER_DAY)) return bad('Too many results today.', 429);
  let by = null;
  const bid = int(b.by_player_id, 1, 1e9);
  if (bid) { const bp = await loadPlayer(env, bid); if (bp && bp.club_id === club.id && await ownsPlayer(req, env, bp)) by = bp.id; }
  const day = amsDay();
  await env.DB.prepare('INSERT INTO results (club_id, player_id, by_player_id, mode, time_s, taps, max_cad, day, created_at, visitor) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(club.id, runner.id, by, mode, time, taps, cad, day, Date.now(), v).run();
  return json({ ok: true, day }, 201);
}

async function leaderboard(req, env, slug) {
  const club = await clubBySlug(env, slug);
  if (!club) return bad('Club not found', 404);
  const u = new URL(req.url);
  const mode = MODES.has(u.searchParams.get('mode')) ? u.searchParams.get('mode') : 'classic';
  const out = {};
  for (const period of ['today', 'all']) {
    const where = period === 'today' ? 'AND r.day = ?' : '';
    const stmt = env.DB.prepare(`SELECT p.nickname AS name, p.legacy_id, MIN(r.time_s) AS time_s,
        (SELECT nickname FROM players WHERE id = (SELECT by_player_id FROM results r2 WHERE r2.player_id = r.player_id AND r2.club_id = r.club_id AND r2.mode = r.mode ${period === 'today' ? 'AND r2.day = r.day' : ''} ORDER BY r2.time_s LIMIT 1)) AS by_name
        FROM results r JOIN players p ON p.id = r.player_id
        WHERE r.club_id = ? AND r.mode = ? AND p.removed = 0 AND p.banned = 0 ${where}
        GROUP BY r.player_id ORDER BY time_s LIMIT 10`);
    const rows = await (period === 'today' ? stmt.bind(club.id, mode, amsDay()) : stmt.bind(club.id, mode)).all();
    out[period] = rows.results;
  }
  return json({ mode, day: amsDay(), ...out });
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
    runners: await q(`SELECT COALESCE(p.nickname || ' (' || c.name || ')', e.runner) AS runner, COUNT(*) AS races FROM events e
                      LEFT JOIN players p ON (e.runner = 'p' || p.id OR e.runner = p.legacy_id) LEFT JOIN clubs c ON c.id = p.club_id AND c.slug = e.club
                      WHERE e.day BETWEEN ? AND ? AND e.type='race_start' AND e.runner IS NOT NULL AND (p.id IS NULL OR c.id IS NOT NULL)
                      GROUP BY e.runner, e.club ORDER BY races DESC LIMIT 15`, ...R),
    clubs: await q(`SELECT c.slug, c.name, c.join_code, c.captain_name, c.captain_email,
                      (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.removed = 0 AND p.banned = 0) AS players,
                      (SELECT COUNT(*) FROM events e WHERE e.club = c.slug AND e.type = 'race_finish' AND e.day BETWEEN ? AND ?) AS races
                    FROM clubs c WHERE c.removed = 0 ORDER BY races DESC, players DESC LIMIT 50`, ...R),
  });
}
async function adminReports(req, env) {
  const { results } = await env.DB.prepare(`SELECT r.id, r.kind, r.reason, r.created_at, r.status, p.id AS player_id, p.name, p.nickname, p.photo_key, p.story, p.banned, c.name AS club
      FROM reports r JOIN players p ON p.id = r.player_id JOIN clubs c ON c.id = r.club_id WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 100`).all();
  return json({ reports: results.map(r => ({ ...r, photo: r.photo_key ? (r.photo_key.startsWith('static:') ? '/' + r.photo_key.slice(7) : '/img/u/' + r.photo_key.slice(2)) : null, photo_key: undefined })) });
}
async function adminAct(req, env, id) {
  let b; try { b = await req.json(); } catch { return bad('bad json'); }
  const r = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
  if (!r) return bad('Report not found', 404);
  const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(r.player_id).first();
  if (b.action === 'remove' || b.action === 'ban') {
    if (r.kind === 'photo' || b.action === 'ban') {
      if (p.photo_key && p.photo_key.startsWith('u/')) await env.BUCKET.delete(p.photo_key);
      await env.DB.prepare('UPDATE players SET photo_key = NULL WHERE id = ?').bind(p.id).run();
    }
    if (r.kind === 'story' || b.action === 'ban') await env.DB.prepare('UPDATE players SET story = NULL WHERE id = ?').bind(p.id).run();
    if (b.action === 'ban') {
      await env.DB.prepare('UPDATE players SET banned = 1 WHERE id = ?').bind(p.id).run();
      if (p.device_token_hash) await env.DB.prepare('INSERT OR IGNORE INTO banned_devices (token_hash, created_at) VALUES (?, ?)').bind(p.device_token_hash, Date.now()).run();
    }
  } else if (b.action !== 'dismiss') return bad('Unknown action');
  await env.DB.prepare(`UPDATE reports SET status = ? WHERE player_id = ? AND kind = ? AND status = 'open'`)
    .bind(b.action === 'dismiss' ? 'dismissed' : 'done', r.player_id, b.action === 'ban' ? r.kind : r.kind).run();
  if (b.action === 'ban') await env.DB.prepare(`UPDATE reports SET status = 'done' WHERE player_id = ? AND status = 'open'`).bind(r.player_id).run();
  return json({ ok: true });
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
      let r;
      if ((r = path.match(/^\/api\/join\/([A-Za-z0-9]{6})$/)) && m === 'GET') {
        const c = await env.DB.prepare('SELECT slug FROM clubs WHERE join_code = ? AND removed = 0').bind(r[1].toUpperCase()).first();
        return c ? json({ slug: c.slug }) : bad('No club with that code.', 404);
      }
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)$/)) && m === 'GET') return getClub(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/players$/)) && m === 'POST') return joinClub(req, env, r[1]);
      if ((r = path.match(/^\/api\/clubs\/([a-z0-9-]+)\/leaderboard$/)) && m === 'GET') return leaderboard(req, env, r[1]);
      if ((r = path.match(/^\/api\/players\/(\d+)$/))) {
        if (m === 'PATCH') return editPlayer(req, env, +r[1]);
        if (m === 'DELETE') return deletePlayer(req, env, +r[1]);
      }
      if ((r = path.match(/^\/api\/players\/(\d+)\/photo$/))) {
        if (m === 'PUT') return uploadPhoto(req, env, +r[1]);
        if (m === 'DELETE') return removeContent(req, env, +r[1], 'photo');
      }
      if ((r = path.match(/^\/api\/players\/(\d+)\/story$/)) && m === 'DELETE') return removeContent(req, env, +r[1], 'story');
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
