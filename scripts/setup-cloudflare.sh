#!/usr/bin/env bash
# setup-cloudflare.sh — Provision all Cloudflare resources for work-wiki.
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set as env vars
#     (or run `npx wrangler login` for interactive auth)
#   - Node.js + pnpm installed (wrangler runs via npx)
#
# Usage:
#   ./scripts/setup-cloudflare.sh
#
# The script is idempotent — safe to re-run. Resources that already exist
# will be skipped. After provisioning, wrangler.toml is updated with the
# actual resource IDs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER="npx --yes wrangler"
WRANGLER_TOML="$PROJECT_ROOT/wrangler.toml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*"; exit 1; }

extract_kv_id_from_create_output() {
  sed -n 's/.*id = "\([^"]*\)".*/\1/p' | head -n 1
}

lookup_kv_id() {
  local title="$1"
  local output

  output=$($WRANGLER kv namespace list 2>/dev/null) || return 0
  printf '%s' "$output" | node -e '
const title = process.argv[1];
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const start = input.indexOf("[");
  const end = input.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) process.exit(0);
  const namespaces = JSON.parse(input.slice(start, end + 1));
  const namespace = namespaces.find(item => item.title === title);
  if (namespace?.id) console.log(namespace.id);
});
' "$title"
}

create_kv_namespace() {
  local title="$1"
  KV_RESULT_ID=""

  info "Creating KV namespace: $title ..."

  local existing_id
  existing_id="$(lookup_kv_id "$title" || true)"
  if [[ -n "$existing_id" ]]; then
    KV_RESULT_ID="$existing_id"
    ok "KV namespace $title already exists: $KV_RESULT_ID"
    echo ""
    return
  fi

  local output
  output=$($WRANGLER kv namespace create "$title" 2>&1) || true
  echo "$output"

  KV_RESULT_ID="$(echo "$output" | extract_kv_id_from_create_output || true)"
  if [[ -n "$KV_RESULT_ID" ]]; then
    ok "KV namespace $title created: $KV_RESULT_ID"
  elif echo "$output" | grep -qi "already exists"; then
    KV_RESULT_ID="$(lookup_kv_id "$title" || true)"
    if [[ -n "$KV_RESULT_ID" ]]; then
      ok "KV namespace $title already exists: $KV_RESULT_ID"
    else
      warn "KV namespace $title already exists, but its ID could not be found."
      info "Run 'npx wrangler kv namespace list' to find the ID."
    fi
  else
    warn "Could not extract KV namespace ID for $title from output."
    info "Run 'npx wrangler kv namespace list' to find the ID."
  fi
  echo ""
}

# ---------- Pre-flight checks ----------

if ! command -v npx &>/dev/null; then
  fail "npx not found. Install Node.js (v18+) first."
fi

# Verify wrangler auth — either token-based or interactive login
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  warn "CLOUDFLARE_API_TOKEN not set — will rely on 'wrangler login' session."
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  warn "CLOUDFLARE_ACCOUNT_ID not set — wrangler will prompt or use default account."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🐙 yopedia — Cloudflare Infrastructure Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ---------- 1. R2 Bucket ----------

info "Creating R2 bucket: yopedia-raw ..."
if $WRANGLER r2 bucket create yopedia-raw 2>&1 | tee /tmp/yopedia-r2.log; then
  ok "R2 bucket 'yopedia-raw' created."
else
  if grep -qi "already exists\|already been taken" /tmp/yopedia-r2.log; then
    ok "R2 bucket 'yopedia-raw' already exists — skipping."
  else
    fail "Failed to create R2 bucket. See output above."
  fi
fi
echo ""

# ---------- 2. KV Namespaces ----------

KV_CONFIG_ID=""
KV_SEARCH_ID=""

create_kv_namespace "YOPEDIA_CONFIG"
KV_CONFIG_ID="$KV_RESULT_ID"

create_kv_namespace "YOPEDIA_SEARCH"
KV_SEARCH_ID="$KV_RESULT_ID"

# ---------- 3. Vectorize Index ----------

info "Creating Vectorize index: yopedia-embeddings ..."
if $WRANGLER vectorize create yopedia-embeddings --dimensions 1536 --metric cosine 2>&1 | tee /tmp/yopedia-vec.log; then
  ok "Vectorize index 'yopedia-embeddings' created."
else
  if grep -qi "already exists" /tmp/yopedia-vec.log; then
    ok "Vectorize index 'yopedia-embeddings' already exists — skipping."
  else
    fail "Failed to create Vectorize index. See output above."
  fi
fi
echo ""

# ---------- 4. Pages Project ----------

info "Creating Pages project: yopedia ..."
if $WRANGLER pages project create yopedia --production-branch main 2>&1 | tee /tmp/yopedia-pages.log; then
  ok "Pages project 'yopedia' created."
else
  if grep -qi "already exists\|A project with this name already exists" /tmp/yopedia-pages.log; then
    ok "Pages project 'yopedia' already exists — skipping."
  else
    fail "Failed to create Pages project. See output above."
  fi
fi
echo ""

# ---------- 5. Update wrangler.toml ----------

info "Updating wrangler.toml with resource IDs ..."

# Use placeholder if we couldn't extract the ID
CONFIG_ID="${KV_CONFIG_ID:-<YOPEDIA_CONFIG_NAMESPACE_ID>}"
SEARCH_ID="${KV_SEARCH_ID:-<YOPEDIA_SEARCH_NAMESPACE_ID>}"

cat > "$WRANGLER_TOML" <<EOF
# work-wiki — Cloudflare deployment config
# Generated by scripts/setup-cloudflare.sh
#
# After provisioning, verify IDs match your account:
#   npx wrangler kv namespace list
#   npx wrangler r2 bucket list
#   npx wrangler vectorize list

name = "yopedia"
compatibility_date = "2025-01-01"
pages_build_output_dir = ".output/public"

# --- R2: Primary storage (wiki markdown files) ---
[[r2_buckets]]
binding = "R2"
bucket_name = "yopedia-raw"

# --- KV: Config and metadata cache ---
[[kv_namespaces]]
binding = "YOPEDIA_CONFIG"
id = "$CONFIG_ID"

# --- KV: Search index (BM25 tokens, derived data) ---
[[kv_namespaces]]
binding = "YOPEDIA_SEARCH"
id = "$SEARCH_ID"

# --- Vectorize: Semantic search embeddings ---
[[vectorize]]
binding = "VECTORIZE"
index_name = "yopedia-embeddings"
EOF

ok "wrangler.toml written to $WRANGLER_TOML"

if [[ "$CONFIG_ID" == *"<"* ]] || [[ "$SEARCH_ID" == *"<"* ]]; then
  echo ""
  warn "Some KV namespace IDs could not be auto-detected."
  warn "Edit wrangler.toml manually with IDs from:"
  info "  npx wrangler kv namespace list"
fi

# ---------- Summary ----------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📋 Provisioning Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  R2 bucket:       yopedia-raw"
echo "  KV (config):     YOPEDIA_CONFIG  → $CONFIG_ID"
echo "  KV (search):     YOPEDIA_SEARCH  → $SEARCH_ID"
echo "  Vectorize:       yopedia-embeddings (1536d, cosine)"
echo "  Pages project:   yopedia"
echo ""
echo "  wrangler.toml:   $WRANGLER_TOML"
echo ""
info "Next steps:"
echo "  1. Verify IDs:   npx wrangler kv namespace list"
echo "  2. Local dev:    npx wrangler dev"
echo "  3. Deploy:       pnpm build && npx wrangler pages deploy .output/public --project-name yopedia"
echo ""
