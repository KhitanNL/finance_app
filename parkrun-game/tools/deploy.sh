#!/usr/bin/env bash
# Deploys Wolfpack Run to Cloudflare (Pages project "wolfpack-run", D1 "wolfpack-run", R2 "wolfpack-run").
# Safe to run again: the schema uses CREATE IF NOT EXISTS and the seed uses INSERT OR IGNORE.
#
# Needs: CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (token permissions: Account > Cloudflare Pages Edit,
# Account > D1 Edit, Account > Workers R2 Storage Edit), plus node, curl and python3.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
PROJECT=wolfpack-run DBNAME=wolfpack-run BUCKET=wolfpack-run
jq_py() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

echo "1/6 D1 database"
DB_ID=$(curl -sS "${AUTH[@]}" "$API/d1/database?name=$DBNAME" | jq_py "r=[x for x in d['result'] if x['name']=='$DBNAME']; print(r[0]['uuid'] if r else '')")
if [ -z "$DB_ID" ]; then
  DB_ID=$(curl -sS "${AUTH[@]}" -X POST "$API/d1/database" -H 'content-type: application/json' -d "{\"name\":\"$DBNAME\"}" | jq_py "print(d['result']['uuid'])")
  echo "   created $DB_ID"
else echo "   exists $DB_ID"; fi

echo "2/6 schema + seed"
for f in worker/schema.sql worker/seed.sql; do
  python3 -c "import json,sys; print(json.dumps({'sql': open('$f').read()}))" > /tmp/wr-sql.json
  curl -sS "${AUTH[@]}" -X POST "$API/d1/database/$DB_ID/query" -H 'content-type: application/json' --data @/tmp/wr-sql.json \
    | jq_py "print('   $f:', 'ok' if d['success'] else d['errors'])"
done

echo "3/6 R2 bucket + static images"
curl -sS "${AUTH[@]}" -X POST "$API/r2/buckets" -H 'content-type: application/json' -d "{\"name\":\"$BUCKET\"}" \
  | jq_py "print('   bucket:', 'created' if d['success'] else 'exists' if any(e.get('code')==10004 for e in d['errors']) else d['errors'])"
n=0
while IFS= read -r f; do
  case "$f" in *.png) ct=image/png ;; *.jpg) ct=image/jpeg ;; *) continue ;; esac
  curl -sS -o /dev/null -w '' "${AUTH[@]}" -X PUT "$API/r2/buckets/$BUCKET/objects/static/$f" -H "content-type: $ct" --data-binary "@$f"
  n=$((n+1))
done < <(find img icons -type f | sort)
echo "   uploaded $n files to static/"

echo "4/6 Pages bindings (D1 + R2)"
curl -sS "${AUTH[@]}" -X PATCH "$API/pages/projects/$PROJECT" -H 'content-type: application/json' -d "{\"deployment_configs\":{\"production\":{
  \"compatibility_date\":\"2024-11-01\",\"d1_databases\":{\"DB\":{\"id\":\"$DB_ID\"}},\"r2_buckets\":{\"BUCKET\":{\"name\":\"$BUCKET\"}}}}}" \
  | jq_py "print('   bindings:', 'ok' if d['success'] else d['errors'])"

echo "5/6 build"
node tools/build.mjs

echo "6/6 deploy"
curl -sS "${AUTH[@]}" -X POST "$API/pages/projects/$PROJECT/deployments" -F branch=main -F 'manifest={}' \
  -F "_worker.js=@dist/_worker.js;type=application/javascript+module" \
  | jq_py "print('   deploy:', d['success'], d['errors'] or (d['result'] or {}).get('url'))"
echo "Done. If this is the first deploy, set the admin password: tools/set-admin-password.sh"
