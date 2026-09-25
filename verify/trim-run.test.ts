// Ad-hoc harness: run the app's real ffmpeg args against real files, then
// check the output's duration *and* its picture content frame-by-frame.
//   bun run verify/trim-run.test.ts
// Not part of the app build.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { toolById } from "../src/tools";

const DIR = "/tmp/opencode/mpb-verify";
const DUR = 30;
const trim = toolById("trim");

function ff(args: string[]): Buffer {
  // cwd = DIR with bare names mirrors ffmpeg.wasm's MEMFS working directory.
  return execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  });
}
function probe(file: string): { dur: number; v: number; a: number } {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type",
    "-of", "json", file,
  ], { cwd: DIR }).toString();
  const j = JSON.parse(out) as { format: { duration: string }; streams: { codec_type: string }[] };
  return {
    dur: Number(j.format.duration),
    v: j.streams.filter((s) => s.codec_type === "video").length,
    a: j.streams.filter((s) => s.codec_type === "audio").length,
  };
}
/** 16x16 grayscale frame at time t, as raw bytes. */
function frame(file: string, t: number): Buffer {
  return ff([
    "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", "scale=16:16", "-pix_fmt", "gray", "-f", "rawvideo", "-",
  ]);
}
/** Mean absolute difference between two frames, 0..255. */
function diff(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// testsrc2 has a frame-unique pattern, so any timeline shift shows up in the
// comparison below; the tone gives us an audio stream to trim against.
ff([
  "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
  "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-t", String(DUR),
  `in_src.mp4`,
]);
ff([
  "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=30",
  "-an", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-t", String(DUR), `silent.mp4`,
]);
ff(["-i", "in_src.mp4", "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "in_src.mp3"]);

/** cuts: the marked sections; kept: [output time, source time] pairs to compare. */
const cases: {
  name: string; src: string; o: Record<string, string>;
  wantDur: number; wantAudio: number; kept: [number, number][];
}[] = [
  {
    name: "one middle cut", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30" },
    wantDur: 25, wantAudio: 1, kept: [[1, 1], [9.5, 9.5], [12, 17], [20, 25], [24.5, 29.5]],
  },
  {
    name: "two cuts", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:10-0:15|0:22.5-0:24", durationSec: "30" },
    wantDur: 23.5, wantAudio: 1, kept: [[1, 1], [9, 9], [12, 17], [15, 20], [20, 26.5]],
  },
  {
    name: "cut at head", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0-0:04", durationSec: "30" },
    wantDur: 26, wantAudio: 1, kept: [[0.2, 4.2], [10, 14], [25, 29]],
  },
  {
    name: "cut at tail", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:26-0:30", durationSec: "30" },
    wantDur: 26, wantAudio: 1, kept: [[1, 1], [20, 20], [25, 25]],
  },
  {
    name: "overlapping cuts merge", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:10-0:18|0:15-0:20", durationSec: "30" },
    wantDur: 20, wantAudio: 1, kept: [[1, 1], [9, 9], [12, 22], [19, 29]],
  },
  {
    name: "sub-0.5s cut", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:10-0:10.4", durationSec: "30" },
    wantDur: 29.6, wantAudio: 1, kept: [[1, 1], [9, 9], [12, 12.4]],
  },
  {
    name: "duration unknown", src: "in_src.mp4",
    o: { mode: "remove", cuts: "0:10-0:15", durationSec: "" },
    wantDur: 25, wantAudio: 1, kept: [[1, 1], [12, 17], [24, 29]],
  },
  {
    name: "silent source, no audio", src: "silent.mp4",
    o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30", hasAudio: "0" },
    wantDur: 25, wantAudio: 0, kept: [[1, 1], [12, 17], [24, 29]],
  },
  {
    name: "audio only", src: "in_src.mp3",
    o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30", inputKind: "audio" },
    wantDur: 25, wantAudio: 1, kept: [],
  },
  {
    name: "keep range copy", src: "in_src.mp4",
    o: { start: "5", end: "12", exact: "off", durationSec: "30" },
    wantDur: 7, wantAudio: 1, kept: [[0.5, 5.5], [3, 8], [6, 11]],
  },
  {
    name: "keep range exact", src: "in_src.mp4",
    o: { start: "5", end: "12", exact: "on", durationSec: "30" },
    wantDur: 7, wantAudio: 1, kept: [[0.5, 5.5], [3, 8], [6, 11]],
  },
];

let fails = 0;
for (const [i, c] of cases.entries()) {
  const srcPath = c.src;
  const isAudio = c.o.inputKind === "audio";
  const opts: Record<string, string> = {
    hasAudio: "1", inputKind: isAudio ? "audio" : "video", ...c.o,
  };
  const outName = `out${i}.${isAudio ? "m4a" : "mp4"}`;
  const target = outName;
  const invalid = trim.validate?.(c.o) ?? null;

  let err: string | null = null;
  try {
    // Exactly what App.processOne hands to runFFmpeg: bare MEMFS names.
    ff(trim.buildArgs(c.src, outName, opts));
  } catch (e) {
    const msg = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    err = msg.split("\n").filter((l) => l.trim())[0] ?? "failed";
  }

  const notes: string[] = [];
  if (err) {
    fails++;
    console.log(`FAIL  ${c.name.padEnd(23)} ${err.slice(0, 100)}`);
    continue;
  }
  const p = probe(target);
  if (Math.abs(p.dur - c.wantDur) > 0.35) {
    fails++;
    notes.push(`dur ${p.dur.toFixed(2)}s != ${c.wantDur}s`);
  }
  if (p.a !== c.wantAudio) {
    fails++;
    notes.push(`audio streams ${p.a} != ${c.wantAudio}`);
  }
  if (isAudio ? p.v !== 0 : p.v !== 1) {
    fails++;
    notes.push(`video streams ${p.v} != ${isAudio ? 0 : 1}`);
  }
  for (const [outT, srcT] of c.kept) {
    if (outT >= p.dur - 0.1) continue;
    const d = diff(frame(target, outT), frame(srcPath, srcT));
    notes.push(`frame@${outT}s vs src@${srcT}s Δ${d.toFixed(1)}`);
    if (d > 12) fails++;
  }
  const kb = (statSync(`${DIR}/${target}`).size / 1024).toFixed(0);
  console.log(
    `${notes.some((n) => n.includes("!=") || Number(n.match(/Δ([\d.]+)/)?.[1] ?? 0) > 12) ? "FAIL  " : "PASS  "}` +
      `${c.name.padEnd(23)} dur=${p.dur.toFixed(2)}s v=${p.v} a=${p.a} ${kb}KB` +
      (notes.length ? `\n        ${notes.join("\n        ")}` : "") +
      (invalid ? `\n        [validate: ${invalid}]` : ""),
  );
}
console.log(fails === 0 ? "\nall green" : `\n${fails} problem(s)`);
rmSync(DIR, { recursive: true, force: true });
