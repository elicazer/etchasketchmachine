#!/usr/bin/env bash
# Launch helper for the local image-path CV sidecar.
#
# Runs the FastAPI app on loopback:8765 with autoreload for development.
#
# Robustness: bare `uvicorn` is intentionally NOT used. A conda env can shadow
# the system Python and leave `uvicorn` off PATH even when it is installed
# elsewhere on the machine. Instead we probe for the first Python interpreter
# that can `import uvicorn` (and therefore has the rest of the deps from
# requirements.txt), then exec via `python -m uvicorn`. This way the script
# Just Works whether the shell is in (base), some other conda env, a venv, or
# a plain login shell.
set -euo pipefail

# Run from the directory containing app.py so "app:app" resolves.
cd "$(dirname "$0")"

# Candidate interpreters, in priority order:
#   1. PATH `python3` / `python` — whatever the active env exposes,
#   2. the macOS python.org framework Python 3.13 (where `pip install --user`
#      placed the deps for this project),
#   3. a Homebrew Python (Apple Silicon path then Intel path).
CANDIDATES=(
    "$(command -v python3 2>/dev/null || true)"
    "$(command -v python 2>/dev/null || true)"
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"
    "/opt/homebrew/bin/python3"
    "/usr/local/bin/python3"
)

PY=""
for cand in "${CANDIDATES[@]}"; do
    if [[ -n "$cand" && -x "$cand" ]] && "$cand" -c "import uvicorn, fastapi, cv2" >/dev/null 2>&1; then
        PY="$cand"
        break
    fi
done

if [[ -z "$PY" ]]; then
    echo "[imagepath_service] ERROR: could not find a Python with uvicorn + fastapi + cv2 installed." >&2
    echo "[imagepath_service] Install them once into a Python you have on PATH:" >&2
    echo "  python3 -m pip install --user -r tools/imagepath_service/requirements.txt" >&2
    echo "[imagepath_service] Or install them into your conda env, then re-run this script." >&2
    exit 1
fi

echo "[imagepath_service] using $PY"
exec "$PY" -m uvicorn app:app --host 127.0.0.1 --port 8765 --reload
