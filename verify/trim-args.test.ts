// Ad-hoc harness: print the real ffmpeg args the app would build, so they can
// be executed against a real file. Not part of the app build.
import { toolById } from "../src/tools";

const trim = toolById("trim");

const cases: { name: string; o: Record<string, string> }[] = [
  { name: "one middle cut", o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30", inputKind: "video" } },
  { name: "two cuts", o: { mode: "remove", cuts: "0:10-0:15|0:22.5-0:24", durationSec: "30", inputKind: "video" } },
  { name: "cut at head", o: { mode: "remove", cuts: "0-0:04", durationSec: "30", inputKind: "video" } },
  { name: "cut at tail", o: { mode: "remove", cuts: "0:26-0:30", durationSec: "30", inputKind: "video" } },
  { name: "overlapping cuts", o: { mode: "remove", cuts: "0:10-0:18|0:15-0:20", durationSec: "30", inputKind: "video" } },
  { name: "no duration known", o: { mode: "remove", cuts: "0:10-0:15", durationSec: "", inputKind: "video" } },
  { name: "silent video", o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30", inputKind: "video", hasAudio: "0" } },
  { name: "audio only", o: { mode: "remove", cuts: "0:10-0:15", durationSec: "30", inputKind: "audio" } },
  { name: "keep range (unchanged)", o: { start: "5", end: "12", exact: "off" } },
  { name: "keep range exact (unchanged)", o: { start: "5", end: "12", exact: "on" } },
];

const out: Record<string, unknown> = {};
for (const c of cases) {
  const inputKind = c.o.inputKind ?? "video";
  const name = inputKind === "audio" ? "in_src.mp3" : "in_src.mp4";
  const outName = `out_file.${extOfName(trim.outName("clip.mp4", { ...c.o, inputKind }))}`;
  out[c.name] = {
    args: trim.buildArgs(name, outName, { hasAudio: "1", ...c.o }),
    out: outName,
    validate: trim.validate?.(c.o) ?? null,
  };
}

function extOfName(n: string): string {
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1) : "";
}

console.log(JSON.stringify(out, null, 2));
