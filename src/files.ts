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
  const blob = new Blob([data.buffer as ArrayBuffer], { type: mime });
  return URL.createObjectURL(blob);
}

export async function shareFile(file: File): Promise<"shared" | "unsupported" | "dismissed"> {
  try {
    if (!navigator.canShare?.({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file] });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "dismissed";
    return "unsupported";
  }
}
