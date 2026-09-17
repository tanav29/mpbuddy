import { baseName, parseTime } from "./files";

export type ToolId = "compress" | "trim" | "mp3" | "convert";

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Inline Tabler icon SVG inner markup (24x24 outline paths). Rendered with stroke="currentColor". */
  icon: string;
  hint: string;
  /** File-picker filter so the dialog only shows media files relevant to this tool. */
  accept: string;
  outMime: (opts: Record<string, string>) => string;
  outName: (input: string, opts: Record<string, string>) => string;
  buildArgs: (input: string, output: string, opts: Record<string, string>) => string[];
  validate?: (opts: Record<string, string>) => string | null;
}

const IN = "in_src";
const OUT = "out_file";

const CRF: Record<string, string> = { high: "23", med: "28", low: "33" };

function scaleFilter(maxH: string): string[] {
  if (maxH === "orig") return [];
  const h = Number(maxH);
  if (!Number.isFinite(h)) return [];
  // Downscale only — never upscale a small clip.
  return ["-vf", `scale=-2:'min(${h}\\,ih)'`];
}

export const TOOLS: ToolDef[] = [
  {
    id: "compress",
    label: "Compress",
    icon: '<path d="M6 20.735a2 2 0 0 1 -1 -1.735v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-1" /><path d="M11 17a2 2 0 0 1 2 2v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-2a2 2 0 0 1 2 -2" /><path d="M11 5l-1 0" /><path d="M13 7l-1 0" /><path d="M11 9l-1 0" /><path d="M13 11l-1 0" /><path d="M11 13l-1 0" /><path d="M13 15l-1 0" />',
    hint: "Shrink video to H.264 MP4 for easy sharing.",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-compressed.mp4`,
    buildArgs: (input, output, o) => [
      "-i", input,
      ...scaleFilter(o.maxH ?? "720"),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF[o.quality ?? "med"] ?? "28",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      output,
    ],
  },
  {
    id: "trim",
    label: "Trim",
    icon: '<path d="M3 7a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M3 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M8.6 8.6l10.4 10.4" /><path d="M8.6 15.4l10.4 -10.4" />',
    hint: "Cut a section instantly — no re-encode.",
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.mp3,.m4a,.wav,.ogg,.oga,.aac,.flac",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-trimmed.mp4`,
    validate: (o) => {
      const s = parseTime(o.start ?? "");
      const e = parseTime(o.end ?? "");
      if (s == null && e == null) return "Enter a start and/or end time.";
      if (s != null && e != null && e <= s) return "End must be after start.";
      return null;
    },
    buildArgs: (input, output, o) => {
      const s = parseTime(o.start ?? "");
      const e = parseTime(o.end ?? "");
      const args: string[] = [];
      if (s != null) args.push("-ss", String(s));
      args.push("-i", input);
      if (s != null && e != null) args.push("-to", String(e - s));
      else if (e != null) args.push("-to", String(e));
      args.push("-c", "copy", "-movflags", "+faststart", output);
      return args;
    },
  },
  {
    id: "mp3",
    label: "MP3",
    icon: '<path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M9 17v-13h10v13" /><path d="M9 8h10" />',
    hint: "Extract audio from video as MP3.",
    accept: "audio/*,video/*,.mp3,.m4a,.wav,.ogg,.oga,.opus,.aac,.flac,.mp4,.m4v,.mov,.mkv,.webm",
    outMime: () => "audio/mpeg",
    outName: (n) => `${baseName(n)}.mp3`,
    buildArgs: (input, output, o) => [
      "-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", o.bitrate ?? "128k", output,
    ],
  },
  {
    id: "convert",
    label: "Convert",
    icon: '<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3" /><path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3" />',
    hint: "MP4, WebM, MP3 or GIF — plus vertical 9:16.",
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg,.mp3,.m4a,.wav,.ogg,.oga,.aac,.flac",
    outMime: (o) =>
      o.format === "mp3" ? "audio/mpeg" : o.format === "gif" ? "image/gif" : o.format === "webm" ? "video/webm" : "video/mp4",
    outName: (n, o) => `${baseName(n)}-converted.${o.format ?? "mp4"}`,
    buildArgs: (input, output, o) => {
      const fmt = o.format ?? "mp4";
      if (fmt === "mp3")
        return ["-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", output];
      if (fmt === "gif")
        return [
          "-i", input,
          "-vf", "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          output,
        ];
      const vf: string[] = [];
      if (o.shorts === "pad")
        vf.push("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1");
      else if (o.shorts === "crop") vf.push("crop=ih*9/16:ih,scale=1080:1920,setsar=1");
      if (fmt === "webm")
        return ["-i", input, ...(vf.length ? ["-vf", vf.join(",")] : []), "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus", output];
      return [
        "-i", input, ...(vf.length ? ["-vf", vf.join(",")] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
      ];
    },
  },
];

export { IN, OUT };
export function toolById(id: ToolId): ToolDef {
  return TOOLS.find((t) => t.id === id) ?? TOOLS[0]!;
}
