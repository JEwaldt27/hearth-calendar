#!/usr/bin/env bash
# Hearth Calendar installer / updater for Ubuntu and Debian.
#
#   curl -fsSL https://raw.githubusercontent.com/JEwaldt27/hearth-calendar/main/install.sh | sudo bash
#
# Installs Docker if needed, downloads the Docker Compose setup into ~/hearth, creates .env with
# fresh secrets, and starts Hearth. Running it again updates an existing install (your .env and
# data are kept).
#
# Optional settings (environment variables, handy for unattended installs):
#   HEARTH_DIR           install folder                    (default ~/hearth of the user running sudo)
#   HEARTH_REF           git branch or tag to install from (default main)
#   HEARTH_BASE_URL      address people will open          (asked; default http://<this server>:8080)
#   HEARTH_TIMEZONE      household time zone               (asked; default this server's zone)
#   HEARTH_DOMAIN        use built-in HTTPS (Caddy) for this domain
#   HEARTH_TUNNEL_TOKEN  use a Cloudflare Tunnel with this token
set -euo pipefail

REPO="JEwaldt27/hearth-calendar"
REF="${HEARTH_REF:-main}"
DIR="${HEARTH_DIR:-}"
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

# "EST" and friends are fixed offsets with no daylight saving; use the real region instead.
normalize_zone() {
  case "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" in
    EST | EDT | ET | EASTERN | US/EASTERN) echo "America/New_York" ;;
    CST | CDT | CT | CENTRAL | US/CENTRAL) echo "America/Chicago" ;;
    MST | MDT | MT | MOUNTAIN | US/MOUNTAIN) echo "America/Denver" ;;
    PST | PDT | PT | PACIFIC | US/PACIFIC) echo "America/Los_Angeles" ;;
    AKST | AKDT | US/ALASKA) echo "America/Anchorage" ;;
    HST | US/HAWAII) echo "Pacific/Honolulu" ;;
    UTC | GMT | ETC/UTC) echo "UTC" ;;
    *) printf '%s' "$1" ;;
  esac
}

valid_zone() {
  [ "$1" = "UTC" ] && return 0
  case "$1" in */*) ;; *) return 1 ;; esac
  [ ! -d /usr/share/zoneinfo ] || [ -f "/usr/share/zoneinfo/$1" ]
}

ask_zone() {
  local default="$1" zone
  for _ in 1 2 3 4 5; do
    zone="$(normalize_zone "$(ask "Household time zone, e.g. America/New_York" "$default")")"
    if valid_zone "$zone"; then printf '%s' "$zone"; return; fi
    printf 'Unknown time zone "%s". Use a Region/City name like America/Chicago or Europe/London.\n' "$zone" > /dev/tty
  done
  printf '%s' "$default"
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

# Snap commands are links to /usr/bin/snap rather than paths under /snap.
is_snap_docker() {
  local p
  p="$(command -v docker)"
  case "$p" in /snap/*) return 0 ;; esac
  [ "$(readlink -f "$p")" = "/usr/bin/snap" ]
}

# Moves the install folder, keeping everything in it. Only used for the default location.
move_to() {
  local new="$1"
  [ "$new" = "$DIR" ] && return 0
  info "Moving Hearth to $new"
  mkdir -p "$new"
  cp -a "$DIR/." "$new/"
  rm -rf "$DIR"
  DIR="$new"
  cd "$DIR"
}

# Hearth lives in the home folder of whoever ran sudo: every kind of Docker can read home
# folders, including the sandboxed snap version (which can't read /opt).
if [ -z "$DIR" ]; then
  home="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6 || true)"
  { [ -n "$home" ] && [ -d "$home" ]; } || home="/root"
  DIR="$home/hearth"
  # Earlier versions of this installer used /opt/hearth.
  if [ ! -f "$DIR/.env" ] && [ -f /opt/hearth/.env ]; then
    info "Moving your earlier install from /opt/hearth to $DIR"
    mkdir -p "$DIR"
    cp -a /opt/hearth/. "$DIR/"
    rm -rf /opt/hearth
  fi
fi

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
  current_zone="$(get_env DEFAULT_TIMEZONE)"
  fixed_zone="$(normalize_zone "$current_zone")"
  if [ -n "$current_zone" ] && [ "$fixed_zone" != "$current_zone" ]; then
    set_env DEFAULT_TIMEZONE "$fixed_zone"
    info "Time zone $current_zone changed to $fixed_zone (so daylight saving is handled)"
  fi
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
  if [ -n "${HEARTH_TIMEZONE:-}" ]; then set_env DEFAULT_TIMEZONE "$(normalize_zone "$HEARTH_TIMEZONE")"; else set_env DEFAULT_TIMEZONE "$(ask_zone "$zone")"; fi
fi

# --- Start -------------------------------------------------------------------------------
info "Downloading and starting Hearth (this can take a minute the first time)"
if ! docker compose config -q >/dev/null 2>&1; then
  # Last resort for snap Docker: its own data folder is always readable to it.
  if [ -z "${HEARTH_DIR:-}" ] && is_snap_docker; then move_to /var/snap/docker/common/hearth; fi
  if ! docker compose config -q >/dev/null 2>&1; then
    docker compose config -q || true
    fail "Docker Compose can't read $DIR/docker-compose.yml (Docker: $(command -v docker)). Set HEARTH_DIR to a folder Docker can read and run this again."
  fi
fi
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
