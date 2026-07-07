#!/usr/bin/env bash
# Install (or refresh) the "movapi" systemd service that runs the VidZee -> MP4
# streaming API (vidzee-mp4.js) on :6150.
#
#   sudo bash run.sh              install + enable + start the service
#   bash run.sh --dry-run         just print what it would do (no root needed)
#
# Idempotent: re-running updates the unit and restarts the service.

set -euo pipefail

SERVICE=movapi
PORT="${MP4_PORT:-6150}"
UNIT_PATH="/etc/systemd/system/${SERVICE}.service"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]] && DRY_RUN=1

# --- Resolve who/what/where ---------------------------------------------------
# The user the service runs as: whoever invoked sudo (not root).
RUN_USER="${SUDO_USER:-$(id -un)}"
[[ "$RUN_USER" == "root" ]] && RUN_USER="$(logname 2>/dev/null || echo "$RUN_USER")"
RUN_GROUP="$(id -gn "$RUN_USER")"
USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

# Project dir = the directory this script lives in (…/tmdb-api-latest).
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="${PROJ_DIR}/vidzee-mp4.js"

# node: prefer the user's login-shell node (handles nvm), fall back to system.
NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN=/usr/bin/node
NODE_DIR="$(dirname "$NODE_BIN")"

# ffmpeg must be reachable on the service PATH.
FFMPEG_BIN="$(command -v ffmpeg || echo /usr/bin/ffmpeg)"
FFMPEG_DIR="$(dirname "$FFMPEG_BIN")"

# --- Sanity checks ------------------------------------------------------------
[[ -f "$ENTRY" ]]     || { echo "ERROR: $ENTRY not found" >&2; exit 1; }
[[ -x "$NODE_BIN" ]]  || { echo "ERROR: node not found (looked for $NODE_BIN)" >&2; exit 1; }
[[ -x "$FFMPEG_BIN" ]]|| { echo "ERROR: ffmpeg not found" >&2; exit 1; }

# --- Build the unit -----------------------------------------------------------
UNIT_CONTENT="$(cat <<EOF
[Unit]
Description=movapi — VidZee -> MP4 streaming API on :${PORT}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${PROJ_DIR}
Environment=HOME=${USER_HOME}
Environment=NODE_ENV=production
Environment=MP4_PORT=${PORT}
Environment=MP4_HOST=0.0.0.0
Environment=PATH=${NODE_DIR}:${FFMPEG_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${NODE_BIN} ${ENTRY}
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
)"

echo "Service : ${SERVICE}  (${UNIT_PATH})"
echo "Runs as : ${RUN_USER}:${RUN_GROUP}"
echo "Node    : ${NODE_BIN}"
echo "ffmpeg  : ${FFMPEG_BIN}"
echo "Entry   : ${ENTRY}"
echo "Port    : ${PORT}"
echo

if [[ "$DRY_RUN" == 1 ]]; then
  echo "----- ${UNIT_PATH} (dry run, nothing written) -----"
  echo "$UNIT_CONTENT"
  echo "---------------------------------------------------"
  echo "Run for real with:  sudo bash run.sh"
  exit 0
fi

# --- Install ------------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: needs root. Run:  sudo bash run.sh" >&2
  exit 1
fi

echo "$UNIT_CONTENT" > "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

sleep 1
echo
systemctl --no-pager --full status "$SERVICE" | head -12 || true
echo
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "OK  movapi is up:  http://127.0.0.1:${PORT}/health"
  echo "    try:  http://<this-host>:${PORT}/movie/550"
else
  echo "NOTE: health check didn't answer yet — check:  journalctl -u ${SERVICE} -e"
fi
