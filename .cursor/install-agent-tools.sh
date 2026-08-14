#!/usr/bin/env bash
# Durable Cloud Agent / developer bootstrap for BMAD loop coding CLIs.
# Idempotent: skips tools that are already on PATH.
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # shellcheck disable=SC1091
  if [ -f "${HOME}/.local/bin/env" ]; then
    . "${HOME}/.local/bin/env"
  fi
fi
export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v bmad-loop >/dev/null 2>&1; then
  uv tool install "bmad-loop[tui] @ git+https://github.com/bmad-code-org/bmad-loop.git"
fi

if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

# Google shut off Gemini CLI "Login with Google" for individuals (free / AI Pro /
# Ultra) on 18 Jun 2026. The replacement is Antigravity CLI (`agy`). Keep
# @google/gemini-cli for Gemini Code Assist Standard/Enterprise and paid API keys.
if ! command -v agy >/dev/null 2>&1; then
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi

mkdir -p "${HOME}/.local"
npm config set prefix "${HOME}/.local"
npm install -g @openai/codex @google/gemini-cli @github/copilot

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Claude Code reads .claude/skills; BMAD skills are maintained under .agents/skills.
mkdir -p .claude
if [ ! -L .claude/skills ]; then
  rm -rf .claude/skills
  ln -s ../.agents/skills .claude/skills
fi

if command -v bmad-loop >/dev/null 2>&1; then
  bmad-loop init --project "$ROOT" --cli claude --cli codex --cli gemini --cli copilot --cli antigravity
fi

# init bakes absolute paths into tracked Codex / Antigravity hooks; rewrite to a
# git-root lookup so the files stay portable and the worktree stays clean.
python3 - <<'PY'
import json
from pathlib import Path

template = (
    'python3 "$(git rev-parse --show-toplevel)/.bmad-loop/bmad_loop_hook.py" {event}'
)


def rewrite(obj):
    if isinstance(obj, dict):
        command = obj.get("command")
        if isinstance(command, str) and "bmad_loop_hook.py" in command:
            event = command.rstrip().split()[-1]
            obj["command"] = template.format(event=event)
        for value in obj.values():
            rewrite(value)
    elif isinstance(obj, list):
        for value in obj:
            rewrite(value)


for rel in (".codex/hooks.json", ".agents/hooks.json"):
    path = Path(rel)
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    rewrite(data)
    path.write_text(json.dumps(data, indent=2) + "\n")
PY

# Cloud Agent VMs sleep; bmad-loop's session cap is wall-clock, so a 90-minute
# default expires across a nap even if Claude is still mid-story. Seed longer
# budgets + auto-rollback. policy.toml is gitignored (machine-local).
python3 - <<'PY'
import json
import re
from pathlib import Path

policy = Path(".bmad-loop/policy.toml")
if policy.exists():
    text = policy.read_text()
    replacements = {
        r"^(session_timeout_min\s*=\s*)\d+": r"\g<1>720",
        r"^(max_tokens_per_story\s*=\s*)\d+": r"\g<1>8000000",
        r"^(max_tokens_per_session\s*=\s*)\d+": r"\g<1>8000000",
        r"^(rollback_on_failure\s*=\s*)(?:true|false)": r"\g<1>true",
    }
    for pattern, repl in replacements.items():
        text, n = re.subn(pattern, repl, text, count=1, flags=re.M)
        if n != 1:
            raise SystemExit(f"install-agent-tools: failed to set {pattern}")
    policy.write_text(text)

settings_path = Path.home() / ".claude" / "settings.json"
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings = {}
if settings_path.exists():
    try:
        loaded = json.loads(settings_path.read_text() or "{}")
        if isinstance(loaded, dict):
            settings = loaded
    except json.JSONDecodeError:
        settings = {}
settings["skipDangerousModePermissionPrompt"] = True
settings_path.write_text(json.dumps(settings, indent=2) + "\n")
PY

echo "Agent tools:"
command -v uv && uv --version
command -v bmad-loop && bmad-loop --version
command -v claude && claude --version
command -v codex && codex --version
command -v gemini && gemini --version
command -v copilot && copilot --version
command -v agy && agy --version
