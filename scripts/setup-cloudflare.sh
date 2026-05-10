#!/usr/bin/env bash
# setup-cloudflare.sh — Provision Cloudflare infrastructure for yopedia
#
# Requires:
#   CLOUDFLARE_API_TOKEN  — Wrangler API token (or `wrangler login` for local)
#   CLOUDFLARE_ACCOUNT_ID — Cloudflare account identifier
#
# Usage:
#   ./scripts/setup-cloudflare.sh
#
# Idempotent — safe to re-run. Existing resources are skipped.
# After running, wrangler.toml is updated with the actual resource IDs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER="npx wrangler"
WRANGLER_TOML="$PROJECT_ROOT/wrangler.toml"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*"; exit 1; }

# --- Preflight ---
command -v npx >/dev/null 2>&1 || fail "npx not found. Install Node.js first."

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  warn "CLOUDFLARE_ACCOUNT_ID not set. Wrangler may prompt or fail."
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  warn "CLOUDFLARE_API_TOKEN not set. Expecting 'wrangler login' session."
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   yopedia — Cloudflare Infrastructure Setup  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Track created resource IDs
KV_CONFIG_ID=""
KV_SEARCH_ID=""

# --- 1. R2 Bucket ---
info "Creating R2 bucket: yopedia-raw ..."
if $WRANGLER r2 bucket create yopedia-raw 2>&1 | tee /tmp/r2-output.txt; then
  ok "R2 bucket 'yopedia-raw' ready"
else
  if grep -qi "already exists\|already been taken" /tmp/r2-output.txt 2>/dev/null; then
    ok "R2 bucket 'yopedia-raw' already exists"
  else
    warn "R2 bucket creation returned an error (may already exist)"
  fi
fi
echo ""

# --- 2. KV Namespace: YOPEDIA_CONFIG ---
info "Creating KV namespace: YOPEDIA_CONFIG ..."
KV_CONFIG_OUTPUT=$($WRANGLER kv namespace create YOPEDIA_CONFIG 2>&1) || true
echo "$KV_CONFIG_OUTPUT"

# Extract namespace ID from output like: { id: "abc123" } or "id": "abc123"
KV_CONFIG_ID=$(echo "$KV_CONFIG_OUTPUT" | grep -oP '(?:id["\s:=]+)["'"'"']?\K[a-f0-9]{32}' | head -1 || true)
if [ -n "$KV_CONFIG_ID" ]; then
  ok "KV namespace YOPEDIA_CONFIG created: $KV_CONFIG_ID"
else
  warn "Could not extract YOPEDIA_CONFIG namespace ID from output"
  warn "If it already exists, find the ID with: $WRANGLER kv namespace list"
fi
echo ""

# --- 3. KV Namespace: YOPEDIA_SEARCH ---
info "Creating KV namespace: YOPEDIA_SEARCH ..."
KV_SEARCH_OUTPUT=$($WRANGLER kv namespace create YOPEDIA_SEARCH 2>&1) || true
echo "$KV_SEARCH_OUTPUT"

KV_SEARCH_ID=$(echo "$KV_SEARCH_OUTPUT" | grep -oP '(?:id["\s:=]+)["'"'"']?\K[a-f0-9]{32}' | head -1 || true)
if [ -n "$KV_SEARCH_ID" ]; then
  ok "KV namespace YOPEDIA_SEARCH created: $KV_SEARCH_ID"
else
  warn "Could not extract YOPEDIA_SEARCH namespace ID from output"
  warn "If it already exists, find the ID with: $WRANGLER kv namespace list"
fi
echo ""

# --- 4. Vectorize Index ---
info "Creating Vectorize index: yopedia-embeddings ..."
if $WRANGLER vectorize create yopedia-embeddings --dimensions 1536 --metric cosine 2>&1 | tee /tmp/vec-output.txt; then
  ok "Vectorize index 'yopedia-embeddings' ready"
else
  if grep -qi "already exists" /tmp/vec-output.txt 2>/dev/null; then
    ok "Vectorize index 'yopedia-embeddings' already exists"
  else
    warn "Vectorize creation returned an error (may already exist)"
  fi
fi
echo ""

# --- 5. Pages Project ---
info "Creating Pages project: yopedia ..."
if $WRANGLER pages project create yopedia --production-branch main 2>&1 | tee /tmp/pages-output.txt; then
  ok "Pages project 'yopedia' ready"
else
  if grep -qi "already exists\|already been taken\|A project with this name already exists" /tmp/pages-output.txt 2>/dev/null; then
    ok "Pages project 'yopedia' already exists"
  else
    warn "Pages project creation returned an error (may already exist)"
  fi
fi
echo ""

# --- 6. Update wrangler.toml ---
info "Updating wrangler.toml ..."

if [ ! -f "$WRANGLER_TOML" ]; then
  fail "wrangler.toml not found at $WRANGLER_TOML"
fi

# Replace placeholder KV IDs if we extracted real ones
if [ -n "$KV_CONFIG_ID" ]; then
  if grep -q '<YOPEDIA_CONFIG_NAMESPACE_ID>' "$WRANGLER_TOML"; then
    sed -i "s/<YOPEDIA_CONFIG_NAMESPACE_ID>/$KV_CONFIG_ID/g" "$WRANGLER_TOML"
    ok "Updated YOPEDIA_CONFIG namespace ID in wrangler.toml"
  else
    info "YOPEDIA_CONFIG placeholder not found (may already be set)"
  fi
fi

if [ -n "$KV_SEARCH_ID" ]; then
  if grep -q '<YOPEDIA_SEARCH_NAMESPACE_ID>' "$WRANGLER_TOML"; then
    sed -i "s/<YOPEDIA_SEARCH_NAMESPACE_ID>/$KV_SEARCH_ID/g" "$WRANGLER_TOML"
    ok "Updated YOPEDIA_SEARCH namespace ID in wrangler.toml"
  else
    info "YOPEDIA_SEARCH placeholder not found (may already be set)"
  fi
fi

echo ""
echo "═══════════════════════════════════════════════"
echo ""
echo "  Resource Summary"
echo ""
echo "  R2 bucket:       yopedia-raw"
echo "  KV (config):     YOPEDIA_CONFIG  ${KV_CONFIG_ID:-(check wrangler kv namespace list)}"
echo "  KV (search):     YOPEDIA_SEARCH  ${KV_SEARCH_ID:-(check wrangler kv namespace list)}"
echo "  Vectorize:       yopedia-embeddings (1536d, cosine)"
echo "  Pages project:   yopedia"
echo ""
echo "═══════════════════════════════════════════════"
echo ""

if [ -z "$KV_CONFIG_ID" ] || [ -z "$KV_SEARCH_ID" ]; then
  warn "Some KV namespace IDs could not be extracted automatically."
  echo "  Run:  $WRANGLER kv namespace list"
  echo "  Then update wrangler.toml with the correct IDs."
  echo ""
fi

ok "Infrastructure provisioning complete!"
echo "  Next: run 'npx wrangler dev' to verify local bindings."
echo ""
