#!/usr/bin/env bash
# Sets or rotates the admin password for /admin.
# Usage: tools/set-admin-password.sh 'a-long-new-password'
# Only the scrypt hash is sent to Cloudflare (as an encrypted Pages secret). All admin sessions are logged out.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
[ $# -eq 1 ] || { echo "Usage: $0 'new-password'"; exit 1; }
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

HASH=$(node tools/hash-password.mjs "$1")
python3 -c "import json,sys; print(json.dumps({'deployment_configs':{'production':{'env_vars':{'ADMIN_PASSWORD_HASH':{'type':'secret_text','value':sys.argv[1]}}}}}))" "$HASH" > /tmp/wr-secret.json
curl -sS "${AUTH[@]}" -X PATCH "$API/pages/projects/wolfpack-run" -H 'content-type: application/json' --data @/tmp/wr-secret.json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('secret:', 'saved' if d['success'] else d['errors'])"
rm -f /tmp/wr-secret.json

# Log everyone out so the old password's sessions stop working.
DB_ID=$(curl -sS "${AUTH[@]}" "$API/d1/database?name=wolfpack-run" | python3 -c "import sys,json; r=[x for x in json.load(sys.stdin)['result'] if x['name']=='wolfpack-run']; print(r[0]['uuid'] if r else '')")
[ -n "$DB_ID" ] && curl -sS "${AUTH[@]}" -X POST "$API/d1/database/$DB_ID/query" -H 'content-type: application/json' -d '{"sql":"DELETE FROM sessions"}' \
  | python3 -c "import sys,json; print('sessions cleared:', json.load(sys.stdin)['success'])"
echo "Secrets apply to new deployments: run tools/deploy.sh (or re-deploy) to activate the new password."
