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
