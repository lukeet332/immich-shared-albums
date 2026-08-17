#!/bin/bash
# Two-device demo driver: Device 1 (Nan, household B) creates + shares an album;
# Device 2 (Grandpa Joe, household C) joins via the share link banner, contributes
# photos back, and both exchange comments. Runs pre-rehearsed taps via tap.sh.
#
# Usage: demo-two-devices.sh <scene>      — run one scene (rehearsal)
#        demo-two-devices.sh all          — run the full demo with paced sleeps
#
# Devices must be pre-prepared (see demo/e2e/README):
#   emulator-5554 = B (Demo Nan), signed in, photos in /sdcard/Pictures
#   emulator-5556 = C (Grandpa Joe), signed in, photos in /sdcard/DCIM/Camera
#   Chrome logged into the local web UI on BOTH devices (for the linking part)
set -uo pipefail
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"
DIR="$(cd "$(dirname "$0")" && pwd)"
T="$DIR/tap.sh"
D1=emulator-5554   # Nan / household B (owner)
D2=emulator-5556   # Grandpa Joe / household C (joiner)
B=http://192.168.0.11:2284
BS=http://192.168.0.11:8301
ALBUM="Summer Trip"

pace() { sleep "${1:-2}"; }

scene_1_create_album() { # D1: open app, create the album from the Albums tab
  adb -s $D1 shell monkey -p app.alextran.immich 1 >/dev/null 2>&1; pace 4
  $T $D1 find "Albums" 10; pace 2
  $T $D1 find "Create album" 10; pace 2
  $T $D1 find "Add a title" 5 && $T $D1 type "$ALBUM"; pace 1
  $T $D1 key 111; pace 1
  $T $D1 find "Add photos" 10; pace 2
  # select the first three photos in the picker (coords frozen at rehearsal)
  for XY in "TBD" ; do echo "REHEARSE: photo picker taps"; done
}

scene_2_share_link() { # D1: create the share link from the album screen
  echo "REHEARSE: album overflow menu -> Share -> Create link"
}

scene_3_join() { # D2: open the share link in Chrome (as if texted over), banner join
  KEY=$(curl -s $B/api/shared-links -H "x-api-key: $BKEY" | python3 -c 'import json,sys;print(json.load(sys.stdin)[-1]["key"])')
  adb -s $D2 shell am start -a android.intent.action.VIEW -d "$BS/share/$KEY" com.android.chrome; pace 6
  echo "REHEARSE: banner field tap -> type http://192.168.0.11:2285 -> Join -> Accept -> Open in Immich app"
}

scene_4_contribute() { # D2: add own photos to the joined album
  echo "REHEARSE: album -> + -> pick photos -> upload"
}

scene_5_comments() { # both: comment in each direction
  echo "REHEARSE: D1 comment 'Lovely day!' -> D2 sees it -> D2 replies"
}

case "${1:-all}" in
  1) scene_1_create_album ;;
  2) scene_2_share_link ;;
  3) scene_3_join ;;
  4) scene_4_contribute ;;
  5) scene_5_comments ;;
  all) scene_1_create_album; scene_2_share_link; scene_3_join; scene_4_contribute; scene_5_comments ;;
esac
