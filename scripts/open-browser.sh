#!/usr/bin/env bash
# Launch the persistent fb-warmer Chrome profile with a remote-debugging port
# so both the playwright and chrome-devtools MCP servers can attach to it.
#
# Everything you do in this browser (logins, Chrome Web Store extensions,
# bookmark bar, settings) is saved in the profile dir and reused next time.
#
# Add unpacked extensions: drop each unpacked extension folder (the one with
# manifest.json) into the extensions dir below — they auto-load on next launch.
#
# Override any path/port via env vars:
#   FB_WARMER_PROFILE, FB_WARMER_EXTENSIONS, FB_WARMER_PORT
set -euo pipefail

PROFILE_DIR="${FB_WARMER_PROFILE:-$HOME/.fb-warmer/chrome-profile}"
EXT_DIR="${FB_WARMER_EXTENSIONS:-$HOME/.fb-warmer/extensions}"
PORT="${FB_WARMER_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$PROFILE_DIR" "$EXT_DIR"

# Already running on this port? Reuse it, don't relaunch (profile is locked
# to a single process — a second launch on the same dir would fail).
if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome already live on :${PORT} — reusing existing profile."
  exit 0
fi

# Collect every unpacked extension (subdir containing manifest.json).
# NOTE: no --disable-extensions-except, so Chrome Web Store extensions stay on.
LOAD=""
for d in "$EXT_DIR"/*/; do
  [ -f "${d}manifest.json" ] && LOAD="${LOAD:+$LOAD,}${d%/}"
done

ARGS=(
  --user-data-dir="$PROFILE_DIR"
  --remote-debugging-port="$PORT"
  --no-first-run
  --no-default-browser-check
  --restore-last-session
)
# Chrome 137+ ignores --load-extension by default (feature
# DisableLoadExtensionCommandLineSwitch). Must opt back in to load unpacked
# extensions from the command line.
[ -n "$LOAD" ] && ARGS+=(
  --load-extension="$LOAD"
  --disable-features=DisableLoadExtensionCommandLineSwitch
)

nohup "$CHROME" "${ARGS[@]}" "https://www.facebook.com" "https://www.instagram.com" >/dev/null 2>&1 &

# Wait until the debug endpoint answers (no sleep needed — curl retries).
curl -s --retry 40 --retry-delay 1 --retry-connrefused \
  "http://127.0.0.1:${PORT}/json/version" >/dev/null

echo "Launched Chrome on :${PORT}"
echo "  profile:    $PROFILE_DIR"
echo "  extensions: $EXT_DIR${LOAD:+  (loaded: $LOAD)}"
