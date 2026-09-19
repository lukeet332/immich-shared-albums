#!/bin/bash
# demo/e2e/resource-sampler.sh — record host resource use while a rig run is in flight.
#
# The suite reports wall time per stage but nothing about what it cost the host, so "did that run
# tax the machine" has no answer after the fact: `docker stats` is a snapshot and /proc/meminfo has
# no history. This samples both to a JSONL file so the peak can be read back and attributed.
#
# Deliberately no daemon and no dependencies: it runs as the invoking user, needs no root, and is
# safe to start before a run and kill after. JSONL on purpose — it survives a truncated file and
# needs no parser beyond `JSON.parse` per line.
#
# Usage:  bash demo/e2e/resource-sampler.sh [output.jsonl]
#         E2E_SAMPLE_MS=500 bash demo/e2e/resource-sampler.sh      # faster host sampling
#         E2E_STATS_EVERY=2 ...                                     # docker stats every 2nd tick
set -uo pipefail

OUT=${1:-${E2E_TRACE_OUT:-/tmp/e2e-trace.jsonl}}
SAMPLE_MS=${E2E_SAMPLE_MS:-1000}
STATS_EVERY=${E2E_STATS_EVERY:-5}   # docker stats is the expensive part; host figures are cheap

# /proc/meminfo and /proc/loadavg describe the whole host even from inside a container, which is
# what matters here: the rig's peak is only interesting in terms of what it did to the host.
read_kb() { awk -v k="$1:" '$1==k {print $2}' /proc/meminfo; }

tick=0
: > "$OUT"
while :; do
  tick=$((tick + 1))
  total=$(read_kb MemTotal); avail=$(read_kb MemAvailable); cached=$(read_kb Cached)
  swaptotal=$(read_kb SwapTotal); swapfree=$(read_kb SwapFree)
  zram_used=$(awk '{print $3}' /sys/block/zram0/mm_stat 2>/dev/null || echo 0)
  load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '"?"')

  containers='[]'
  # `(tick - 1) % STATS_EVERY`, NOT `tick % STATS_EVERY`: the latter is never 1 when STATS_EVERY is
  # 1, so asking for every tick sampled nothing at all.
  if [ $(((tick - 1) % STATS_EVERY)) -eq 0 ]; then
    # --no-stream costs a round trip per tick, hence the throttle. Name and MiB only: a JSONL reader
    # wants numbers, and `docker stats` formatting is locale/width dependent.
    containers=$(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null \
      | awk '
          # docker prints a unit per figure ("1.5GiB", "640MiB", "12.3kB"). Stripping the unit and
          # reporting the number as MiB understated everything above MiB by 1024x.
          function to_mib(v,   num, unit) {
            match(v, /^[0-9.]+/); num = substr(v, 1, RLENGTH) + 0; unit = substr(v, RLENGTH + 1);
            if (unit == "B") return num / 1048576;
            if (unit ~ /^k/) return num / 1024;
            if (unit ~ /^M/) return num;
            if (unit ~ /^G/) return num * 1024;
            if (unit ~ /^T/) return num * 1024 * 1024;
            return num;
          }
          { split($2, a, "/"); printf "%s{\"name\":\"%s\",\"mem_mib\":%.1f}", (NR>1?",":""), $1, to_mib(a[1]) }
        ' \
      | sed 's/^/[/; s/$/]/')
    [ -n "$containers" ] || containers='[]'
  fi

  printf '{"ts":"%s","mem_total_kb":%s,"mem_avail_kb":%s,"cached_kb":%s,"swap_total_kb":%s,"swap_free_kb":%s,"zram_used":%s,"load":"%s","containers":%s}\n' \
    "$(date -u +%FT%TZ)" "${total:-0}" "${avail:-0}" "${cached:-0}" "${swaptotal:-0}" "${swapfree:-0}" \
    "${zram_used:-0}" "$load" "$containers" >> "$OUT"

  sleep "$(awk -v ms="$SAMPLE_MS" 'BEGIN{print ms/1000}')"
done
