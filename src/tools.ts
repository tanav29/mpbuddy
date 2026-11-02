import {
  MIN_CUT,
  baseName,
  clampRanges,
  extOf,
  keptSegments,
  mergeRanges,
  parseRanges,
  parseTime,
  type Range,
} from "./files";

export type ToolId =
  | "compress"
  | "trim"
  | "mp3"
  | "convert"
  | "crop"
  | "thumbnail"
  | "rotate"
  | "speed"
  | "volume"
  | "fade"
  | "merge"
  | "loop"
  | "reverse"
  | "resize"
  | "filter"
  | "frames"
  | "image"
  | "tosize"
  | "mute"
  | "acut"
  | "denoise"
  | "isolate"
  | "wave"
  | "watermark"
  | "heic"
  | "passport"
  | "fliph"
  | "flipv"
  | "metadata";

/** Index-page section a tool is filed under. */
export type ToolGroupId = "share" | "cut" | "look" | "sound" | "still";

/** Ordered sections for the tools index — one short line each, nothing more. */
export const TOOL_GROUPS: { id: ToolGroupId; title: string }[] = [
  { id: "share", title: "Shrink & share" },
  { id: "cut", title: "Cut & stitch" },
  { id: "look", title: "Crop & style" },
  { id: "sound", title: "Sound" },
  { id: "still", title: "Stills" },
];

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Which index section this tool is filed under. */
  group: ToolGroupId;
  /**
   * Extra words the index search should match. People search for the job
   * ("shrink", "vertical", "music"), never for our option names.
   */
  keywords: string[];
  /** Inline Tabler icon SVG inner markup (24x24 outline paths). Rendered with stroke="currentColor". */
  icon: string;
  hint: string;
  /** Verb phrase for the run button: what the tool will do, in the user's words. */
  action: (opts: Record<string, string>) => string;
  /** File-picker filter so the dialog only shows media files relevant to this tool. */
  accept: string;
  outMime: (opts: Record<string, string>) => string;
  outName: (input: string, opts: Record<string, string>) => string;
  buildArgs: (input: string, output: string, opts: Record<string, string>) => string[];
  validate?: (opts: Record<string, string>) => string | null;
  /** Built args may need a second pass with `hasAudio: "0"` (no audio stream to filter). */
  probeAudio?: boolean;
  /** Merge-style tool: one run over the picked file plus the batch queue. */
  multiInput?: boolean;
  /** Multi-input arg builder. `inputs` are the wasm-side names, in pick order. */
  buildArgsList?: (inputs: string[], output: string, opts: Record<string, string>) => string[];
  /** Produces a numbered burst (frames_%03d.png) instead of one output file. */
  burst?: boolean;
  /** Which file kinds this tool accepts — anything else is rejected up front. */
  acceptKind?: "media" | "image";
  /** Index badge: "new" flags tools added recently. */
  badge?: "new";
  /**
   * Browser-native path, when the job needs no ffmpeg (e.g. HEIC decoding via
   * libheif.js). When set, the runner calls this instead of buildArgs.
   */
  browser?: (file: File, opts: Record<string, string>) => Promise<Blob>;
}

const IN = "in_src";
const OUT = "out_file";

const CRF: Record<string, string> = { high: "23", med: "28", low: "33" };

function num(v: string | undefined, fallback: number): number {
  const t = (v ?? "").trim();
  // Number("") is 0 — a blank option means "unknown", not zero.
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

function targetVideoKbps(o: Record<string, string>, audioKbps: number): string | null {
  const target = o.targetMB ?? "off";
  if (target === "off") return null;
  const mb = Number(target);
  const duration = num(o.durationSec, 0);
  if (!Number.isFinite(mb) || mb <= 0 || duration <= 0.1) return null;
  const totalKbps = ((mb * 8192) / duration) * 0.95;
  const videoKbps = Math.max(180, Math.floor(totalKbps - audioKbps));
  return `${videoKbps}k`;
}

function scaleFilter(maxH: string): string[] {
  if (maxH === "orig") return [];
  const h = Number(maxH);
  if (!Number.isFinite(h)) return [];
  // Downscale only — never upscale a small clip.
  return ["-vf", `scale=-2:'min(${h}\\,ih)'`];
}

/**
 * Bitrate that lands a clip under a size cap (with headroom for the container).
 * Null when the duration is unknown — the caller falls back to a CRF encode.
 */
function fitKbps(targetMB: string, durationSec: string, audioKbps: number): { kbps: number } | null {
  const mb = Number(targetMB);
  const duration = num(durationSec, 0);
  if (!Number.isFinite(mb) || mb <= 0 || duration <= 0.5) return null;
  const totalKbps = ((mb * 8192) / duration) * 0.92;
  return { kbps: Math.max(150, Math.floor(totalKbps - audioKbps)) };
}

/**
 * Audio codec + extension for tools that output sound. `preset` forces a
 * format (the Audio cutter's options); without one the input's own container
 * is reused, so a video keeps its file type and a WAV stays a WAV.
 */
function audioOut(input: string, preset?: string): { ext: string; args: string[] } {
  if (preset === "mp3") return { ext: "mp3", args: ["-c:a", "libmp3lame", "-b:a", "192k"] };
  if (preset === "wav") return { ext: "wav", args: ["-c:a", "pcm_s16le"] };
  if (preset === "m4r") return { ext: "m4r", args: ["-c:a", "aac", "-b:a", "192k", "-f", "ipod"] };
  if (preset === "m4a") return { ext: "m4a", args: ["-c:a", "aac", "-b:a", "192k"] };
  switch (extOf(input)) {
    case "mp3": return { ext: "mp3", args: ["-c:a", "libmp3lame", "-b:a", "192k"] };
    case "wav": return { ext: "wav", args: ["-c:a", "pcm_s16le"] };
    case "flac": return { ext: "flac", args: ["-c:a", "flac"] };
    case "ogg":
    case "oga":
    case "opus": return { ext: extOf(input), args: ["-c:a", "libopus", "-b:a", "160k"] };
    case "aac": return { ext: "aac", args: ["-c:a", "aac", "-b:a", "192k"] };
    case "m4r": return { ext: "m4r", args: ["-c:a", "aac", "-b:a", "192k", "-f", "ipod"] };
    case "webm": return { ext: "webm", args: ["-c:a", "libopus", "-b:a", "160k"] };
    case "mp4":
    case "m4v":
    case "mov":
    case "mkv":
      return { ext: extOf(input), args: ["-c:a", "aac", "-b:a", "192k"] };
    default: return { ext: "m4a", args: ["-c:a", "aac", "-b:a", "192k"] };
  }
}

/** Tail args for tools that re-encode only the sound: copy the picture track. */
function audioToolTail(input: string, kind: string): string[] {
  if (kind === "audio") return ["-vn", ...audioOut(input).args];
  return ["-c:v", "copy"];
}

/** Mime for each audio extension acut can assume. */
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  m4r: "audio/mp4",
};

/** Passport / ID photo stock sizes: crop ratio in mm (or inches) + output px @300 DPI. */
export const PASSPORT_SIZES: (readonly [string, string, string])[] = [
  ["35x45", "35×45 mm", "413 × 531 px"],
  ["2x2in", "2×2 in", "600 × 600 px"],
  ["30x40", "30×40 mm", "354 × 472 px"],
  ["33x48", "33×48 mm", "390 × 567 px"],
];

export const PASSPORT_MAP: Record<string, { W: number; H: number; pw: number; ph: number }> = {
  "35x45": { W: 35, H: 45, pw: 413, ph: 531 },
  "2x2in": { W: 1, H: 1, pw: 600, ph: 600 },
  "30x40": { W: 30, H: 40, pw: 354, ph: 472 },
  "33x48": { W: 33, H: 48, pw: 390, ph: 567 },
};

/** Crop-to-ratio presets. Value is "W:H" (ffmpeg-evaluated) or "custom". */
export const CROP_RATIOS: [string, string, string][] = [
  ["9:16", "Shorts", "9:16"],
  ["1:1", "Square", "1:1"],
  ["3:4", "Portrait", "3:4"],
  ["16:9", "Video", "16:9"],
  ["143:100", "IMAX", "1.43:1"],
  ["custom", "Custom", "W:H"],
];

/** GIF runs at 12fps with a 256-colour palette, so long clips explode in size. */
export const GIF_MAX_SEC = 10;

/** Convert targets, shared by the picker and the run-button label. */
export const OUTPUT_FORMATS: [string, string][] = [
  ["mp4", "MP4"],
  ["webm", "WebM"],
  ["mp3", "MP3"],
  ["gif", "GIF"],
];

const CROP_SLUG: Record<string, string> = {
  "9:16": "9x16",
  "1:1": "1x1",
  "3:4": "3x4",
  "16:9": "16x9",
  "143:100": "imax",
};

/** Resolve target W:H from crop opts. Null when custom is invalid. */
export function cropWH(o: Record<string, string>): { W: number; H: number } | null {
  if (o.ratio === "custom") {
    const W = Number(o.customW);
    const H = Number(o.customH);
    if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
    return { W, H };
  }
  const parts = String(o.ratio ?? "9:16").split(":");
  const W = Number(parts[0]);
  const H = Number(parts[1]);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
  return { W, H };
}

export function cropSlug(o: Record<string, string>): string {
  if (o.ratio === "custom") {
    const wh = cropWH(o);
    if (!wh) return "custom";
    const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(n).replace(".", "p"));
    return `${fmt(wh.W)}x${fmt(wh.H)}`;
  }
  return CROP_SLUG[o.ratio ?? "9:16"] ?? "crop";
}

/** "keep" = one kept range, "remove" = cut sections out of the middle. */
export type TrimMode = "keep" | "remove";

export function trimMode(o: Record<string, string>): TrimMode {
  return o.mode === "remove" ? "remove" : "keep";
}

/** The sections to cut, normalised for the filter graph (in time order). */
export function trimCuts(o: Record<string, string>): Range[] {
  const dur = num(o.durationSec, Number.NaN);
  return clampRanges(mergeRanges(parseRanges(o.cuts ?? "")), Number.isFinite(dur) ? dur : null)
    .sort((x, y) => x.a - y.a);
}

/** ffmpeg seconds: short, exact, no exponent. */
function fsec(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Drop the marked sections in a single pass: trim each surviving span, then
 * concat them back to back. Concat emits decoded frames, so — unlike the
 * keep-a-range path — this always re-encodes; stream copy cannot splice.
 */
function cutArgs(input: string, output: string, o: Record<string, string>): string[] {
  const dur = num(o.durationSec, Number.NaN);
  const segs = keptSegments(trimCuts(o), Number.isFinite(dur) ? dur : null);
  const withVideo = o.inputKind !== "audio";
  const withAudio = o.hasAudio !== "0";
  if (segs.length === 0)
    throw new Error("Every section is marked for removal — nothing left to keep.");

  const spans = segs.map((sg) =>
    sg.b == null ? `start=${fsec(sg.a)}` : `start=${fsec(sg.a)}:end=${fsec(sg.b)}`,
  );
  const parts: string[] = [];
  if (segs.length === 1) {
    // Nothing to stitch back together — a plain trim, no concat pass.
    if (withVideo) parts.push(`[0:v]trim=${spans[0]},setpts=PTS-STARTPTS[v]`);
    if (withAudio) parts.push(`[0:a]atrim=${spans[0]},asetpts=PTS-STARTPTS[a]`);
  } else {
    segs.forEach((_, i) => {
      if (withVideo) parts.push(`[0:v]trim=${spans[i]},setpts=PTS-STARTPTS[v${i}]`);
      if (withAudio) parts.push(`[0:a]atrim=${spans[i]},asetpts=PTS-STARTPTS[a${i}]`);
    });
    const ins = segs
      .map((_, i) => (withVideo ? `[v${i}]` : "") + (withAudio ? `[a${i}]` : ""))
      .join("");
    parts.push(
      `${ins}concat=n=${segs.length}:v=${withVideo ? 1 : 0}:a=${withAudio ? 1 : 0}` +
        `${withVideo ? "[v]" : ""}${withAudio ? "[a]" : ""}`,
    );
  }

  const args = ["-i", input, "-filter_complex", parts.join(";")];
  if (withVideo) args.push("-map", "[v]");
  if (withAudio) args.push("-map", "[a]");
  if (withVideo) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
  else args.push("-vn");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-movflags", "+faststart", output);
  return args;
}

/** Center-crop to an aspect ratio without stretching. Even dims for H.264. */
export function cropFilter(W: number, H: number, fx = 0.5, fy = 0.5): string {
  const x = Math.max(0, Math.min(1, fx));
  const y = Math.max(0, Math.min(1, fy));
  return (
    `crop='floor(min(iw,ih*${W}/${H})/2)*2':'floor(min(ih,iw*${H}/${W})/2)*2':'(iw-ow)*${x}':'(ih-oh)*${y}'` +
    `,setsar=1`
  );
}

export const TOOLS: ToolDef[] = [
  {
    id: "fliph", label: "Flip horizontal", group: "look", badge: "new",
    keywords: ["mirror", "selfie", "horizontal", "left", "right"],
    icon: '<path d="M12 3v18" /><path d="M9 6l-6 6l6 6z" /><path d="M15 6l6 6l-6 6z" />',
    hint: "Mirror a video from left to right.", action: () => "Flip horizontally",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi", outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-flipped-horizontal.mp4`,
    buildArgs: (input, output) => ["-i", input, "-vf", "hflip", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output],
  },
  {
    id: "flipv", label: "Flip vertical", group: "look", badge: "new",
    keywords: ["mirror", "vertical", "upside down", "top", "bottom"],
    icon: '<path d="M3 12h18" /><path d="M6 9l6 -6l6 6z" /><path d="M6 15l6 6l6 -6z" />',
    hint: "Flip a video from top to bottom.", action: () => "Flip vertically",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi", outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-flipped-vertical.mp4`,
    buildArgs: (input, output) => ["-i", input, "-vf", "vflip", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output],
  },
  {
    id: "metadata", label: "Remove metadata", group: "share", badge: "new",
    keywords: ["privacy", "metadata", "location", "tags", "strip", "clean"],
    icon: '<path d="M12 3l8 4v5c0 5 -3 8 -8 9c-5 -1 -8 -4 -8 -9v-5z" /><path d="M9 12l2 2l4 -4" />',
    hint: "Remove common tags from a video before sharing.", action: () => "Remove metadata",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi", outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-clean.mp4`,
    buildArgs: (input, output) => ["-i", input, "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output],
  },

  {
    id: "compress",
    label: "Compress",
    group: "share",
    keywords: ["shrink", "smaller", "reduce", "size", "lighter", "whatsapp", "instagram"],
    icon: '<path d="M6 20.735a2 2 0 0 1 -1 -1.735v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-1" /><path d="M11 17a2 2 0 0 1 2 2v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-2a2 2 0 0 1 2 -2" /><path d="M11 5l-1 0" /><path d="M13 7l-1 0" /><path d="M11 9l-1 0" /><path d="M13 11l-1 0" /><path d="M11 13l-1 0" /><path d="M13 15l-1 0" />',
    hint: "Shrink video to H.264 MP4 for easy sharing.",
    action: () => "Compress video",
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
    id: "tosize",
    label: "Target size",
    group: "share",
    keywords: ["cap", "fit", "limit", "mb", "10mb", "25mb", "50mb", "email", "discord", "whatsapp", "upload limit"],
    icon: '<path d="M4 4v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M12 16v5" /><path d="M9 18l3 3l3-3" />',
    hint: "Fit a video under 10, 25 or 50 MB for attachments.",
    action: (o) => `Fit under ${o.targetMB ?? "10"} MB`,
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.targetMB ?? "10"}mb.mp4`,
    validate: (o) => (num(o.durationSec, 0) > 0 ? null : "Pick the file first so we can plan the bitrate."),
    buildArgs: (input, output, o) => {
      const fit = fitKbps(o.targetMB ?? "10", o.durationSec ?? "", 96);
      return [
        "-i", input,
        ...scaleFilter(o.maxH ?? "720"),
        "-c:v", "libx264", "-preset", "slow",
        ...(fit
          ? ["-b:v", `${fit.kbps}k`, "-maxrate", `${Math.round(fit.kbps * 1.45)}k`, "-bufsize", `${fit.kbps * 2}k`]
          : ["-crf", "26"]),
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        output,
      ];
    },
  },
  {
    id: "trim",
    label: "Trim",
    group: "cut",
    keywords: ["cut", "clip", "segment", "start", "end", "time", "range", "shorten", "remove"],
    icon: '<path d="M3 7a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M3 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M8.6 8.6l10.4 10.4" /><path d="M8.6 15.4l10.4 -10.4" />',
    hint: "Keep a range, or cut sections out of the middle.",
    action: (o) => (trimMode(o) === "remove" ? "Cut these sections out" : "Keep this range"),
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.mp3,.m4a,.wav,.ogg,.oga,.aac,.flac",
    outMime: (o) =>
      trimMode(o) === "remove" && o.inputKind === "audio" ? "audio/mp4" : "video/mp4",
    outName: (n, o) => {
      if (trimMode(o) !== "remove") return `${baseName(n)}-trimmed.mp4`;
      return `${baseName(n)}-cut${o.inputKind === "audio" ? ".m4a" : ".mp4"}`;
    },
    probeAudio: true,
    validate: (o) => {
      if (trimMode(o) === "remove") {
        const raw = parseRanges(o.cuts ?? "");
        if (raw.length === 0) return "Mark at least one section to remove.";
        if (raw.some((r) => r.b - r.a < MIN_CUT)) return "Each section needs an end after its start.";
        const dur = num(o.durationSec, Number.NaN);
        const cuts = trimCuts(o);
        if (cuts.length === 0) return "Those sections fall outside the video.";
        if (Number.isFinite(dur) && keptSegments(cuts, dur).length === 0)
          return "That removes everything — keep a little.";
        return null;
      }
      const s = parseTime(o.start ?? "");
      const e = parseTime(o.end ?? "");
      if (s == null && e == null) return "Enter a start and/or end time.";
      if (s != null && e != null && e <= s) return "End must be after start.";
      return null;
    },
    buildArgs: (input, output, o) => {
      if (trimMode(o) === "remove") return cutArgs(input, output, o);
      const s = parseTime(o.start ?? "");
      const e = parseTime(o.end ?? "");
      const exact = o.exact === "on";
      const args: string[] = [];
      if (!exact && s != null) args.push("-ss", String(s));
      args.push("-i", input);
      if (exact && s != null) args.push("-ss", String(s));
      if (s != null && e != null) args.push("-t", String(e - s));
      else if (e != null) args.push("-to", String(e));
      if (exact) {
        args.push(
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", output,
        );
      } else {
        args.push("-c", "copy", "-movflags", "+faststart", output);
      }
      return args;
    },
  },
  {
    id: "acut",
    label: "Audio cut",
    group: "cut",
    keywords: ["audio cutter", "ringtone", "m4r", "iphone", "song clip", "trim audio", "cut music", "mp3", "snip"],
    icon: '<path d="M9 18V5l10-2v11" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="14" r="3" />',
    hint: "Snip an M4A / MP3 / WAV — or a ≤40 s iPhone ringtone.",
    action: (o) => `Cut the audio as ${(o.format ?? "m4a").toUpperCase()}`,
    accept: "audio/*,video/*,.mp3,.m4a,.m4r,.wav,.flac,.ogg,.oga,.aac,.mp4,.m4v,.mov,.mkv,.webm",
    outMime: (o) => AUDIO_MIME[o.format ?? "m4a"] ?? "audio/mp4",
    outName: (n, o) => `${baseName(n)}-cut.${o.format === "m4r" ? "m4r" : audioOut(n, o.format ?? "m4a").ext}`,
    validate: (o) => {
      const s = parseTime(o.start ?? "");
      const e = parseTime(o.end ?? "");
      if (s != null && e != null && e <= s) return "End must be after start.";
      return null;
    },
    buildArgs: (input, output, o) => {
      const s = parseTime(o.start ?? "") ?? 0;
      // iPhone ringtones must stay under 40 s; blank end = first 30 s.
      const eRaw = parseTime(o.end ?? "") ?? Math.min(40, s + 30);
      const dur = Math.min(40, Math.max(0.5, eRaw - s));
      const args: string[] = ["-ss", String(s), "-i", input, "-t", String(dur), "-vn"];
      if (o.fades === "on")
        args.push("-af", `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, dur - 0.5)}:d=0.5`);
      args.push(...audioOut(input, o.format ?? "m4a").args, output);
      return args;
    },
  },
  {
    id: "mp3",
    label: "MP3",
    group: "share",
    keywords: ["audio", "extract", "sound", "music", "song", "voice", "m4a", "wav"],
    icon: '<path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M9 17v-13h10v13" /><path d="M9 8h10" />',
    hint: "Extract audio from video as MP3.",
    action: () => "Extract MP3",
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
    group: "share",
    keywords: ["format", "transcode", "mp4", "webm", "mp3", "gif", "vertical", "9:16", "shorts", "size"],
    icon: '<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3" /><path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3" />',
    hint: "MP4, WebM, MP3 or GIF — plus vertical 9:16 and target size.",
    action: (o) => {
      const fmt = o.format ?? "mp4";
      return `Convert to ${OUTPUT_FORMATS.find(([v]) => v === fmt)?.[1] ?? "MP4"}`;
    },
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
          "-t", String(GIF_MAX_SEC),
          "-vf", "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          output,
        ];
      const vf: string[] = [];
      if (o.shorts === "pad")
        vf.push("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1");
      else if (o.shorts === "crop") vf.push("crop=ih*9/16:ih,scale=1080:1920,setsar=1");
      if (fmt === "webm")
        return [
          "-i", input, ...(vf.length ? ["-vf", vf.join(",")] : []),
          "-c:v", "libvpx-vp9", ...(targetVideoKbps(o, 96) ? ["-b:v", targetVideoKbps(o, 96)!] : ["-crf", "30", "-b:v", "0"]),
          ...(o.audio === "mute" ? ["-an"] : ["-c:a", "libopus"]),
          output,
        ];
      return [
        "-i", input, ...(vf.length ? ["-vf", vf.join(",")] : []),
        "-c:v", "libx264", "-preset", "veryfast",
        ...(targetVideoKbps(o, 128) ? ["-b:v", targetVideoKbps(o, 128)!] : ["-crf", "23"]),
        ...(o.audio === "mute" ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"]),
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "mute",
    label: "Mute",
    group: "sound",
    keywords: ["remove audio", "no sound", "silent", "strip audio", "delete sound", "quiet"],
    icon: '<path d="M6 15h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5a.8.8 0 0 1 1.5.5v13a.8.8 0 0 1-1.5.5L6 15" /><path d="M16 10l4 4" /><path d="M20 10l-4 4" />',
    hint: "Remove the sound track, keeping the picture untouched.",
    action: () => "Remove the audio",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-muted.mp4`,
    validate: (o) => (o.inputKind === "audio" ? "This file has no picture — use Volume instead." : null),
    buildArgs: (input, output) => ["-i", input, "-c:v", "copy", "-an", "-movflags", "+faststart", output],
  },
  {
    id: "crop",
    label: "Crop",
    group: "look",
    keywords: ["aspect", "ratio", "vertical", "9:16", "square", "shorts", "reels", "tiktok", "imax", "framing"],
    icon: '<path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22v-14a2 2 0 0 0 -2 -2h-14" />',
    hint: "Center-crop to Shorts, Square, IMAX & more — no stretch.",
    action: (o) => {
      const name = CROP_RATIOS.find(([v]) => v === (o.ratio ?? "9:16"))?.[1];
      return o.ratio === "custom" ? "Crop video" : `Crop to ${name ?? "ratio"}`;
    },
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${cropSlug(o)}.mp4`,
    validate: (o) => {
      if (o.ratio === "custom" && !cropWH(o)) return "Enter a custom W and H greater than 0.";
      return null;
    },
    buildArgs: (input, output, o) => {
      const wh = cropWH(o) ?? { W: 9, H: 16 };
      const fx = num(o.focalX, 50) / 100;
      const fy = num(o.focalY, 50) / 100;
      return [
        "-i", input,
        "-vf", cropFilter(wh.W, wh.H, fx, fy),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output,
      ];
    },
  },
  {
    id: "thumbnail",
    label: "Thumbnail",
    group: "share",
    keywords: ["frame", "cover", "still", "screenshot", "poster", "jpg", "grab"],
    icon: '<path d="M5 4m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z" /><path d="M10 9l5 3l-5 3z" />',
    hint: "Export a frame as JPG for thumbnails and covers.",
    action: () => "Export frame as JPG",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "image/jpeg",
    outName: (n) => `${baseName(n)}-thumb.jpg`,
    buildArgs: (input, output, o) => [
      "-ss", String(parseTime(o.frameAt ?? "") ?? 0),
      "-i", input,
      "-frames:v", "1",
      "-q:v", "2",
      output,
    ],
  },
  {
    id: "rotate",
    label: "Rotate",
    group: "look",
    keywords: ["turn", "sideways", "orientation", "flip", "upside", "landscape", "portrait"],
    icon: '<path d="M17 2l4 4l-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4l4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />',
    hint: "Turn a phone video sideways-up, or flip it.",
    action: (o) =>
      o.dir === "ccw" ? "Rotate 90° CCW" : o.dir === "180" ? "Rotate 180°" : o.dir === "hflip" ? "Flip horizontal" : o.dir === "vflip" ? "Flip vertical" : "Rotate 90° CW",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.dir ?? "cw"}.mp4`,
    buildArgs: (input, output, o) => {
      const vf =
        o.dir === "ccw" ? "transpose=2" : o.dir === "180" ? "transpose=1,transpose=1" : o.dir === "hflip" ? "hflip" : o.dir === "vflip" ? "vflip" : "transpose=1";
      return [
        "-i", input, "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "speed",
    label: "Speed",
    group: "sound",
    keywords: ["tempo", "fast", "slow", "faster", "slower", "playback", "2x", "slow motion"],
    icon: '<path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 13l3.5-3.5" />',
    hint: "Faster or slower — audio tempo follows automatically.",
    action: (o) => `Set speed to ${o.rate ?? "1.5"}×`,
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.wav,.ogg,.aac,.flac",
    outMime: (o) => (o.inputKind === "audio" ? "audio/mp4" : "video/mp4"),
    outName: (n, o) => `${baseName(n)}-${o.rate ?? "1.5"}x${o.inputKind === "audio" ? ".m4a" : ".mp4"}`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      const rate = num(o.rate, 1.5) || 1.5;
      const inv = String(Math.round((1 / rate) * 1000000) / 1000000);
      if (o.inputKind === "audio")
        return ["-i", input, "-vn", "-af", `atempo=${rate}`, "-c:a", "aac", "-b:a", "128k", output];
      if (o.hasAudio === "0")
        return ["-i", input, "-vf", `setpts=${inv}*PTS`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", output];
      return [
        "-i", input,
        "-filter_complex", `[0:v]setpts=${inv}*PTS[v];[0:a]atempo=${rate}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "volume",
    label: "Volume",
    group: "sound",
    keywords: ["loud", "quiet", "louder", "quieter", "normalize", "mute", "silence", "gain", "hearing"],
    icon: '<path d="M15 8a5 5 0 0 1 0 8" /><path d="M17.7 5a9 9 0 0 1 0 14" /><path d="M6 15h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5a.8.8 0 0 1 1.5.5v13a.8.8 0 0 1-1.5.5L6 15" />',
    hint: "Turn audio up or down, normalize loudness, or strip it.",
    action: (o) =>
      o.mode === "mute" ? "Remove audio" : o.mode === "norm" ? "Normalize loudness" : o.mode === "quiet" ? "Make it quieter" : "Make it louder",
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.wav,.ogg,.aac,.flac",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.mode ?? "louder"}.mp4`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      if (o.mode === "mute")
        return ["-i", input, "-c:v", "copy", "-an", "-movflags", "+faststart", output];
      const af = o.mode === "norm" ? "loudnorm" : o.mode === "quiet" ? "volume=0.5" : "volume=2.0";
      if (o.inputKind === "audio")
        return ["-i", input, "-vn", "-af", af, "-c:a", "aac", "-b:a", "128k", output];
      if (o.hasAudio === "0")
        return ["-i", input, "-c", "copy", "-movflags", "+faststart", output];
      return ["-i", input, "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output];
    },
  },
  {
    id: "denoise",
    label: "Denoise",
    group: "sound",
    keywords: ["noise", "wind", "static", "hiss", "hum", "rumble", "clean up", "suppress", "background"],
    icon: '<path d="M4 10h8a3 3 0 1 0 -3 -3" /><path d="M20 10h-8a3 3 0 1 1 3 3" /><path d="M4 14h10a3 3 0 1 1 -3 3" />',
    hint: "Clean up hiss, wind and hum from the sound.",
    action: (o) => (o.hum === "on" ? "Denoise & low-cut the audio" : "Denoise the audio"),
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.wav,.ogg,.oga,.aac,.flac",
    outMime: (o) => (o.inputKind === "audio" ? "audio/mp4" : "video/mp4"),
    outName: (n, o) => `${baseName(n)}-clean${o.inputKind === "audio" ? `.${audioOut(n).ext}` : ".mp4"}`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      const strength = o.amount === "light" ? "0.8" : o.amount === "strong" ? "2.0" : "1.2";
      const af = [`afftdn=nr=${strength}:nf=-25`, ...(o.hum === "on" ? ["highpass=f=100"] : [])].join(",");
      if (o.inputKind === "audio")
        return ["-i", input, "-af", af, ...audioToolTail(input, "audio"), output];
      if (o.hasAudio === "0")
        return ["-i", input, "-c", "copy", "-movflags", "+faststart", output];
      return ["-i", input, "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output];
    },
  },
  {
    id: "isolate",
    label: "Split voice",
    group: "sound",
    keywords: ["karaoke", "instrumental", "acapella", "a cappella", "vocals", "voice", "remove singing", "background music", "extract music"],
    icon: '<path d="M5 15v-4a7 7 0 0 1 14 0v4" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" />',
    hint: "Keep the voice or keep the music — stereo channel trick.",
    action: (o) => (o.mode === "voice" ? "Keep the voice" : "Keep the music (karaoke)"),
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.wav,.ogg,.oga,.aac,.flac",
    outMime: (o) => (o.inputKind === "audio" ? "audio/mp4" : "video/mp4"),
    outName: (n, o) =>
      `${baseName(n)}-${o.mode === "voice" ? "voice" : "karaoke"}${o.inputKind === "audio" ? `.${audioOut(n).ext}` : ".mp4"}`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      // Center-channel math, no AI: voice lives in the middle of a stereo
      // mix, instruments spread across the sides — mix or subtract. Mono
      // inputs get upmixed first so pan always finds two channels.
      const af =
        o.mode === "voice"
          ? "aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1"
          : "aformat=channel_layouts=stereo,pan=stereo|c0=c0-c1|c1=c1-c0";
      if (o.inputKind === "audio")
        return ["-i", input, "-af", af, ...audioToolTail(input, "audio"), output];
      if (o.hasAudio === "0")
        return ["-i", input, "-c", "copy", "-movflags", "+faststart", output];
      return ["-i", input, "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output];
    },
  },
  {
    id: "fade",
    label: "Fade",
    group: "sound",
    keywords: ["fade in", "fade out", "transition", "soft", "start", "end", "dissolve"],
    icon: '<path d="M4 20c6 0 8-16 16-16" />',
    hint: "Fade the picture and sound in, out, or both.",
    action: (o) => `Fade ${o.which === "in" ? "in" : o.which === "out" ? "out" : "in & out"}`,
    accept: "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.wav,.ogg,.aac,.flac",
    outMime: (o) => (o.inputKind === "audio" ? "audio/mp4" : "video/mp4"),
    outName: (n, o) => `${baseName(n)}-fade${o.inputKind === "audio" ? ".m4a" : ".mp4"}`,
    probeAudio: true,
    validate: (o) => {
      const d = num(o.durationSec, Number.NaN);
      if ((o.which ?? "both") !== "in" && !Number.isFinite(d))
        return "Pick the file first so we know its length for the fade-out.";
      return null;
    },
    buildArgs: (input, output, o) => {
      const dur = num(o.durationSec, 0);
      const d = Math.max(0.2, num(o.seconds, 1));
      const which = o.which ?? "both";
      const vParts: string[] = [];
      const aParts: string[] = [];
      if (which === "in" || which === "both") {
        vParts.push(`fade=t=in:st=0:d=${d}`);
        aParts.push(`afade=t=in:st=0:d=${d}`);
      }
      if (which === "out" || which === "both") {
        const st = Math.max(0, dur - d);
        vParts.push(`fade=t=out:st=${st}:d=${d}`);
        aParts.push(`afade=t=out:st=${st}:d=${d}`);
      }
      if (o.inputKind === "audio")
        return ["-i", input, "-vn", "-af", aParts.join(","), "-c:a", "aac", "-b:a", "128k", output];
      if (o.hasAudio === "0")
        return ["-i", input, "-vf", vParts.join(","), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", output];
      return [
        "-i", input,
        "-filter_complex", `[0:v]${vParts.join(",")}[v];[0:a]${aParts.join(",")}[a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "wave",
    label: "Wave video",
    group: "sound",
    keywords: ["waveform", "visualizer", "audio to video", "podcast", "static video", "banner video", "sound picture"],
    icon: '<path d="M3 12h2" /><path d="M7 8v8" /><path d="M11 4v16" /><path d="M15 8v8" /><path d="M19 12h2" />',
    hint: "Turn a song into a waveform video for socials.",
    action: (o) => `Make a ${o.shape === "9x16" ? "vertical" : o.shape === "1x1" ? "square" : "landscape"} wave video`,
    accept: "audio/*,video/*,.mp3,.m4a,.wav,.ogg,.oga,.opus,.aac,.flac,.mp4,.m4v,.mov,.mkv,.webm",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-wave.mp4`,
    probeAudio: true,
    validate: (o) => (o.hasAudio === "0" ? "This file has no sound to visualise." : null),
    buildArgs: (input, output, o) => {
      const size = o.shape === "9x16" ? "720x1280" : o.shape === "1x1" ? "720x720" : "1280x720";
      const color = o.color === "white" ? "0xFFFFFF" : o.color === "green" ? "0x53B483" : "0xF0A63C";
      const mode = o.style === "line" ? "line" : "cline";
      return [
        "-i", input,
        "-filter_complex", `[0:a]asplit=2[wa][aa];[wa]showwaves=s=${size}:colors=${color}:mode=${mode},format=yuv420p[v]`,
        "-map", "[v]", "-map", "[aa]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "160k", "-shortest",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "merge",
    label: "Merge",
    group: "cut",
    keywords: ["join", "combine", "stitch", "together", "playlist", "concatenate", "parts"],
    icon: '<circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7" /><path d="M18 10.5c0 4-6 3.5-10.6 5.4" />',
    hint: "Join the picked file and queued files into one video.",
    action: (o) => `Merge ${o.inputCount ?? "2"} files`,
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-merged.mp4`,
    probeAudio: true,
    multiInput: true,
    buildArgs: () => [],
    buildArgsList: (inputs, output, o) => {
      const withAudio = o.hasAudio !== "0";
      const parts: string[] = [];
      inputs.forEach((_, i) => {
        parts.push(
          `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`,
        );
        if (withAudio) parts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
      });
      const ins = inputs.map((_, i) => `[v${i}]` + (withAudio ? `[a${i}]` : "")).join("");
      parts.push(`${ins}concat=n=${inputs.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`);
      const args: string[] = [];
      for (const inp of inputs) args.push("-i", inp);
      args.push("-filter_complex", parts.join(";"), "-map", "[v]");
      if (withAudio) args.push("-map", "[a]");
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
      if (withAudio) args.push("-c:a", "aac", "-b:a", "128k");
      else args.push("-an");
      args.push("-movflags", "+faststart", output);
      return args;
    },
  },
  {
    id: "loop",
    label: "Loop",
    group: "cut",
    keywords: ["repeat", "boomerang", "ping pong", "bounce", "again", "times"],
    icon: '<path d="M17 2l4 4l-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4l4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />',
    hint: "Repeat a clip, or play it forward then backward (boomerang).",
    action: (o) => (o.mode === "boomerang" ? "Make a boomerang" : `Loop ${o.times ?? "2"}×`),
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.mode === "boomerang" ? "boomerang" : `loop${o.times ?? "2"}`}.mp4`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      if (o.mode === "boomerang") {
        if (o.hasAudio === "0")
          return [
            "-i", input,
            "-filter_complex", "[0:v]split=2[v0][v1];[v1]reverse[vr];[v0][vr]concat=n=2:v=1:a=0[v]",
            "-map", "[v]", "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-movflags", "+faststart", output,
          ];
        return [
          "-i", input,
          "-filter_complex", "[0:v]split=2[v0][v1];[v1]reverse[vr];[v0][vr]concat=n=2:v=1:a=0[v];[0:a]asplit=2[a0][a1];[a1]areverse[ar];[a0][ar]concat=n=2:v=0:a=1[a]",
          "-map", "[v]", "-map", "[a]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", output,
        ];
      }
      const n = Math.max(2, Math.min(8, Math.floor(num(o.times, 2))));
      const segs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
      const asegs = Array.from({ length: n }, (_, i) => `[a${i}]`).join("");
      if (o.hasAudio === "0")
        return [
          "-i", input,
          "-filter_complex", `[0:v]split=${n}${Array.from({ length: n }, (_, i) => `[v${i}]`).join("")};${segs}concat=n=${n}:v=1:a=0[v]`,
          "-map", "[v]", "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-movflags", "+faststart", output,
        ];
      return [
        "-i", input,
        "-filter_complex", `[0:v]split=${n}${Array.from({ length: n }, (_, i) => `[v${i}]`).join("")};${segs}concat=n=${n}:v=1:a=0[v];[0:a]asplit=${n}${Array.from({ length: n }, (_, i) => `[a${i}]`).join("")};${asegs}concat=n=${n}:v=0:a=1[a]`,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "reverse",
    label: "Reverse",
    group: "cut",
    keywords: ["backwards", "rewind", "flip", "play in reverse", "rewind"],
    icon: '<path d="M11 19l-9-7l9-7v14z" /><path d="M22 19l-9-7l9-7v14z" />',
    hint: "Play the whole clip backwards.",
    action: () => "Reverse video",
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-reversed.mp4`,
    probeAudio: true,
    buildArgs: (input, output, o) => {
      if (o.hasAudio === "0")
        return [
          "-i", input, "-filter_complex", "[0:v]reverse[v]", "-map", "[v]", "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-movflags", "+faststart", output,
        ];
      return [
        "-i", input,
        "-filter_complex", "[0:v]reverse[v];[0:a]areverse[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "resize",
    label: "Resize",
    group: "look",
    keywords: ["scale", "size", "resolution", "dimensions", "height", "hd", "4k", "downscale"],
    icon: '<path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />',
    hint: "Set the height — width follows, never stretched.",
    action: (o) => (o.maxH === "orig" ? "Re-encode as-is" : `Resize to ${o.maxH ?? "720"}p`),
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.maxH ?? "720"}p.mp4`,
    buildArgs: (input, output, o) => [
      "-i", input,
      ...scaleFilter(o.maxH ?? "720"),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", output,
    ],
  },
  {
    id: "filter",
    label: "Filter",
    group: "look",
    keywords: ["look", "color", "colour", "grayscale", "black and white", "sepia", "vivid", "warm", "cool", "style"],
    icon: '<path d="M4 8h10" /><path d="M18 8h2" /><circle cx="16" cy="8" r="2" /><path d="M4 16h4" /><path d="M12 16h8" /><circle cx="10" cy="16" r="2" />',
    hint: "Grayscale, sepia, warm, cool and more.",
    action: (o) => `Apply ${o.preset ?? "normal"} filter`,
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n, o) => `${baseName(n)}-${o.preset ?? "normal"}.mp4`,
    buildArgs: (input, output, o) => {
      const vf: Record<string, string> = {
        normal: "",
        vivid: "eq=saturation=1.5:contrast=1.1",
        faded: "eq=contrast=0.9:brightness=0.05:saturation=0.5",
        bw: "hue=s=0",
        sepia: "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
        warm: "eq=saturation=1.25:brightness=0.03",
        cool: "eq=saturation=1.05:brightness=-0.02",
      };
      const f = vf[o.preset ?? "normal"] ?? "";
      if (!f) return ["-i", input, "-c", "copy", "-movflags", "+faststart", output];
      return [
        "-i", input, "-vf", f,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", output,
      ];
    },
  },
  {
    id: "watermark",
    label: "Watermark",
    group: "look",
    keywords: ["logo", "brand", "stamp", "text overlay", "caption", "signature", "copyright", "handle", "@ name"],
    icon: '<rect x="3" y="3" width="12" height="12" rx="2" /><path d="M17 7h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2" />',
    hint: "Stamp text or a logo picture onto the video.",
    action: (o) => (o.mode === "logo" ? "Stamp the logo" : "Stamp the text"),
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: () => "video/mp4",
    outName: (n) => `${baseName(n)}-stamped.mp4`,
    multiInput: true,
    buildArgs: () => [],
    validate: (o) => {
      if (o.mode !== "logo" && !(o.text ?? "").trim()) return "Type the watermark text first.";
      if (o.mode === "logo" && o.logoSet !== "1") return "Pick a logo image first.";
      return null;
    },
    buildArgsList: (inputs, output, o) => {
      // Stamp sits a hair inside the nearest corners (~3.5% of width).
      const m = Math.max(8, Math.round(num(o.mainW, 1280) * 0.035));
      const frac = Math.min(0.5, Math.max(0.06, num(o.size, 0.2)));
      const mainW = num(o.mainW, 0);
      const wmW = num(o.wmW, 0);
      // Scale the stamp to a fraction of the picture width; fall back to a
      // sensible pixel width when either dimension is unknown.
      const target = mainW > 0 && wmW > 0
        ? Math.max(48, Math.round(mainW * frac))
        : Math.max(48, Math.round(320 * (frac / 0.2)));
      const pos = o.pos ?? "br";
      const x = pos === "tl" || pos === "bl" ? String(m) : `main_w-overlay_w-${m}`;
      const y = pos === "tl" || pos === "tr" ? String(m) : `main_h-overlay_h-${m}`;
      const chain = [
        `scale=${target}:-2`,
        `colorchannelmixer=aa=${Math.min(1, Math.max(0.2, num(o.opacity, 0.8)))}`,
      ].join(",");
      const parts = [`[1:v]${chain}[wm]`, `[0:v][wm]overlay=x=${x}:y=${y}[v]`];
      const args: string[] = ["-i", inputs[0] ?? "in_src", "-i", inputs[1] ?? "in_stamp"];
      args.push("-filter_complex", parts.join(";"), "-map", "[v]");
      if (o.hasAudio === "0") args.push("-an");
      else args.push("-c:a", "aac", "-b:a", "128k");
      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-movflags", "+faststart", output,
      );
      return args;
    },
  },
  {
    id: "frames",
    label: "Frames",
    group: "look",
    keywords: ["screenshot", "burst", "sequence", "png", "every", "seconds", "gallery", "photos"],
    icon: '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16" /><path d="M17 4v16" /><path d="M3 9h4" /><path d="M3 15h4" /><path d="M17 9h4" /><path d="M17 15h4" />',
    hint: "Save frames every few seconds as PNG or JPG.",
    action: (o) => `Extract frames as ${o.fmt === "jpg" ? "JPG" : "PNG"}`,
    accept: "video/*,.mp4,.m4v,.mov,.mkv,.webm,.3gp,.avi,.mpg,.mpeg",
    outMime: (o) => (o.fmt === "jpg" ? "image/jpeg" : "image/png"),
    outName: (n, o) => `${baseName(n)}-frames.${o.fmt ?? "png"}`,
    burst: true,
    buildArgs: (input, output, o) => [
      "-i", input,
      "-vf", `fps=1/${Math.max(0.5, num(o.every, 2))}`,
      ...(o.fmt === "jpg" ? ["-q:v", "3"] : []),
      output,
    ],
  },
  {
    id: "image",
    label: "Images",
    group: "still",
    keywords: ["picture", "photo", "png", "jpg", "jpeg", "webp", "compress", "resize", "convert", "still"],
    icon: '<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" />',
    hint: "Compress, resize and convert PNG / JPG / WebP.",
    acceptKind: "image",
    action: (o) =>
      o.op === "resize" ? "Resize image" : o.op === "convert" ? `Convert to ${(o.format ?? "webp").toUpperCase()}` : "Compress image",
    accept: "image/*,.png,.jpg,.jpeg,.webp",
    outMime: (o) => {
      const e = o.op === "convert" ? (o.format ?? "webp") : "jpg";
      return e === "png" ? "image/png" : e === "webp" ? "image/webp" : "image/jpeg";
    },
    outName: (n, o) => {
      const ext = o.op === "convert" ? (o.format ?? "webp") : o.op === "compress" ? (extOf(n) || "jpg") : extOf(n) || "jpg";
      const tag = o.op === "resize" ? (o.maxW === "orig" ? "-resized" : `-w${o.maxW}`) : o.op === "compress" ? "-compressed" : "-converted";
      return `${baseName(n)}${tag}.${ext === "jpeg" ? "jpg" : ext}`;
    },
    buildArgs: (input, output, o) => {
      if (o.op === "resize") {
        const maxW = o.maxW ?? "orig";
        const vf = maxW === "orig" ? [] : ["-vf", `scale='min(${Number(maxW)}\\,iw)':-2`];
        return ["-i", input, ...vf, "-q:v", "4", output];
      }
      if (o.op === "convert") return ["-i", input, "-q:v", "4", output];
      // compress
      const q = o.quality === "high" ? "2" : o.quality === "low" ? "10" : "6";
      return ["-i", input, "-q:v", q, output];
    },
  },
  {
    id: "heic",
    label: "HEIC → JPG",
    group: "still",
    keywords: ["iphone", "heif", "hif", "apple", "photos", "convert", "jpg", "jpeg", "png", "won't open"],
    icon: '<path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="9" cy="9" r="1.5" /><path d="M20 15l-4-4l-7 9" />',
    hint: "Turn iPhone HEIC photos into JPG or PNG, right in the browser.",
    action: (o) => `Convert HEIC to ${(o.fmt ?? "jpg").toUpperCase()}`,
    accept: "image/*,.heic,.heif,.hif",
    acceptKind: "image",
    badge: "new",
    outMime: (o) => (o.fmt === "png" ? "image/png" : "image/jpeg"),
    outName: (n, o) => `${baseName(n)}.${o.fmt ?? "jpg"}`,
    // Never reached — browser() handles the job.
    buildArgs: () => [],
    // libheif runs in the page — no ffmpeg, no upload.
    browser: async (file, o) => {
      const { default: heic2any } = await import("heic2any");
      const quality = o.quality === "high" ? 0.92 : o.quality === "low" ? 0.6 : 0.8;
      const blob = await heic2any({
        blob: file,
        toType: o.fmt === "png" ? "image/png" : "image/jpeg",
        quality,
      });
      return Array.isArray(blob) ? blob[0]! : blob;
    },
  },
  {
    id: "passport",
    label: "ID photo",
    group: "still",
    keywords: ["passport", "visa", "id", "document", "headshot", "biometric", "photo size", "35x45"],
    icon: '<rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M6 16a4 4 0 0 1 6 0" /><path d="M15 9h4" /><path d="M15 13h4" />',
    hint: "Crop & size a photo to 35×45 mm and other ID formats.",
    action: () => "Make the ID photo",
    accept: "image/*,.png,.jpg,.jpeg,.webp",
    acceptKind: "image",
    badge: "new",
    outMime: () => "image/jpeg",
    outName: (n) => `${baseName(n)}-id-photo.jpg`,
    validate: (o) => (PASSPORT_MAP[o.size ?? "35x45"] ? null : "Choose an ID size."),
    buildArgs: (input, output, o) => {
      const s = PASSPORT_MAP[o.size ?? "35x45"] ?? PASSPORT_MAP["35x45"]!;
      const fx = num(o.focalX, 50) / 100;
      const fy = num(o.focalY, 45) / 100;
      return [
        "-i", input,
        "-vf", `${cropFilter(s.W, s.H, fx, fy)},scale=${s.pw}:${s.ph}:flags=lanczos`,
        "-q:v", "2",
        output,
      ];
    },
  },
];

export { IN, OUT };
export function toolById(id: ToolId): ToolDef {
  return TOOLS.find((t) => t.id === id) ?? TOOLS[0]!;
}

/**
 * Index search. Every whitespace-separated term has to land somewhere, so
 * "vertical gif" narrows instead of widening. Matches the label people see,
 * the hint under it, and the extra keywords for the words we don't print.
 */
export function searchTools(query: string): ToolDef[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return TOOLS;
  return TOOLS.filter((t) => {
    const hay = `${t.label} ${t.hint} ${t.keywords.join(" ")}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}
