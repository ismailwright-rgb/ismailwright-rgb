#!/bin/sh
# ============================================================================
# Put n8n behind HTTPS, free, with no domain purchase.
#
# WHY THIS IS NEEDED
#   The command center is HTTPS on Netlify. n8n is plain HTTP on port 5678.
#   Browsers refuse to let an HTTPS page call an HTTP endpoint ("mixed
#   content"), so the Invite button fails no matter how correct everything
#   else is. Nothing is misconfigured - the browser is refusing on principle.
#
# HOW
#   Caddy sits in front of n8n and gets a free Let's Encrypt certificate for
#   <your-ip>.nip.io. nip.io is a public wildcard DNS service: any name of the
#   form 1.2.3.4.nip.io resolves to 1.2.3.4. No registrar, no account, no cost.
#
# RUN THIS ON THE DROPLET, as root:
#   ssh root@YOUR_IP
#   curl -fsSL https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/claude/n8n-prospect-tiering-hgkjb0/sanaku/scripts/secure-n8n.sh -o secure-n8n.sh
#   sh secure-n8n.sh
#
# Safe to run more than once.
# ============================================================================
set -eu

PORT="${N8N_PORT:-5678}"
BUILD="2"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  . %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*"; exit 1; }

say "secure-n8n.sh build $BUILD"

[ "$(id -u)" = "0" ] || die "run this as root (ssh root@your-ip, or use sudo)"

# ---------------------------------------------------------------- 1. the IP --
IP="${1:-}"
if [ -z "$IP" ]; then
  IP=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || true)
fi
[ -n "$IP" ] || die "could not work out this machine's public IP - pass it: sh secure-n8n.sh 64.227.100.126"
case "$IP" in
  *.*.*.*) ;;
  *) die "\"$IP\" is not an IPv4 address" ;;
esac
HOST="${IP}.nip.io"
say ""
say "Public IP:  $IP"
say "Hostname:   $HOST"
say "Proxying:   localhost:$PORT"
say ""

# ------------------------------------------------------- 2. is n8n running? --
say "==> Checking n8n is up on port $PORT..."
if ! curl -fsS -m 8 -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
   && ! curl -fsS -m 8 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  die "nothing is answering on 127.0.0.1:$PORT. Start n8n first, or set N8N_PORT."
fi
ok "n8n is answering"

# --------------------------------------------------------------- 3. Caddy ----
# Caddy is NOT in Ubuntu's default repositories - `apt install caddy` on a
# stock droplet fails with "Unable to locate package". Its own repo is needed.
say "==> Installing Caddy..."
if command -v caddy >/dev/null 2>&1; then
  ok "already installed ($(caddy version 2>/dev/null | head -1))"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  ok "installed"
fi

# ------------------------------------------------------------ 4. Caddyfile ---
say "==> Writing /etc/caddy/Caddyfile..."
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-sanaku"
cat > /etc/caddy/Caddyfile <<EOF
# Written by sanaku secure-n8n.sh. Previous file kept as Caddyfile.before-sanaku
$HOST {
	reverse_proxy 127.0.0.1:$PORT {
		# n8n streams execution progress; without this the editor UI stalls.
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddy rejected the config"
ok "written and valid"

# ------------------------------------------------------------- 5. firewall ---
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "==> Opening 80 and 443..."
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "opened (port $PORT left as it is - close it once HTTPS works)"
fi

# -------------------------------------------------------------- 6. restart ---
say "==> Starting Caddy..."
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 3
systemctl is-active --quiet caddy || die "Caddy did not start. See: journalctl -u caddy -n 40 --no-pager"
ok "running"

# --------------------------------------------------------------- 7. verify ---
# The first request triggers certificate issuance, which takes a few seconds.
say "==> Waiting for the certificate (this is the slow bit)..."
i=0
while [ "$i" -lt 20 ]; do
  i=$((i + 1))
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "https://$HOST/healthz" 2>/dev/null || printf '000')
  case "$code" in
    2*|3*|4*)
      say ""
      ok "HTTPS is live"
      say ""
      say "  https://$HOST"
      say ""
      say "Next, on YOUR MAC (not here):"
      say "  sh ~/sanaku.sh set N8N_URL https://$HOST"
      say "  sh ~/sanaku.sh dashboard"
      say ""
      say "Then the Invite button will work."
      say ""
      say "Two things worth doing once you have confirmed that:"
      say "  1. Close the open port:   ufw deny $PORT"
      say "     (n8n is still reachable over HTTPS - only the plain-HTTP door shuts)"
      say "  2. Tell n8n its own address, so the webhook URLs it shows you are"
      say "     the HTTPS ones. Add to its environment and restart it:"
      say "       WEBHOOK_URL=https://$HOST/"
      say "       N8N_PROXY_HOPS=1"
      exit 0 ;;
  esac
  printf '    %ss - still waiting (%s)\n' "$((i * 5))" "$code"
  sleep 5
done

warn "no answer on https://$HOST yet."
say ""
say "Most likely causes, in order:"
say "  - Port 80 is blocked, so Let's Encrypt cannot verify the domain."
say "    Check your DigitalOcean cloud firewall, not just ufw."
say "  - Caddy is still retrying. Watch it:  journalctl -u caddy -f"
exit 1
