# Wolfpack Run

An 8-bit 5K running game for running clubs, live at **https://wolfpackrun.app**.
Pick a runner, mash RUN to run two laps of 2.5K, jump for beetroot, Nomio shots, gels and hearts,
and dodge puddles and geese. The first club is **Wolfpack Zuiderpark** with its hand-made runners.

- **Offline first:** if the API cannot be reached, the game still plays with the built-in runners.
- **Clubs:** create a club, invite runners with a link or join code (WhatsApp share), profiles with photo and story,
  club leaderboards (today and all time), captain moderation.
- **Privacy-friendly analytics** with an admin dashboard at `/admin`. No raw IPs, no tracking cookies. See `/privacy`.

## How it is built

| Part | Where |
|---|---|
| Game (single page, canvas) | `index.html` |
| Admin dashboard | `admin.html` |
| Privacy page | `privacy.html` |
| API + page serving (Cloudflare Pages advanced mode Worker) | `worker/api.js`, `worker/scrypt.js` |
| Database schema and first club | `worker/schema.sql`, `worker/seed.sql` |
| Build, deploy, password tools | `tools/` |

Cloudflare pieces: **Pages** project `wolfpack-run` (domain wolfpackrun.app), **D1** database `wolfpack-run`,
**R2** bucket `wolfpack-run` (uploaded photos under `u/`, game images under `static/`).
`tools/build.mjs` bundles the API and the HTML pages into `dist/_worker.js`.

## Run it locally

```bash
npm i -D wrangler                       # once
node tools/hash-password.mjs 'a-local-test-password' # copy the output
echo "ADMIN_PASSWORD_HASH=<paste>" > .dev.vars        # git-ignored
node tools/build.mjs
npx wrangler d1 execute wolfpack-run --local --file worker/schema.sql
npx wrangler d1 execute wolfpack-run --local --file worker/seed.sql
npx wrangler pages dev dist --port 8788
```

Open http://localhost:8788 for the game and http://localhost:8788/admin for the dashboard.
Rebuild (`node tools/build.mjs`) after changing `index.html`, `admin.html`, `privacy.html` or `worker/*.js`.

## Deploy

You need an API token with: **Account > Cloudflare Pages > Edit**, **Account > D1 > Edit**,
**Account > Workers R2 Storage > Edit** (and Zone > DNS > Edit if you change domains).

```bash
export CF_ACCOUNT_ID=<your account id>
export CLOUDFLARE_API_TOKEN=<token>
tools/deploy.sh
```

`deploy.sh` is safe to run again. It creates or reuses the D1 database and R2 bucket, applies the schema and
seed (`CREATE IF NOT EXISTS` / `INSERT OR IGNORE`, so existing data is kept), uploads the game images to R2,
binds `DB` and `BUCKET` to the Pages project, builds and deploys.

To change data of an existing row (for example a built-in runner's tagline), run an `UPDATE` with
`npx wrangler d1 execute wolfpack-run --remote --command "..."`; the seed never overwrites rows.

## Admin password

The password is never stored anywhere. Only an **scrypt hash** is kept, as an encrypted Pages secret named
`ADMIN_PASSWORD_HASH`. Login is checked on the server, sessions use an HttpOnly, Secure, SameSite=Strict cookie
(12 hours), and login is limited to 5 attempts per 15 minutes per visitor.

**Set or rotate it:**

```bash
tools/set-admin-password.sh 'a-long-new-password'   # at least 12 characters
tools/deploy.sh                                     # secrets apply to new deployments
```

Rotating logs out every admin session. Alternative without the script:
`node tools/hash-password.mjs 'new-password'`, then paste the output into
Cloudflare dashboard > Workers & Pages > wolfpack-run > Settings > Variables and Secrets > `ADMIN_PASSWORD_HASH`
(type Secret), and redeploy.

## Clubs and captains

- A new club gets a share link `wolfpackrun.app/c/<slug>` and a 6-character join code.
- No passwords: the captain gets a private link `/c/<slug>#captain=<token>`. It is stored on their device.
  Lost it? In `/admin` > Clubs, press **New captain link** and send it privately (it replaces the old one).
- Players edit their own profile with a private device token stored in the browser. Captains can edit anyone
  in their club, set stats (FAST + SLOW = 6, 14 points in total) and remove photos, stories and players.
- New players get stats suggested from their PBs (Riegel formula: a strong 10K or marathon for your 5K means
  more slow twitch).

## Privacy

- Visitor id = SHA-256(IP + User-Agent + daily salt). The salt is random, stored in D1, rotated every UTC day,
  and older salts are deleted. The IP is only used in memory for that hash; it is never stored or logged.
- Stored per event: country, region, city (from Cloudflare), referrer domain, UTM tags, device type, date and hour.
- No tracking cookies or tracking storage. The only cookie is the admin session cookie on `/admin`.

## Abuse limits

3 clubs and 20 profiles per visitor per day, 30 uploads (max 2 MB, JPEG only, permission checkbox required),
20 reports, 300 results. Results are checked on the server: times from 11:00 to 60:00 and at most about
23 taps per second, so impossible times and autoclickers are rejected. The word "parkrun" (a trademark) is
not allowed in club names or profiles.
