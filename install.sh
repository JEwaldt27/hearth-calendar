#!/usr/bin/env bash
# Hearth Calendar installer / updater for Ubuntu and Debian.
#
#   curl -fsSL https://raw.githubusercontent.com/JEwaldt27/hearth-calendar/main/install.sh | sudo bash
#
# Installs Docker if needed, downloads the Docker Compose setup into /opt/hearth, creates .env with
# fresh secrets, and starts Hearth. Running it again updates an existing install (your .env and
# data are kept).
#
# Optional settings (environment variables, handy for unattended installs):
#   HEARTH_DIR           install folder                    (default /opt/hearth)
#   HEARTH_REF           git branch or tag to install from (default main)
#   HEARTH_BASE_URL      address people will open          (asked; default http://<this server>:8080)
#   HEARTH_TIMEZONE      household time zone               (asked; default this server's zone)
#   HEARTH_DOMAIN        use built-in HTTPS (Caddy) for this domain
#   HEARTH_TUNNEL_TOKEN  use a Cloudflare Tunnel with this token
set -euo pipefail

REPO="JEwaldt27/hearth-calendar"
REF="${HEARTH_REF:-main}"
DIR="${HEARTH_DIR:-/opt/hearth}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Read an answer from the keyboard even when this script is piped into bash.
ask() {
  local prompt="$1" default="$2" answer=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s [%s]: ' "$prompt" "$default" > /dev/tty
    IFS= read -r answer < /dev/tty || true
  fi
  printf '%s' "${answer:-$default}"
}

# Set KEY=VALUE in .env, replacing an existing (or commented-out) line.
set_env() {
  local key="$1" value="$2" file="$DIR/.env"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^#? ?" k "=" && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

get_env() {
  grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; fi
}

[ "$(id -u)" -eq 0 ] || fail "Run this as root, for example:  curl -fsSL ${RAW}/install.sh | sudo bash"
[ "$(uname -s)" = "Linux" ] || fail "Hearth installs on Linux (Ubuntu or Debian)."
command -v curl >/dev/null 2>&1 || fail "curl is required (apt-get install -y curl)."

bold "Hearth Calendar installer"

# --- Docker ------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing. Install the docker-compose-plugin package and run this again."
systemctl enable --now docker >/dev/null 2>&1 || true

# --- Files -------------------------------------------------------------------------------
mkdir -p "$DIR/deploy" "$DIR/backups"
cd "$DIR"
info "Downloading Hearth ($REF) into $DIR"
for file in docker-compose.yml deploy/backup.sh deploy/Caddyfile .env.example; do
  curl -fsSL "$RAW/$file" -o "$file.new" || fail "Couldn't download $file from GitHub."
  mv "$file.new" "$file"
done

# --- Settings ----------------------------------------------------------------------------
if [ -f .env ]; then
  info "Keeping your existing settings in $DIR/.env"
else
  info "Creating $DIR/.env"
  cp .env.example .env
  chmod 600 .env
  set_env APP_SECRET "$(random_hex 32)"
  set_env POSTGRES_PASSWORD "$(random_hex 24)"

  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  zone="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
  [ "$zone" = "Etc/UTC" ] && zone="UTC"

  echo
  echo "How will people reach Hearth?"
  echo "  1) On my home network only (http://${ip:-this-server}:8080)"
  echo "  2) Built-in HTTPS with my own domain (ports 80 and 443 must reach this server)"
  echo "  3) Cloudflare Tunnel (HTTPS, no open ports; needs a tunnel token)"
  mode="1"
  [ -n "${HEARTH_DOMAIN:-}" ] && mode="2"
  [ -n "${HEARTH_TUNNEL_TOKEN:-}" ] && mode="3"
  [ -z "${HEARTH_BASE_URL:-}" ] && [ -z "${HEARTH_DOMAIN:-}" ] && [ -z "${HEARTH_TUNNEL_TOKEN:-}" ] && mode="$(ask "Choose 1, 2 or 3" "1")"

  case "$mode" in
    2)
      domain="${HEARTH_DOMAIN:-$(ask "Domain name (e.g. calendar.example.com)" "")}"
      [ -n "$domain" ] || fail "A domain is needed for built-in HTTPS."
      set_env DOMAIN "$domain"
      set_env APP_BIND "127.0.0.1"
      set_env COMPOSE_PROFILES "https"
      base="https://$domain"
      ;;
    3)
      token="${HEARTH_TUNNEL_TOKEN:-$(ask "Cloudflare Tunnel token" "")}"
      [ -n "$token" ] || fail "A tunnel token is needed (Cloudflare Zero Trust → Networks → Tunnels)."
      host="$(ask "Public hostname you gave the tunnel (e.g. calendar.example.com)" "")"
      [ -n "$host" ] || fail "The tunnel's public hostname is needed."
      set_env CLOUDFLARE_TUNNEL_TOKEN "$token"
      set_env APP_BIND "127.0.0.1"
      set_env COMPOSE_PROFILES "tunnel"
      base="https://$host"
      echo "In Cloudflare, point that hostname at the service  http://app:3000"
      ;;
    *)
      base="http://${ip:-localhost}:8080"
      ;;
  esac
  base="${HEARTH_BASE_URL:-$base}"
  set_env BASE_URL "${base%/}"
  set_env DEFAULT_TIMEZONE "${HEARTH_TIMEZONE:-$(ask "Household time zone" "$zone")}"
fi

# --- Start -------------------------------------------------------------------------------
info "Downloading and starting Hearth (this can take a minute the first time)"
docker compose pull
docker compose up -d --remove-orphans

info "Waiting for Hearth to start"
ok=0
for _ in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || fail "Hearth didn't report healthy. See the logs:  cd $DIR && docker compose logs --tail 50 app"

docker image prune -f >/dev/null 2>&1 || true

echo
bold "Hearth is running."
echo "  Open:      $(get_env BASE_URL)"
echo "  Settings:  $DIR/.env  (run this installer again after editing to apply)"
echo "  Update:    run the same install command again"
echo "  Logs:      cd $DIR && docker compose logs -f app"
echo
echo "The first account you create becomes the administrator."
