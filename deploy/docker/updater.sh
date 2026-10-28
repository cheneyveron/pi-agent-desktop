#!/bin/sh
# Updater sidecar for the Docker deployment of the Web server.
#
# The server (which has no Docker access) writes "$UPDATER_DIR/request":
#     id=<uuid>
#     version=<x.y.z>
# This script pulls ghcr.io/cheneyveron/pi-agent-desktop:<version> through the
# compose project, recreates only the web service, waits for it to turn healthy
# and otherwise rolls back to the previous tag. Progress goes to
# "$UPDATER_DIR/status" (key=value lines) for the server to show.
#
# The image tag lives in "$PROJECT_DIR/.env" as PI_AGENT_TAG, which the compose
# file must require, so a manual `docker compose up` keeps the updated version.

set -u

UPDATER_DIR="${UPDATER_DIR:-/var/lib/pi-updater}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/compose.yaml}"
SERVICE="${SERVICE:-web}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
POLL_SECONDS="${POLL_SECONDS:-2}"
UPDATER_ONCE="${UPDATER_ONCE:-0}"

REQUEST="$UPDATER_DIR/request"
STATUS="$UPDATER_DIR/status"
ENV_FILE="$PROJECT_DIR/.env"

log() { echo "[updater] $*" >&2; }

# Error text is shown in the UI: printable ASCII only, no quotes, bounded.
clean() { printf '%s' "$1" | sed 's/[^ -~]//g' | tr -d '"\\=' | cut -c1-300; }

write_status() { # id phase version [error]
  tmp="$STATUS.tmp"
  {
    printf 'id=%s\nphase=%s\nversion=%s\n' "$1" "$2" "$3"
    if [ -n "${4:-}" ]; then printf 'error=%s\n' "$(clean "$4")"; fi
  } > "$tmp" && mv "$tmp" "$STATUS"
}

compose() { docker compose --project-directory "$PROJECT_DIR" -f "$COMPOSE_FILE" "$@"; }

current_tag() { sed -n 's/^PI_AGENT_TAG=//p' "$ENV_FILE" 2>/dev/null | tail -n 1; }

set_tag() {
  if [ -f "$ENV_FILE" ] && grep -q '^PI_AGENT_TAG=' "$ENV_FILE"; then
    # Not `sed -i`: BSD sed (macOS) reads its argument as the backup suffix and
    # fails, which left the old tag in place. Rewriting through `cat >` also
    # keeps the file's mode and inode.
    tmp="$ENV_FILE.tmp"
    sed "s/^PI_AGENT_TAG=.*/PI_AGENT_TAG=$1/" "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  else
    ( umask 077; printf 'PI_AGENT_TAG=%s\n' "$1" >> "$ENV_FILE" )
  fi
}

# healthy | unhealthy | timeout. Only a container running the requested tag
# counts: after a failed `up` the old, healthy container must not pass for it.
wait_healthy() {
  want="$1"
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    cid="$(compose ps -q "$SERVICE" 2>/dev/null | head -n 1)"
    if [ -n "$cid" ]; then
      image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)"
      case "$image" in
        *":$want")
          state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null)"
          case "$state" in
            healthy) echo healthy; return ;;
            unhealthy|exited|dead) echo unhealthy; return ;;
          esac
          ;;
      esac
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
  done
  echo timeout
}

handle_request() {
  file="$1"
  id="$(sed -n 's/^id=//p' "$file" | head -n 1)"
  version="$(sed -n 's/^version=//p' "$file" | head -n 1)"
  rm -f "$file"

  if ! printf '%s' "$id" | grep -Eq '^[0-9a-f-]{36}$'; then
    log "ignoring request with an invalid id"
    return
  fi
  if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    log "rejecting invalid version"
    write_status "$id" failed "" "Invalid version in the update request."
    return
  fi

  previous="$(current_tag)"
  log "updating $SERVICE: ${previous:-unknown} -> $version"
  write_status "$id" pulling "$version"
  if ! PI_AGENT_TAG="$version" compose pull "$SERVICE" >&2; then
    write_status "$id" failed "$version" "Could not pull image $version. Is it published yet?"
    return
  fi

  write_status "$id" restarting "$version"
  set_tag "$version"
  if compose up -d --no-deps --no-build "$SERVICE" >&2; then
    result="$(wait_healthy "$version")"
  else
    result="not started (compose up failed)"
  fi
  if [ "$result" = healthy ]; then
    write_status "$id" done "$version"
    log "now running $version"
    return
  fi

  log "$version is $result; rolling back to ${previous:-nothing}"
  if [ -z "$previous" ]; then
    write_status "$id" failed "$version" "Version $version was $result and no previous tag is recorded."
    return
  fi
  set_tag "$previous"
  if compose up -d --no-deps --no-build "$SERVICE" >&2; then
    write_status "$id" failed "$version" "Version $version was $result; rolled back to $previous."
  else
    write_status "$id" failed "$version" "Version $version was $result and rolling back to $previous also failed."
  fi
}

mkdir -p "$UPDATER_DIR"
rm -f "$REQUEST.processing"
log "watching $REQUEST"
while :; do
  if [ -f "$REQUEST" ] && mv "$REQUEST" "$REQUEST.processing" 2>/dev/null; then
    handle_request "$REQUEST.processing"
  fi
  [ "$UPDATER_ONCE" = 1 ] && exit 0
  sleep "$POLL_SECONDS"
done
