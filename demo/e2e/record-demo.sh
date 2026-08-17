#!/bin/bash
# Record both demo emulators and composite them side by side.
# adb screenrecord caps at 3 minutes per file, so each device records in
# chained segments; ffmpeg concatenates per device, then hstacks the pair.
# Usage: record-demo.sh start   — begin recording on both devices
#        record-demo.sh stop    — stop, pull, and build demo-side-by-side.mp4
set -uo pipefail
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"
D1=emulator-5554
D2=emulator-5556
OUT="${OUT:-$HOME/Documents/immich-shared-albums/demo/recordings}"
mkdir -p "$OUT"

start_one() { # chain 3-minute segments until stop-file appears
  local D=$1
  adb -s "$D" shell rm -f /sdcard/rec-*.mp4 /sdcard/rec-stop 2>/dev/null
  ( i=0
    while ! adb -s "$D" shell ls /sdcard/rec-stop >/dev/null 2>&1; do
      adb -s "$D" shell screenrecord --bit-rate 8000000 "/sdcard/rec-$i.mp4"
      i=$((i+1))
    done ) &
  echo "recording $D (pid $!)"
}

case "${1:-}" in
  start)
    start_one $D1; start_one $D2 ;;
  stop)
    for D in $D1 $D2; do
      adb -s "$D" shell touch /sdcard/rec-stop
      adb -s "$D" shell pkill -INT screenrecord 2>/dev/null
    done
    sleep 3
    for D in $D1 $D2; do
      mkdir -p "$OUT/$D"; rm -f "$OUT/$D"/rec-*.mp4 "$OUT/$D/list.txt"
      for F in $(adb -s "$D" shell ls /sdcard/rec-*.mp4 2>/dev/null | tr -d '\r'); do
        adb -s "$D" pull "$F" "$OUT/$D/" >/dev/null && echo "file '$OUT/$D/$(basename $F)'" >> "$OUT/$D/list.txt"
      done
      ffmpeg -y -f concat -safe 0 -i "$OUT/$D/list.txt" -c copy "$OUT/$D.mp4" 2>/dev/null
    done
    # equal heights, side by side
    ffmpeg -y -i "$OUT/$D1.mp4" -i "$OUT/$D2.mp4" \
      -filter_complex "[0:v]scale=-2:1600[l];[1:v]scale=-2:1600[r];[l][r]hstack" \
      -c:v libx264 -crf 20 -pix_fmt yuv420p "$OUT/demo-side-by-side.mp4"
    echo "built $OUT/demo-side-by-side.mp4" ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
