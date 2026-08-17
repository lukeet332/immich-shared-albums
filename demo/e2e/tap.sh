#!/bin/bash
# Tap-driver for the two-device demo: find a UI element by visible text (or content-desc)
# via uiautomator dump and tap its center. Robust to layout/resolution differences.
# Usage: tap.sh <serial> text "Share"        — tap element whose text contains "Share"
#        tap.sh <serial> desc "Add photos"   — by content-desc
#        tap.sh <serial> type "hello world"  — type text into the focused field
#        tap.sh <serial> key  66              — send a keycode (66 = enter)
#        tap.sh <serial> wait "Albums" 20     — wait until text appears (seconds)
set -uo pipefail
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"
SERIAL=$1; MODE=$2; ARG=$3; TIMEOUT=${4:-15}

dump() { adb -s "$SERIAL" exec-out uiautomator dump /dev/tty 2>/dev/null | sed 's/UI hierchary.*//'; }

center() { # find a node whose text OR content-desc contains $1 (Flutter uses content-desc)
  python3 - "$1" <<'EOF'
import re, sys
needle = sys.argv[1].lower()
xml = sys.stdin.read()
best = None
for m in re.finditer(r'<node[^>]*?/?>', xml):
    tag = m.group(0)
    t = re.search(r'\btext="([^"]*)"', tag)
    d = re.search(r'content-desc="([^"]*)"', tag)
    hay = ((t.group(1) if t else '') + '\u0000' + (d.group(1) if d else '')).lower()
    if needle not in hay: continue
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
    if not b: continue
    x1, y1, x2, y2 = map(int, b.groups())
    if x2 - x1 == 0 or y2 - y1 == 0: continue
    best = ((x1 + x2) // 2, (y1 + y2) // 2)
    break
print(f"{best[0]} {best[1]}" if best else "NONE")
EOF
}

case "$MODE" in
  text|desc|find)
    for i in $(seq 1 "$TIMEOUT"); do
      XY=$(dump | center "$ARG")
      if [ "$XY" != "NONE" ] && [ -n "$XY" ]; then
        adb -s "$SERIAL" shell input tap $XY
        echo "tap($ARG) @ $XY"; exit 0
      fi
      sleep 1
    done
    echo "MISS: $ARG"; exit 1 ;;
  wait)
    for i in $(seq 1 "$TIMEOUT"); do
      dump | grep -qiE "(text|content-desc)=\"[^\"]*${ARG}" && { echo "seen($ARG)"; exit 0; }
      sleep 1
    done
    echo "TIMEOUT: $ARG"; exit 1 ;;
  type)
    adb -s "$SERIAL" shell input text "$(printf %s "$ARG" | sed 's/ /%s/g')"; echo "typed" ;;
  key)
    adb -s "$SERIAL" shell input keyevent "$ARG"; echo "key $ARG" ;;
esac
