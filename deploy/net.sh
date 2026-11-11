#!/usr/bin/env bash
# The server's TCP settings: BBR congestion control with the fq queue. BBR keeps a stream
# flowing on lossy and long-distance links (phones, listeners far from the server) where the default
# (cubic) slows right down after each lost packet.
#
#   sudo bash ~/raadio/deploy/net.sh           show what's set now (changes nothing)
#   sudo bash ~/raadio/deploy/net.sh --apply   switch BBR on, now and after every reboot
#   (or the short forms: raadio net / raadio net --apply)
#
# It writes /etc/sysctl.d/99-raadio-net.conf. To go back to the default: delete that file
# and reboot (or: sudo sysctl -w net.ipv4.tcp_congestion_control=cubic net.core.default_qdisc=fq_codel).
set -euo pipefail

CONF=/etc/sysctl.d/99-raadio-net.conf

show() {
  echo "    congestion control: $(sysctl -n net.ipv4.tcp_congestion_control)"
  echo "    queue:              $(sysctl -n net.core.default_qdisc)"
  echo "    available:          $(sysctl -n net.ipv4.tcp_available_congestion_control)"
}

main() {
  local apply=0
  case "${1:-}" in
    --apply) apply=1 ;;
    "") ;;
    *) echo "Usage: sudo bash $0 [--apply]" >&2; exit 1 ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    echo "Needs sudo: sudo bash $0 ${1:-}" >&2
    exit 1
  fi

  echo "==> Now:"
  show
  if [ "$(sysctl -n net.ipv4.tcp_congestion_control)" = bbr ] &&
     [ "$(sysctl -n net.core.default_qdisc)" = fq ] && [ -e "$CONF" ]; then
    echo "==> Nothing to do: BBR is on and stays on after a reboot."
    return 0
  fi
  if [ "$apply" -eq 0 ]; then
    echo "==> Nothing changed yet. To switch BBR on: sudo bash $0 --apply"
    return 0
  fi

  # the BBR module ships with Ubuntu's kernel; load it now and at every boot
  modprobe tcp_bbr
  echo tcp_bbr > /etc/modules-load.d/raadio-bbr.conf
  cat > "$CONF" <<'EOF'
# Raadio (deploy/net.sh): BBR congestion control with the fq queue, for steadier streams
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
  sysctl -q -p "$CONF"
  echo "==> After:"
  show
  if [ "$(sysctl -n net.ipv4.tcp_congestion_control)" != bbr ]; then
    echo "!! BBR didn't take. Removing $CONF; nothing else changed." >&2
    rm -f "$CONF" /etc/modules-load.d/raadio-bbr.conf
    exit 1
  fi
  echo "==> BBR is on. New connections use it; listeners already connected keep cubic until they reconnect."
}

main "$@"
