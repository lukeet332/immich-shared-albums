#!/bin/bash
# Scripted two-device demo: Nan (household B) creates + shares an album; Grandpa Joe
# (household C) gets the link by text, joins via the banner, contributes photos back,
# and they exchange comments. All coordinates pre-rehearsed (see demo-targets.md).
#
#   demo-two-devices.sh reset    — purge servers, reset apps/Chrome state for a clean take
#   demo-two-devices.sh run      — perform the paced demo (record separately)
#
# Devices (prepped, signed in to the SIDECAR-proxied origins):
#   emulator-5554 = Nan,  app+web http://$LAN_IP:8301, photos in /sdcard/Pictures
#   emulator-5556 = Joe,  app+web http://$LAN_IP:8302, photos in /sdcard/DCIM/Camera
#
# LAN_IP is the LAN address of this machine, auto-detected below. Never
# hardcode it: this repo is public.
set -uo pipefail
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:/Applications/Docker.app/Contents/Resources/bin"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LAN_IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)}"
: "${LAN_IP:?set LAN_IP to the LAN address of this machine}"
D1=emulator-5554
D2=emulator-5556
B=http://localhost:2284
BKEY=$(grep -m1 B_API_KEY "$DIR/demo/.env" | cut -d= -f2-)

t1() { adb -s $D1 shell input tap "$@"; }
t2() { adb -s $D2 shell input tap "$@"; }
type1() { adb -s $D1 shell input text "$1"; }
type2() { adb -s $D2 shell input text "$1"; }

reset() {
  echo "== purge both mock servers (albums, sidecar users, assets, sidecar state) =="
  ORIGIN_SIDECAR=unused "$DIR/demo/e2e/purge-mocks.sh" 2>/dev/null || {
    # inline fallback: reuse the suite's purge steps
    CKEY=$(grep -m1 C_API_KEY "$DIR/demo/household-c/.env" | cut -d= -f2-)
    for HOST_KEY in "http://localhost:2284 $BKEY b-sidecar" "http://localhost:2285 $CKEY household-c/c-sidecar"; do
      set -- $HOST_KEY
      for AL in $(curl -s $1/api/albums -H "x-api-key: $2" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
        curl -s -X DELETE $1/api/albums/$AL -H "x-api-key: $2" -o /dev/null; done
      for U in $(curl -s $1/api/admin/users -H "x-api-key: $2" | python3 -c "import json,sys;[print(u['id']) for u in json.load(sys.stdin) if u['email'].endswith('@sidecar.local')]" 2>/dev/null); do
        curl -s -X DELETE $1/api/admin/users/$U -H "x-api-key: $2" -H 'Content-Type: application/json' -d '{"force":true}' -o /dev/null; done
      IDS=$(curl -s -X POST $1/api/search/metadata -H "x-api-key: $2" -H 'Content-Type: application/json' -d '{"size":500}' | python3 -c "import json,sys;print(json.dumps([i['id'] for i in json.load(sys.stdin)['assets']['items']]))" 2>/dev/null)
      [ "${IDS:-[]}" != "[]" ] && curl -s -X DELETE $1/api/assets -H "x-api-key: $2" -H 'Content-Type: application/json' -d "{\"ids\":$IDS,\"force\":true}" -o /dev/null
    done
    (cd "$DIR/demo" && docker compose exec -T sidecar-b rm -f /data/state.json /data/state.db /data/state.db-wal /data/state.db-shm; docker compose restart sidecar-b) >/dev/null 2>&1
    (cd "$DIR/demo/household-c" && docker compose exec -T sidecar-c rm -f /data/state.json /data/state.db /data/state.db-wal /data/state.db-shm; docker compose restart sidecar-c) >/dev/null 2>&1
  }
  echo "== seed each server with its user's photos (checksum-merges with device copies) =="
  CKEY=$(grep -m1 C_API_KEY "$DIR/demo/household-c/.env" | cut -d= -f2-)
  FX="$DIR/demo/e2e/fixtures/demo-photos"
  seed() { # base key file stamp
    curl -s -X POST "$1/api/assets" -H "x-api-key: $2" \
      -F "assetData=@$3" -F "deviceAssetId=demo-$(basename $3)" -F deviceId=demo-seed \
      -F "fileCreatedAt=$4" -F "fileModifiedAt=$4" -o /dev/null
  }
  for f in 1 2 3; do seed http://localhost:2284 "$BKEY" "$FX/nan-photo-$f.jpg" "2026-08-16T10:3$f:00.000Z"; done
  for f in 1 2 3 4 5; do seed http://localhost:2285 "$CKEY" "$FX/demo-$f.jpg" "2026-08-16T14:0$f:00.000Z"; done
  echo "== reset app local state (stale albums vanish; sessions survive) =="
  for D in $D1 $D2; do adb -s $D shell am force-stop app.alextran.immich; done
  echo "== forget the remembered banner address (so Joe visibly types it) =="
  adb -s $D2 shell am force-stop com.android.chrome
  echo "== pre-warm Chrome so the take doesn't cold-start it (ANR guard) =="
  adb -s $D2 shell am start -a android.intent.action.VIEW -d "about:blank" com.android.chrome >/dev/null 2>&1
  sleep 10
  adb -s $D2 shell input keyevent 3
  echo "== re-stage: apps re-sync, Nan on Photos, Joe parked on home =="
  adb -s $D2 shell monkey -p app.alextran.immich 1 >/dev/null 2>&1; sleep 15
  adb -s $D2 shell input keyevent 3
  adb -s $D1 shell monkey -p app.alextran.immich 1 >/dev/null 2>&1; sleep 12
  echo "reset done — run '$0 run' to perform the take (start recording first)"
}

run() {
  echo "=== SCENE 1: Nan uploads & creates the album ==="
  adb -s $D1 shell monkey -p app.alextran.immich 1 >/dev/null 2>&1; sleep 6
  t1 990 214; sleep 4                          # avatar: show WHO + WHICH server (8301)
  adb -s $D1 shell input keyevent 4; sleep 1
  t1 673 2251; sleep 2                         # Albums tab
  t1 863 214; sleep 2                          # + new album
  t1 542 531; sleep 1; type1 "Summer%sTrip"; sleep 1
  t1 539 400; sleep 1                          # tap outside: dismiss keyboard
  t1 538 1151; sleep 2                         # Select Photos
  t1 984 542; sleep 1                          # select whole day
  t1 993 214; sleep 2                          # Done
  t1 986 214; sleep 6                          # Create
  echo "=== SCENE 2: Nan creates the share link ==="
  t1 1015 218; sleep 2                         # album overflow
  t1 808 871; sleep 3                          # Create shared link
  t1 883 1419; sleep 1                         # allow upload ON
  t1 841 1843; sleep 4                         # Create link
  t1 73 214; sleep 2                           # close link sheet (back)

  echo "=== SCENE 3: the link reaches Joe by text ==="
  KEY=$(curl -s $B/api/shared-links -H "x-api-key: $BKEY" | python3 -c 'import json,sys;print(json.load(sys.stdin)[-1]["key"])')
  adb -s $D2 emu sms send 07700900123 "Hi Joe! Come see our Summer Trip photos: http://$LAN_IP:8301/share/$KEY"
  sleep 6                                      # notification beat on Joe's home screen
  adb -s $D2 shell am force-stop com.google.android.apps.messaging
  adb -s $D2 shell am start -n com.google.android.apps.messaging/.ui.ConversationListActivity >/dev/null 2>&1; sleep 4
  t2 672 480; sleep 4                          # open the conversation (message on screen)
  # "tap" the link: fire the same VIEW intent the tap would - identical on screen, cannot miss
  adb -s $D2 shell am start -a android.intent.action.VIEW -d "http://$LAN_IP:8301/share/$KEY" com.android.chrome >/dev/null 2>&1
  sleep 15                                     # generous settle: cold Chrome + heavy page

  echo "=== SCENE 4: Joe joins with his own server ==="
  # CDP drives the real page elements (typing shown live) - immune to layout shifts
  adb -s $D2 forward tcp:9223 localabstract:chrome_devtools_remote >/dev/null
  JOIN_OUT=$(cd "$DIR/demo/e2e" && node cdp-join.mjs "$LAN_IP:8302") || echo "CDP join FAILED"
  echo "$JOIN_OUT"
  MIRROR_ID=$(echo "$JOIN_OUT" | grep -o 'ALBUM_ID=.*' | cut -d= -f2)
  # open the album in the app the reliable way (scripted page clicks lack the
  # user gesture chrome requires for intent:// and would bounce to the Play Store).
  # warm the app FIRST so its local db has synced the new album - a cold-start
  # deeplink can't route to an album the app hasn't seen yet
  adb -s $D2 shell monkey -p app.alextran.immich 1 >/dev/null 2>&1
  sleep 12                                     # app sync pulls the joined album
  adb -s $D2 shell am start -a android.intent.action.VIEW -d "https://my.immich.app/albums/$MIRROR_ID" app.alextran.immich >/dev/null 2>&1
  sleep 8                                      # album page opens
  if [ -n "${RUN_PART1_ONLY:-}" ]; then echo "=== PART 1 COMPLETE - handing over ==="; return; fi
  adb -s $D2 shell input swipe 672 1400 672 2200 400; sleep 6   # browse: pull refresh
  sleep 6                                      # let hotlinked thumbnails paint
  adb -s $D2 shell input keyevent 4; sleep 2   # back to Photos
  t2 168 2811; sleep 2                         # Photos tab
  t2 1247 243; sleep 5                         # avatar: Joe's DIFFERENT server (8302)
  adb -s $D2 shell input keyevent 4; sleep 2
  t2 842 2811; sleep 3                         # Albums tab
  t2 672 975; sleep 5                          # reopen Summer Trip

  echo "=== SCENE 5: Joe adds his own photos ==="
  t2 1273 243; sleep 2                         # overflow
  t2 1162 407; sleep 4                         # Add photos
  t2 504 885; sleep 1                          # photo 1 (portrait)
  t2 165 1222; sleep 1                         # photo 2 (sunset)
  t2 1248 243; sleep 10                        # Done -> upload + push

  echo "=== SCENE 6: they arrive on Nan's server ==="
  sleep 20                                     # cross-server sync
  t1 73 214; sleep 2                           # back to albums list
  adb -s $D1 shell input swipe 539 700 539 1400 300; sleep 6    # pull-to-refresh reveals
  t1 539 782; sleep 8                          # open Summer Trip: 5 items

  echo "=== SCENE 7: comments, both directions ==="
  t1 888 214; sleep 3                          # Nan opens comments
  t1 539 2270; sleep 2
  type1 "What%sa%slovely%sday%sout%sJoe!"; sleep 1
  t1 1015 2100; sleep 3                        # send
  sleep 12                                     # comment lane
  t2 1128 243; sleep 4                         # Joe opens comments (sees Nan's)
  t2 672 2824; sleep 2
  type2 "Cracking%sday%sNan,%ssee%syou%ssoon!"; sleep 1
  t2 1273 1886; sleep 3                        # send
  sleep 12
  t1 73 214; sleep 2                           # Nan: close + reopen to reveal reply
  t1 888 214; sleep 6
  echo "=== demo complete ==="
}

part1() { RUN_PART1_ONLY=1 run; }  # scenes 1-4 only, then hand over

case "${1:-}" in
  reset) reset ;;
  run) run ;;
  part1) part1 ;;
  *) echo "usage: $0 reset|run|part1"; exit 1 ;;
esac
