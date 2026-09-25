// bun run verify/trim-units.test.ts
import { clampRanges, fmtRanges, keptSegments, mergeRanges, parseRanges } from "../src/files";
import { toolById, trimCuts } from "../src/tools";

let fails = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    fails++;
    console.log(`FAIL  ${label}\n        got  ${a}\n        want ${b}`);
  } else {
    console.log(`PASS  ${label}`);
  }
};

// --- round trip -----------------------------------------------------------
eq(fmtRanges(parseRanges("0:12.5-0:18|0:30-0:31.5")), "0:12.5-0:18|0:30-0:31.5", "round trip");
eq(parseRanges(""), [], "empty string");
eq(parseRanges("junk"), [], "junk");
eq(parseRanges("0:12-"), [], "missing end");
eq(parseRanges("0:18-0:12"), [{ a: 12, b: 18 }], "flipped ends swap");
eq(parseRanges("12-18"), [{ a: 12, b: 18 }], "plain seconds");
eq(parseRanges("0:12-0:18|bad|40-42"), [{ a: 12, b: 18 }, { a: 40, b: 42 }], "bad piece skipped");

// --- merge ----------------------------------------------------------------
eq(mergeRanges([{ a: 10, b: 15 }, { a: 20, b: 25 }]), [{ a: 10, b: 15 }, { a: 20, b: 25 }], "disjoint kept");
eq(
  mergeRanges([{ a: 10, b: 18 }, { a: 15, b: 20 }]),
  [{ a: 10, b: 20 }],
  "overlap fuses",
);
eq(
  mergeRanges([{ a: 10, b: 15 }, { a: 12, b: 20 }, { a: 18, b: 30 }]),
  [{ a: 10, b: 30 }],
  "chain of overlaps fuses into one",
);
eq(mergeRanges([{ a: 10, b: 10.05 }]), [], "sliver dropped");
eq(mergeRanges([{ a: 5, b: 9 }, { a: 1, b: 4 }]), [{ a: 5, b: 9 }, { a: 1, b: 4 }], "order preserved");
eq(
  mergeRanges([{ a: 1, b: 4 }, { a: 3, b: 6 }]),
  [{ a: 1, b: 6 }],
  "merge lands at the first slot, not the end",
);

// --- clamp ----------------------------------------------------------------
eq(clampRanges([{ a: -5, b: 40 }], 30), [{ a: 0, b: 30 }], "clamped to duration");
eq(clampRanges([{ a: 5, b: 40 }], null), [{ a: 5, b: 40 }], "null duration leaves the top open");
eq(clampRanges([{ a: 28, b: 45 }], 30), [{ a: 28, b: 30 }], "tail trimmed to duration");
eq(clampRanges([{ a: 32, b: 40 }], 30), [], "entirely past the end");

// --- kept segments --------------------------------------------------------
eq(keptSegments([], 30), [{ a: 0, b: 30 }], "no cuts keeps everything");
eq(keptSegments([{ a: 10, b: 15 }], 30), [{ a: 0, b: 10 }, { a: 15, b: 30 }], "middle cut");
eq(keptSegments([{ a: 0, b: 4 }], 30), [{ a: 4, b: 30 }], "head cut leaves one span");
eq(keptSegments([{ a: 26, b: 30 }], 30), [{ a: 0, b: 26 }], "tail cut leaves one span");
eq(keptSegments([{ a: 0, b: 30 }], 30), [], "cut everything leaves nothing");
eq(keptSegments([{ a: 5, b: 6 }], null), [{ a: 0, b: 5 }, { a: 6, b: null }], "open-ended last span");
eq(
  keptSegments([{ a: 0, b: 4 }, { a: 10, b: 14 }], 30),
  [{ a: 4, b: 10 }, { a: 14, b: 30 }],
  "two cuts",
);
eq(keptSegments([{ a: 10, b: 20 }], 10), [{ a: 0, b: 10 }], "raw call leaves a cut that starts past the file");
// The pipeline clamps first (trimCuts), so a cut that only grazes the final
// instant clamps away and the file is untouched.
eq(keptSegments(trimCuts({ cuts: "0:10-0:20", durationSec: "10" }), 10), [{ a: 0, b: 10 }], "grazing cut clamps away");
eq(keptSegments(trimCuts({ cuts: "0-0:10", durationSec: "10" }), 10), [], "a covering cut leaves nothing");

// --- trimCuts (what the ffmpeg graph uses) --------------------------------
eq(trimCuts({ cuts: "0:20-0:25|0:10-0:15", durationSec: "30" }), [
  { a: 10, b: 15 },
  { a: 20, b: 25 },
], "sorted for the graph");
eq(trimCuts({ cuts: "0:10-0:15", durationSec: "" }), [{ a: 10, b: 15 }], "blank duration = unknown");
eq(trimCuts({ cuts: "0:10-0:15" }), [{ a: 10, b: 15 }], "absent duration = unknown");

// --- validation -----------------------------------------------------------
const v = (o: Record<string, string>) => toolById("trim").validate?.(o) ?? null;
eq(v({ mode: "remove", cuts: "" }), "Mark at least one section to remove.", "no cuts");
eq(v({ mode: "remove", cuts: "0:12-0:12" }), "Each section needs an end after its start.", "zero length");
eq(v({ mode: "remove", cuts: "0:40-0:45", durationSec: "30" }), "Those sections fall outside the video.", "past the end");
eq(v({ mode: "remove", cuts: "0-0:30", durationSec: "30" }), "That removes everything — keep a little.", "removes all");
eq(v({ mode: "remove", cuts: "0:10-0:15", durationSec: "30" }), null, "valid cut");
eq(v({ mode: "remove", cuts: "0:29.9-0:31", durationSec: "30" }), null, "valid cut past the end");
eq(v({ start: "", end: "" }), "Enter a start and/or end time.", "keep mode: nothing entered");
eq(v({ start: "10", end: "5" }), "End must be after start.", "keep mode: inverted");
eq(v({ start: "5" }), null, "keep mode: start only");
eq(v({ mode: "remove", cuts: "0:10-0:15" }), null, "remove mode ignores start/end");

console.log(fails === 0 ? "\nall green" : `\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
