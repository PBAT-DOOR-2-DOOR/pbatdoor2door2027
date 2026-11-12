#!/usr/bin/env bash
# First deploy and every update, on the server, from the repo directory:
#   scripts/deploy.sh            # pull the current branch, rebuild, restart, health-check
#   scripts/deploy.sh --no-pull  # rebuild and restart what's checked out
# If the new version doesn't become healthy, the previous image is started again.
# Caddy is reloaded every time, so changes in deploy/caddy/ (Caddyfile, zoni.caddy, the radio page) go live.
# Exits non-zero on any failure (2 = app healthy but HTTPS through Caddy not answering,
# 3 = Caddy refused the new deploy/caddy/ settings; the previous ones keep running).
#
# Also run by GitHub Actions as the SSH forced command for the CI deploy key (see README, section 6),
# so it must never prompt: no TTY, no stdin, and the ssh client's command line is ignored.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
exec < /dev/null

PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

die() { echo "deploy: $*" >&2; exit 1; }

# One deploy at a time (a manual run and a CI run could otherwise overlap).
exec 9> "${TMPDIR:-/tmp}/pbatdoor2door-deploy.lock"
flock -w 900 9 || die "another deploy is still running."

# Fail instead of waiting for a password or host-key prompt that nobody can answer.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"
[ -t 1 ] || export BUILDKIT_PROGRESS=plain
echo "deploy: running in $PWD as $(id -un)"
[ -f .env ] || die ".env is missing. Copy .env.example to .env and fill it in."
set -a; . ./.env; set +a

# Guard rails: refuse obviously unsafe production settings.
[ "${NODE_ENV:-production}" = "production" ] || die "NODE_ENV must be production on the server."
[ -n "${POSTGRES_PASSWORD:-}" ] && [ "${POSTGRES_PASSWORD}" != "change-me" ] || die "Set a strong POSTGRES_PASSWORD in .env."
[ -n "${ACME_EMAIL:-}" ] || die "Set ACME_EMAIL in .env (Let's Encrypt expiry notices)."
[ -n "${SITE_DOMAIN:-}" ] || die "Set SITE_DOMAIN in .env."
case ",${COMPOSE_PROFILES:-}," in *,prod,*) ;; *) die "Set COMPOSE_PROFILES=prod in .env so Caddy and backups run.";; esac
if [ -z "${BREVO_API_KEY:-}${ZEPTOMAIL_TOKEN:-}${RESEND_API_KEY:-}${GMAIL_SCRIPT_URL:-}${SMTP_HOST:-}" ]; then
  echo "deploy: WARNING: no email provider set; sign-in emails will not be delivered." >&2
fi
mkdir -p "${BACKUP_DIR:-./backups}" && chmod 700 "${BACKUP_DIR:-./backups}"
# Radio (https://zoni…/radio/): Caddy reads the episodes Zoni writes. Create the folder as this user if Zoni
# hasn't yet, so Docker doesn't create it owned by root (Zoni, user 1000, must be able to write there).
mkdir -p "${ZONI_RADIO_DIR:-/opt/zoni/radio}/episodes" 2>/dev/null \
  || echo "deploy: WARNING: couldn't create ${ZONI_RADIO_DIR:-/opt/zoni/radio}; deploy Zoni first (it creates it)." >&2

if [ "$PULL" = 1 ]; then
  git fetch --prune origin
  git merge --ff-only "@{u}" || die "Local changes or a diverged branch; resolve them, then retry."
fi
REV="$(git rev-parse --short HEAD)"

# Keep the running image as :previous for rollback.
if docker image inspect pbat-app:latest > /dev/null 2>&1; then
  docker tag pbat-app:latest pbat-app:previous
fi

echo "deploy: building $REV..."
docker compose build --pull app
docker compose up -d --remove-orphans

# Caddy reads deploy/caddy/ only when it starts, and `up -d` leaves it running when only those files changed,
# so reload it. A reload is graceful (no dropped connections); a broken config is refused and the old one stays.
reload_caddy() {
  if [ -z "$(docker compose ps -q caddy 2>/dev/null)" ]; then
    echo "deploy: caddy isn't running; nothing to reload" >&2
    return 0
  fi
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

wait_healthy() {
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

if wait_healthy; then
  if ! reload_caddy; then
    echo "deploy: ERROR: Caddy refused the new settings in deploy/caddy/; it is still running the previous ones." >&2
    echo "deploy: check with: docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile" >&2
    exit 3
  fi
  echo "deploy: Caddy reloaded (deploy/caddy/)"
  echo "deploy: app $REV is healthy; checking HTTPS through Caddy..."
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 --resolve "${SITE_DOMAIN}:443:127.0.0.1" "https://${SITE_DOMAIN}/readyz" > /dev/null 2>&1; then
      echo "deploy: $REV is live at https://${SITE_DOMAIN}"
      docker image prune -f > /dev/null
      exit 0
    fi
    sleep 3
  done
  # The app itself is fine, so don't roll back; this is almost always DNS, firewall or certificates.
  echo "deploy: WARNING: the app is healthy but https://${SITE_DOMAIN} isn't answering yet." >&2
  echo "deploy: check DNS, ports 80/443 and: docker compose logs caddy" >&2
  exit 2
fi

echo "deploy: health check FAILED for $REV" >&2
docker compose logs --tail 80 app >&2 || true
if docker image inspect pbat-app:previous > /dev/null 2>&1; then
  echo "deploy: rolling back to the previous image" >&2
  docker tag pbat-app:previous pbat-app:latest
  docker compose up -d --no-build app
  wait_healthy && echo "deploy: previous version restored (code checkout is still at $REV)." >&2
fi
exit 1
