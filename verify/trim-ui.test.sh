#!/bin/bash
# Interaction checks for the trim timeline (Remove sections mode).
# Exits non-zero if any expectation fails.
#
# Requires the dev server on :5173 and this session already open on it:
#   agent-browser open http://localhost:5173/
set -u
export AGENT_BROWSER_SESSION=mpb-trim
cd /home/tnv/c/mpbuddy
fails=0

cuts() { agent-browser eval "JSON.parse(localStorage['mpb-opts']).trim.cuts" 2>/dev/null | tail -1 | tr -d '"'; }
label() { agent-browser eval "document.querySelector('.trim-track').parentElement.querySelector('span').innerText" 2>/dev/null | tail -1 | tr -d '"'; }
check() { # check <what> <got> <want>
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: got [$2] want [$3]"; fails=$((fails+1)); fi
}
# Cut values come from pixel positions, and `agent-browser mouse` only takes
# whole pixels, so a dragged edge can land a tenth of a second off. Compare
# ranges with a tolerance instead of demanding the exact float.
check_cut() { # check_cut <what> <got> <want>
  python3 - "$1" "$2" "$3" <<'PY'
import sys
name, got, want = sys.argv[1], sys.argv[2], sys.argv[3]
def sec(v):
    v = v.strip()
    if not v:
        return None
    try:
        t = 0.0
        for p in v.split(":"):
            t = t * 60 + float(p)
        return t
    except ValueError:
        return None
def parse(s):
    out = []
    for chunk in s.split("|"):
        a, _, b = chunk.partition("-")
        out.append((sec(a), sec(b)))
    return out
g, w = parse(got), parse(want)
ok = len(g) == len(w) and all(
    None not in x and None not in y and abs(x[0] - y[0]) <= 0.25 and abs(x[1] - y[1]) <= 0.25
    for x, y in zip(g, w)
)
print(f"PASS  {name}" if ok else f"FAIL  {name}: got [{got}] want [{want}]")
sys.exit(0 if ok else 1)
PY
  [ $? -ne 0 ] && fails=$((fails+1))
  return 0
}

# The track's y depends on what else is on screen (job bar, results)
# and keeps shifting until the <video> element finishes laying out, so park it
# in the middle of the viewport first — the sticky job bar owns the bottom ~90px
# and would otherwise swallow every click — then poll until the box settles.
readbox() {
  local prev="" box="" i
  agent-browser eval "(() => { const r = document.querySelector('.trim-track').getBoundingClientRect(); window.scrollBy(0, r.top - window.innerHeight / 2); return 1; })()" >/dev/null
  for i in $(seq 1 20); do
    box=$(agent-browser eval "(() => { const r = document.querySelector('.trim-track').getBoundingClientRect(); return JSON.stringify([r.x, r.y + r.height / 2, r.width]); })()" 2>/dev/null | tail -1 | tr -d '"[]')
    [ "$box" = "$prev" ] && break
    prev="$box"
    sleep 0.4
  done
  IFS=, read -r X Y W <<< "$box"
  X=$(python3 -c "print(round(float('$X')))")
  Y=$(python3 -c "print(round(float('$Y')))")
  W=$(python3 -c "print(float('$W'))")
}
at() { python3 -c "print(round($X + $W*($1/30.0)))"; }

drag() { # drag <from_s> <to_s>
  local a b x
  a=$(at "$1"); b=$(at "$2")
  agent-browser mouse move "$a" "$Y" >/dev/null 2>&1
  agent-browser mouse down >/dev/null 2>&1
  for x in $(python3 -c "a=$a;b=$b;print(' '.join(str(round(a+(b-a)*i/4)) for i in range(5)))"); do
    agent-browser mouse move "$x" "$Y" >/dev/null 2>&1
  done
  agent-browser mouse up >/dev/null 2>&1
  sleep 0.4
}
tap() { # tap <seconds> - pointerdown+up with no travel
  local a; a=$(at "$1")
  agent-browser mouse move "$a" "$Y" >/dev/null 2>&1
  agent-browser mouse down >/dev/null 2>&1
  agent-browser mouse up >/dev/null 2>&1
  sleep 0.4
}
reload() { # reload + re-pick the clip + Trim + remove mode
  # Picking a new file clears stale cut marks (they belonged to the old clip),
  # so a reload always starts from zero cuts — build the state with gestures.
  agent-browser eval "localStorage.setItem('mpb-opts', JSON.stringify({trim:{mode:'remove',cuts:'',start:'',end:'0:30',exact:'off',snap:'on'}}))" >/dev/null
  agent-browser reload >/dev/null
  agent-browser wait 1200 >/dev/null
  agent-browser eval "document.querySelector('input[type=file]').setAttribute('id','fi')" >/dev/null
  agent-browser upload "#fi" /tmp/opencode/sample.mp4 >/dev/null
  agent-browser wait --fn "document.body.innerText.includes('sample.mp4')" >/dev/null
  agent-browser find role button click --name "Trim" >/dev/null
  agent-browser wait --fn "!!document.querySelector('.trim-track')" >/dev/null
  readbox
}

reload
echo "== 1. tap without travel must not create a cut =="
tap 15
check "tap creates nothing" "$(cuts)" ""

echo "== 2. drag a middle section =="
drag 10 15
check_cut "10s-15s cut" "$(cuts)" "0:10-0:15"
check "header" "$(label)" "Cut 1 section"

echo "== 3. a second, separate section =="
drag 22 25
check_cut "two cuts" "$(cuts)" "0:10-0:15|0:22-0:25"
check "header plural" "$(label)" "Cut 2 sections"

echo "== 4. overlapping drag fuses the two into one =="
drag 14 23
check_cut "fused" "$(cuts)" "0:10-0:25"
check "header singular again" "$(label)" "Cut 1 section"

echo "== 5. move a section by dragging its body =="
# Each gesture starts from a known state: grabbing a handle that is one pixel
# from where the previous step left it makes the next drag ambiguous.
reload
drag 8 18
drag 13 18
check_cut "moved to 13-23" "$(cuts)" "0:13-0:23"

echo "== 6. drag the end handle to resize =="
reload
drag 15 20
EH=$(agent-browser eval "(() => { const r = document.querySelector(\"[data-role='1']\").getBoundingClientRect(); return Math.round(r.x + r.width/2); })()" 2>/dev/null | tail -1 | tr -d '"')
agent-browser mouse move "$EH" "$Y" >/dev/null 2>&1
agent-browser mouse down >/dev/null 2>&1
for t in 21 22 23 24; do agent-browser mouse move "$(at $t)" "$Y" >/dev/null 2>&1; done
agent-browser mouse up >/dev/null 2>&1
sleep 0.4
check_cut "resized to 15-24" "$(cuts)" "0:15-0:24"

echo "== 7. keyboard: 0.1s then shift = 1s =="
agent-browser focus "[data-role='1']" >/dev/null 2>&1
agent-browser press ArrowRight >/dev/null 2>&1
sleep 0.3
check "end +0.1" "$(cuts)" "0:15-0:24.1"
agent-browser press Shift+ArrowRight >/dev/null 2>&1
sleep 0.3
check "end +1.0" "$(cuts)" "0:15-0:25.1"

echo "== 8. start handle cannot cross the end =="
agent-browser focus "[data-role='0']" >/dev/null 2>&1
for _ in $(seq 1 12); do agent-browser press Shift+ArrowRight >/dev/null 2>&1; done
sleep 0.3
check "clamped 0.1 before end" "$(cuts)" "0:25-0:25.1"

echo "== 9. typed timestamps in the list win =="
# The list is the exact frame-level editor, so a typed time beats whatever the
# drag left behind. It still clamps: a start may not jump past the end.
agent-browser fill "[aria-label='Section 1 start time']" "0:01" >/dev/null 2>&1
agent-browser press Tab >/dev/null 2>&1
sleep 0.3
check "typed start" "$(cuts)" "0:01-0:25.1"
agent-browser fill "[aria-label='Section 1 start time']" "1:00" >/dev/null 2>&1
agent-browser press Tab >/dev/null 2>&1
sleep 0.3
check "typed start clamps to the end" "$(cuts)" "0:25-0:25.1"
agent-browser fill "[aria-label='Section 1 start time']" "0:01" >/dev/null 2>&1
agent-browser press Tab >/dev/null 2>&1
sleep 0.3

echo "== 10. typed end past the duration clamps =="
agent-browser fill "[aria-label='Section 1 end time']" "9:00" >/dev/null 2>&1
agent-browser press Tab >/dev/null 2>&1
sleep 0.3
check "clamped to duration" "$(cuts)" "0:01-0:30"

echo "== 11. half-typed text is not destroyed mid-edit =="
agent-browser fill "[aria-label='Section 1 end time']" "2:" >/dev/null 2>&1
sleep 0.2
check "raw text preserved" "$(agent-browser get value "[aria-label='Section 1 end time']" 2>/dev/null | tail -1 | tr -d '"')" "2:"
check "value only applies when it parses" "$(cuts)" "0:01-0:30"
agent-browser press Tab >/dev/null 2>&1
sleep 0.3
check "on blur it normalises to 0:02" "$(cuts)" "0:01-0:02"

echo "== 12. delete button on the row =="
agent-browser click "[aria-label='Remove section 1']" >/dev/null 2>&1
sleep 0.3
check "row X cleared it" "$(cuts)" ""
check "back to nothing-cut" "$(label)" "Nothing cut"

echo "== 13. overlay X deletes a section =="
reload
drag 5 8
agent-browser click "[data-role='del']" >/dev/null 2>&1
sleep 0.4
check "overlay X cleared it" "$(cuts)" ""

echo "== 14. '+ Cut here' adds a section at the playhead =="
agent-browser eval "document.querySelector('video').currentTime = 12" >/dev/null 2>&1
sleep 0.6
agent-browser find role button click --name "＋ Cut here" >/dev/null 2>&1
sleep 0.4
check_cut "2s section at 12s" "$(cuts)" "0:12-0:14"

# The job bar holds the run button; the reason it is blocked sits beside it,
# not inside it.
jobbar() { agent-browser eval "(() => { const b = document.querySelector('[data-jobbar] .btn-apple-primary'); return b.disabled ? 'disabled:' + b.textContent : 'enabled:' + b.textContent; })()" 2>/dev/null | tail -1 | tr -d '"'; }
barNote() { agent-browser eval "document.querySelector('[data-jobbar] [role=status]')?.textContent ?? ''" 2>/dev/null | tail -1 | tr -d '"'; }

echo "== 15. job bar run state =="
check "run enabled with a section" "$(jobbar)" "enabled:Cut these sections out"
agent-browser find role button click --name "Clear all sections" >/dev/null 2>&1
sleep 0.3
check "run blocked without sections" "$(jobbar)" "disabled:Cut these sections out"
check "reason shown in the bar" "$(barNote)" "Mark at least one section to remove."

echo "== 16. keep-range mode still works =="
agent-browser find role radio click --name "Keep a range" >/dev/null 2>&1
sleep 0.5
readbox
# Inside the kept range a drag slides the whole window; only the handles set
# the edges, so grab the end handle rather than the middle.
KH=$(agent-browser eval "(() => { const r = document.querySelector(\"[aria-label='Trim end']\").getBoundingClientRect(); return Math.round(r.x + r.width/2); })()" 2>/dev/null | tail -1 | tr -d '"')
agent-browser mouse move "$KH" "$Y" >/dev/null 2>&1
agent-browser mouse down >/dev/null 2>&1
for t in 20 18 15 12; do agent-browser mouse move "$(at $t)" "$Y" >/dev/null 2>&1; done
agent-browser mouse up >/dev/null 2>&1
sleep 0.4
check_cut "keep range unaffected" \
  "$(agent-browser eval "(() => { const i=document.querySelector('input[aria-label=\"Start timestamp\"]').value + '->' + document.querySelector('input[aria-label=\"End timestamp\"]').value; return i; })()" 2>/dev/null | tail -1 | tr -d '"' | tr '>' '-')" \
  "0:00-0:12"
check "cut mode options are back" \
  "$(agent-browser eval "[...document.querySelectorAll('[role=radio]')].map(b=>b.textContent).join(',')" 2>/dev/null | tail -1 | tr -d '"')" \
  "Keep a range,Cut sections out,Fast copy,Exact"

echo "== 17. removed chrome stays removed =="
check "no theme toggle" \
  "$(agent-browser eval "[...document.querySelectorAll('button')].filter(b=>/^(Dark|Light)$/.test(b.textContent.trim())).length" 2>/dev/null | tail -1)" "0"
check "no quick presets" \
  "$(agent-browser eval "[...document.querySelectorAll('button')].filter(b=>/^(Reel|Story|YouTube|Podcast)$/.test(b.textContent.trim())).length" 2>/dev/null | tail -1)" "0"
check "no first-run tip" \
  "$(agent-browser eval "document.body.innerText.includes('First run:') ? 'yes' : 'no'" 2>/dev/null | tail -1 | tr -d '"')" "no"
check "no dark theme applied" \
  "$(agent-browser eval "document.documentElement.dataset.theme ?? 'none'" 2>/dev/null | tail -1 | tr -d '"')" "none"

echo
[ $fails -eq 0 ] && echo "all green" || echo "$fails failure(s)"
exit $fails
