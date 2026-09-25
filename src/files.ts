export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function isMobile(): boolean {
  return (
    /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820)
  );
}

/** Size guard: desktop ~200MB, mobile ~50MB before MEMFS gets dangerous. */
export function sizeWarning(bytes: number): string | null {
  const mb = bytes / (1024 * 1024);
  if (isMobile() && mb > 50)
    return `Large for mobile (${mb.toFixed(0)} MB). May crash this tab — trim first or use desktop.`;
  if (mb > 200) return `Large file (${mb.toFixed(0)} MB). May crash the tab — trim first.`;
  return null;
}

export function baseName(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Accepts "90", "1:30", "01:30.5". Returns seconds or null. */
export function parseTime(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return total;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Trim-precision format: m:ss.d (keeps tenths so slider drags round-trip). */
export function fmtTrim(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const clamped = Math.max(0, sec);
  const m = Math.floor(clamped / 60);
  const s = clamped - m * 60;
  if (Number.isInteger(Math.round(s * 10) / 10) && Number.isInteger(clamped)) {
    return `${m}:${String(Math.round(s)).padStart(2, "0")}`;
  }
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** A half-open span of the timeline, in seconds. */
export interface Range {
  a: number;
  b: number;
}

/** Shortest span a cut may cover — smaller marks are treated as a stray tap. */
export const MIN_CUT = 0.1;

const CUT_EPS = 1e-6;

/**
 * Packed range list: "0:12.5-0:18|0:30-0:31.5".
 * Unparseable pieces are dropped, flipped ends are swapped.
 */
export function parseRanges(s: string): Range[] {
  const out: Range[] = [];
  for (const chunk of s.split("|")) {
    const dash = chunk.indexOf("-");
    if (dash < 0) continue;
    const a = parseTime(chunk.slice(0, dash));
    const b = parseTime(chunk.slice(dash + 1));
    if (a == null || b == null) continue;
    out.push(a <= b ? { a, b } : { a: b, b: a });
  }
  return out;
}

/** Inverse of parseRanges. */
export function fmtRanges(rs: Range[]): string {
  return rs.map((r) => `${fmtTrim(r.a)}-${fmtTrim(r.b)}`).join("|");
}

/**
 * Drop slivers and fuse overlaps, keeping the order the ranges were added in —
 * reordering mid-edit would shuffle the inputs out from under the user.
 * (The ffmpeg graph sorts for itself; see trimCuts.)
 */
export function mergeRanges(rs: Range[], minLen = MIN_CUT): Range[] {
  const out: Range[] = [];
  for (const r of rs) {
    if (!Number.isFinite(r.a) || !Number.isFinite(r.b) || r.b - r.a < minLen) continue;
    const hits: number[] = [];
    for (let i = 0; i < out.length; i++) {
      const o = out[i]!;
      if (r.a < o.b - CUT_EPS && o.a < r.b - CUT_EPS) hits.push(i);
    }
    if (hits.length === 0) {
      out.push({ a: r.a, b: r.b });
      continue;
    }
    const a = Math.min(r.a, ...hits.map((i) => out[i]!.a));
    const b = Math.max(r.b, ...hits.map((i) => out[i]!.b));
    const at = Math.min(...hits);
    for (let i = hits[hits.length - 1]!; i >= at; i--) out.splice(i, 1);
    out.splice(at, 0, { a, b });
  }
  return out;
}

/** Keep ranges inside [0, dur]; dur null leaves the top open. */
export function clampRanges(rs: Range[], dur: number | null): Range[] {
  const hi = dur != null && Number.isFinite(dur) ? dur : Number.POSITIVE_INFINITY;
  return rs
    .map((r) => ({ a: clamp(r.a, 0, hi), b: clamp(r.b, 0, hi) }))
    .filter((r) => r.b - r.a >= MIN_CUT);
}

/**
 * What survives the cuts: every span of [0, dur] no cut touches, in order.
 * `b: null` means "to the end of the file" (duration unknown).
 */
export function keptSegments(
  cuts: Range[],
  dur: number | null,
): { a: number; b: number | null }[] {
  const out: { a: number; b: number | null }[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.a - cursor >= MIN_CUT) out.push({ a: cursor, b: c.a });
    cursor = Math.max(cursor, c.b);
  }
  if (dur == null) out.push({ a: cursor, b: null });
  else if (dur - cursor >= MIN_CUT) out.push({ a: cursor, b: dur });
  return out;
}

/**
 * Downsampled waveform peaks (0..1) for a trim timeline.
 * Returns null when undecodable (no audio track, too big, unsupported codec).
 */
export async function peakWaveform(file: File, buckets = 96): Promise<number[] | null> {
  // Decoding a huge video into RAM can OOM the tab — timeline falls back to gradient.
  if (file.size > 60 * 1024 * 1024) return null;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const buf = await file.arrayBuffer();
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      if (!ch || ch.length === 0) return null;
      const out = new Array<number>(buckets).fill(0);
      const step = Math.max(1, Math.floor(ch.length / buckets));
      let max = 0;
      for (let b = 0; b < buckets; b++) {
        let peak = 0;
        const start = b * step;
        const end = Math.min(ch.length, start + step);
        // Sample every Nth frame inside the bucket to stay fast on long files.
        const stride = Math.max(1, Math.floor((end - start) / 32));
        for (let i = start; i < end; i += stride) {
          const v = Math.abs(ch[i] ?? 0);
          if (v > peak) peak = v;
        }
        out[b] = peak;
        if (peak > max) max = peak;
      }
      if (max <= 0) return null;
      return out.map((v) => v / max);
    } finally {
      void ctx.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

export function probeDuration(file: File): Promise<number | null> {
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.preload = "metadata";
  el.muted = true;
  const done = (v: number | null) => {
    URL.revokeObjectURL(url);
    resolve(v);
  };
  el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
  el.onerror = () => done(null);
  el.src = url;
  setTimeout(() => done(null), 8000);
  return promise;
}

export function downloadUrl(data: Uint8Array, mime: string): string {
  // Use a copy: `data` may be a view into wasm memory with a larger
  // backing buffer — `data.buffer` would leak extra bytes into the Blob.
  const copy = data.slice();
  const blob = new Blob([copy as unknown as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}

/** True when the Web Share API entry point exists at all. */
export function canAttemptShare(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof (navigator as Navigator & { share?: unknown }).share === "function"
    );
  } catch {
    return false;
  }
}

export async function shareFile(file: File): Promise<"shared" | "unsupported" | "dismissed"> {
  try {
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    if (typeof nav.share !== "function") return "unsupported";
    // When canShare exists and explicitly rejects this payload, skip the
    // share sheet and let the caller fall back (e.g. to download).
    try {
      if (typeof nav.canShare === "function" && !nav.canShare({ files: [file] })) {
        return "unsupported";
      }
    } catch {
      // canShare threw — fall through and try share() anyway.
    }
    await nav.share({ files: [file] });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "dismissed";
    return "unsupported";
  }
}
