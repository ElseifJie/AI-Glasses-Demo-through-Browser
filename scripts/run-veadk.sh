#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/apps/veadk-agent"

find_activate_script() {
  local candidates=(
    "$AGENT_DIR/.venv/bin/activate"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  return 1
}

if ! activate_script="$(find_activate_script)"; then
  cat <<EOF 1>&2
[veadk] No Python virtualenv found.
[veadk] Create one with:
  cd "$AGENT_DIR"
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
EOF
  exit 1
fi

source "$activate_script"
exec python3 "$AGENT_DIR/app.py"
