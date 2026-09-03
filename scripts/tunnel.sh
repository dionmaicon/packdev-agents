#!/bin/sh
# Deliberately generic: never hardcodes a specific tunnel tool. Set
# TUNNEL_COMMAND to whatever your tunnel provider needs (ngrok, cloudflared,
# localtunnel, ...) — this script just execs it. Run as a separate
# script/container from the main --webhook process, not auto-started inside
# it (one process per container; the tunnel dying shouldn't kill the
# webhook listener, or vice versa). See docs/self-hosted.md.
set -eu

if [ -z "${TUNNEL_COMMAND:-}" ]; then
  echo "TUNNEL_COMMAND is not set — nothing to run." >&2
  echo 'Example: TUNNEL_COMMAND="ngrok http $WEBHOOK_PORT --authtoken=$NGROK_AUTHTOKEN"' >&2
  exit 1
fi

exec sh -c "$TUNNEL_COMMAND"
