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
  bmad-loop init --project "$ROOT" --cli claude --cli codex --cli gemini --cli copilot
fi

# init bakes absolute paths into tracked Codex hooks; rewrite to a git-root
# lookup so the file stays portable and the worktree stays clean.
python3 - <<'PY'
import json
from pathlib import Path

path = Path(".codex/hooks.json")
if not path.exists():
    raise SystemExit(0)

data = json.loads(path.read_text())
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


rewrite(data)
path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Agent tools:"
command -v uv && uv --version
command -v bmad-loop && bmad-loop --version
command -v claude && claude --version
command -v codex && codex --version
command -v gemini && gemini --version
command -v copilot && copilot --version
