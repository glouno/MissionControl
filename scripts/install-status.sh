#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(),sys.argv[1],"exec")' "$ROOT/missioncontrol"
mkdir -p "$HOME/.local/bin"
install -m 0700 "$ROOT/missioncontrol" "$HOME/.local/bin/missioncontrol"
echo 'Installed missioncontrol (read-only status CLI).'
