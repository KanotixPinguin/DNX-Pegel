#!/usr/bin/env bash
set -Eeuo pipefail
CMD=${1:-install}
TYP=${TYP:-auto}
CONTAINER=${CONTAINER:-}
PLUGINS=${PLUGINS:-}
NORESTART=${NORESTART:-0}
HERE=$(cd "$(dirname "$0")" && pwd)
BACK="/opt/dnx-pegel-backups"

detect_container() {
  if [[ -n "$CONTAINER" ]]; then
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^(owrx|openwebrx)' | head -n 1 || true)
  fi
  CONTAINER=${CONTAINER:-owrx-8013}
}

resolve_paths() {
  if [[ "$TYP" == "normal" ]]; then
    SRC="$PLUGINS"
    if [[ -z "$SRC" ]]; then
      for cand in /usr/lib/python3/dist-packages/htdocs/plugins /opt/openwebrx/htdocs/plugins /srv/openwebrx/htdocs/plugins; do
        if [[ -d "$cand/receiver" ]]; then
          SRC="$cand"
          break
        fi
      done
    fi
  else
    if [[ "$TYP" == "auto" && -n "$PLUGINS" && -d "$PLUGINS/receiver" ]]; then
      SRC="$PLUGINS"
    else
      command -v docker >/dev/null 2>&1 || { echo "Docker fehlt. Nutze TYP=normal PLUGINS=/pfad/zu/plugins."; exit 1; }
      detect_container
      SRC=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/usr/lib/python3/dist-packages/htdocs/plugins"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
      if [[ -z "${SRC:-}" && "$TYP" == "auto" ]]; then
        for cand in /opt/owrx-docker/plugins /usr/lib/python3/dist-packages/htdocs/plugins /opt/openwebrx/htdocs/plugins /srv/openwebrx/htdocs/plugins; do
          if [[ -d "$cand/receiver" ]]; then
            SRC="$cand"
            break
          fi
        done
      fi
    fi
  fi
  [[ -n "${SRC:-}" && -d "$SRC/receiver" ]] || { echo "Plugin-Pfad nicht gefunden (${SRC:-leer})."; exit 1; }
  INIT="$SRC/receiver/init.js"
  DEST="$SRC/receiver/waterfall_pro"
  [[ -f "$INIT" ]] || { echo "init.js nicht gefunden: $INIT"; exit 1; }
}

remove_loader() {
  python3 - "$INIT" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
t = p.read_text(encoding='utf-8')
a = '/* DNX_PEGEL_LOADER_START */'
b = '/* DNX_PEGEL_LOADER_END */'
if a in t and b in t:
    x, y = t.split(a, 1)
    _, z = y.split(b, 1)
    p.write_text(x.rstrip() + '\n' + z.lstrip(), encoding='utf-8')
PY
}

restart_owrx() {
  [[ "$NORESTART" == "1" ]] && return 0
  detect_container || true
  if [[ "$TYP" != "normal" ]] && command -v docker >/dev/null 2>&1 && [[ -n "${CONTAINER:-}" ]] && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker restart "$CONTAINER"
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^openwebrx'; then
    systemctl restart openwebrx
  fi
}

install_cmd() {
  [[ $EUID -eq 0 ]] || { echo "Bitte als root/sudo ausfuehren."; exit 1; }
  resolve_paths
  local S
  S=$(date +%F-%H%M%S)
  mkdir -p "$BACK/$S" "$DEST"
  cp -a "$INIT" "$BACK/$S/init.js"
  [[ -f "$DEST/waterfall_pro.js" ]] && cp -a "$DEST/waterfall_pro.js" "$BACK/$S/waterfall_pro.js" || true
  [[ -f "$DEST/waterfall_pro.css" ]] && cp -a "$DEST/waterfall_pro.css" "$BACK/$S/waterfall_pro.css" || true

  cp "$HERE/files/waterfall_pro.js" "$DEST/waterfall_pro.js"
  cp "$HERE/files/waterfall_pro.css" "$DEST/waterfall_pro.css"
  chmod 0644 "$DEST/waterfall_pro.js" "$DEST/waterfall_pro.css"
  remove_loader

  if ! grep -Eq "Plugins\.load\(['\"]waterfall_pro['\"]\)|loadOne\(['\"]waterfall_pro['\"]\)" "$INIT"; then
    cat >> "$INIT" <<'JS'

/* DNX_PEGEL_LOADER_START */
(function () {
  if (window.__dnxPegelLoader || window.__dnxWfPro) return;
  window.__dnxPegelLoader = true;
  if (!document.querySelector('link[href*="waterfall_pro.css"]')) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'static/plugins/receiver/waterfall_pro/waterfall_pro.css?v=20261123';
    document.head.appendChild(l);
  }
  if (window.Plugins && typeof Plugins.load === 'function') {
    try { Plugins.load('waterfall_pro'); return; } catch (e) {}
  }
  var s = document.createElement('script');
  s.src = 'static/plugins/receiver/waterfall_pro/waterfall_pro.js?v=' + Date.now();
  s.async = false;
  (document.head || document.documentElement).appendChild(s);
})();
/* DNX_PEGEL_LOADER_END */
JS
  fi

  if command -v node >/dev/null 2>&1; then
    node --check "$DEST/waterfall_pro.js"
    node --check "$INIT"
  fi
  restart_owrx
  echo "DNX Pegel v1.0.0 installiert in: $DEST"
}

uninstall_cmd() {
  [[ $EUID -eq 0 ]] || { echo "Bitte als root/sudo ausfuehren."; exit 1; }
  resolve_paths
  local S
  S=$(date +%F-%H%M%S)
  mkdir -p "$BACK/$S"
  cp -a "$INIT" "$BACK/$S/init.js"
  remove_loader
  rm -f "$DEST/waterfall_pro.js" "$DEST/waterfall_pro.css"
  restart_owrx
  echo "DNX Pegel entfernt (Backup: $BACK/$S)."
}

status_cmd() {
  resolve_paths
  if [[ -f "$DEST/waterfall_pro.js" ]]; then
    echo "DNX Pegel installiert in $DEST ($(wc -c < "$DEST/waterfall_pro.js") Bytes)"
  else
    echo "DNX Pegel nicht installiert ($DEST)"
  fi
}

case "$CMD" in
  install|update) install_cmd ;;
  uninstall) uninstall_cmd ;;
  status) status_cmd ;;
  *) echo "Aufruf: $0 [install|update|status|uninstall]"; exit 2 ;;
esac
