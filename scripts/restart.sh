#!/usr/bin/env bash
# Restart the local pixelpipe proxy.
#
# What this does, in order:
#   1. Discover every running pixelpipe proxy via `pgrep -f "node.*bin/cli.js"`
#      and list them. If multiple are running (orphans from a prior crashed
#      session), kill all of them — there's no "right" oldest in a graceful
#      restart, we want a clean slate.
#   2. Send SIGTERM. The proxy's SIGTERM handler flushes the JSONL tracker
#      and exits. Poll up to 5s for clean exit.
#   3. Anything still alive after 5s gets SIGKILL with a warning.
#   4. Rebuild (`pnpm run build`) unless --no-build is passed. Build errors
#      abort the restart so we never start a stale binary.
#   5. Check the target port is actually free; if not, name the process
#      holding it (with a hint for the user — common cause: another tool, or
#      step 3 didn't fully release).
#   6. Start a fresh proxy via `exec node bin/cli.js "$@"` so Ctrl-C reaches
#      Node directly.
#
# Flags:
#   --no-build    Skip the rebuild step. Use when you know dist/ is fresh.
#                 Anything else (port, upstream, etc.) is passed through to
#                 the proxy unchanged.
#
# Examples:
#   pnpm run restart
#   pnpm run restart -- --no-build
#   pnpm run restart -- --port 47899 --no-tools

set -euo pipefail

cd "$(dirname "$0")/.."

# --- Parse our own flags out of "$@". Everything else passes through. ----
DO_BUILD=1
PROXY_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-build)
      DO_BUILD=0
      ;;
    *)
      PROXY_ARGS+=("$arg")
      ;;
  esac
done

# --- Figure out which port the new proxy will bind. Default 47821; if the
# --- user passed --port we honor it. (We don't try to parse PORT= env var
# --- because that's handled inside bin/cli.js itself.)
TARGET_PORT=47821
prev=""
for arg in "${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"}"; do
  case "$prev" in
    -p|--port)
      TARGET_PORT="$arg"
      ;;
  esac
  prev="$arg"
done

# --- 1. Discover running proxies ------------------------------------------
# `[c]li.js` keeps pgrep from matching itself if anyone pipes us through grep.
PIDS_RAW=$(pgrep -f 'node.*bin/[c]li\.js' 2>/dev/null || true)
if [ -n "$PIDS_RAW" ]; then
  # Convert to space-separated list, sorted numerically for stable output.
  PIDS=$(echo "$PIDS_RAW" | tr '\n' ' ' | xargs -n1 | sort -n | tr '\n' ' ')
  echo "[restart] found running pixelpipe proxy PID(s): $PIDS"

  # --- 2. SIGTERM all of them ---
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "[restart] SIGTERM $pid (graceful — tracker flushes on shutdown)"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  # Poll up to 5s for graceful exit.
  for _ in $(seq 1 50); do
    STILL=$(pgrep -f 'node.*bin/[c]li\.js' 2>/dev/null || true)
    [ -z "$STILL" ] && break
    sleep 0.1
  done

  # --- 3. Escalate to SIGKILL only if still alive ---
  STILL=$(pgrep -f 'node.*bin/[c]li\.js' 2>/dev/null || true)
  if [ -n "$STILL" ]; then
    echo "[restart] WARNING: PID(s) still alive after 5s, escalating to SIGKILL: $STILL"
    for pid in $STILL; do
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.3
  fi
else
  echo "[restart] no running proxy found"
fi

# --- 4. Rebuild (skippable) ----------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  echo "[restart] rebuilding…"
  if ! pnpm run build; then
    echo "[restart] ERROR: build failed. Not starting a stale binary." >&2
    exit 1
  fi
else
  echo "[restart] --no-build: skipping rebuild (assuming dist/ is fresh)"
fi

# --- 5. Sanity-check the target port is free -----------------------------
# `lsof` is preinstalled on macOS and most Linux distros. If it isn't, we
# skip the check rather than failing — the new proxy will surface the same
# EADDRINUSE error via Node's listen() callback.
if command -v lsof >/dev/null 2>&1; then
  HOLDER=$(lsof -nP -iTCP:"$TARGET_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$HOLDER" ]; then
    HOLDER_CMD=$(ps -o command= -p "$HOLDER" 2>/dev/null || echo "?")
    echo "[restart] ERROR: port $TARGET_PORT is still held by PID $HOLDER:" >&2
    echo "    $HOLDER_CMD" >&2
    echo "  Hint: if that's a pixelpipe proxy our SIGTERM should have cleared," >&2
    echo "  it may have been started outside this repo. Free the port and rerun." >&2
    exit 1
  fi
fi

# --- 6. Start fresh in the foreground. exec so Ctrl-C goes straight to Node.
echo "[restart] starting fresh proxy on :$TARGET_PORT (Ctrl-C to stop)"
exec node bin/cli.js "${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"}"
