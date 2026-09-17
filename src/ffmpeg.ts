import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreJS from "@ffmpeg/core?url";
import coreWasm from "@ffmpeg/core/wasm?url";
import mtJS from "@ffmpeg/core-mt?url";
import mtWasm from "@ffmpeg/core-mt/wasm?url";
import mtWorker from "@ffmpeg/core-mt/worker?url";

export type EngineVariant = "mt" | "st";
export type EngineState = "idle" | "loading" | "ready" | "error";

let ff: FFmpeg | null = null;
let state: EngineState = "idle";
let variant: EngineVariant | null = null;
let loadPromise: Promise<EngineVariant> | null = null;
let generation = 0;

export function engineState(): { state: EngineState; variant: EngineVariant | null } {
  return { state, variant };
}

/** Multithread needs SharedArrayBuffer + cross-origin isolation. */
function wantsMT(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.crossOriginIsolated === "boolean" &&
    window.crossOriginIsolated &&
    typeof SharedArrayBuffer !== "undefined"
  );
}

// NOTE: pass bundled same-origin core/wasm URLs directly. Two verified hangs:
// blob:-wrapped URLs stall workers under COEP: require-corp, and the ESM
// classWorker (?url) can't boot as a classic worker — the lib default works.
async function loadVariant(v: EngineVariant): Promise<FFmpeg> {
  const inst = new FFmpeg();
  if (v === "mt") {
    await inst.load({ coreURL: mtJS, wasmURL: mtWasm, workerURL: mtWorker });
  } else {
    await inst.load({ coreURL: coreJS, wasmURL: coreWasm });
  }
  return inst;
}

/** A hung load (observed with MT on some mobile/headless browsers) must not stick. */
const LOAD_TIMEOUT_MS = 25000;

async function loadWithTimeout(v: EngineVariant): Promise<FFmpeg> {
  const { promise, resolve, reject } = Promise.withResolvers<FFmpeg>();
  const timer = setTimeout(() => reject(new Error(`ffmpeg ${v} load timed out`)), LOAD_TIMEOUT_MS);
  loadVariant(v).then(
    (inst) => {
      clearTimeout(timer);
      resolve(inst);
    },
    (e) => {
      clearTimeout(timer);
      reject(e);
    },
  );
  return promise;
}

const MT_STICKY_KEY = "mpb-mt-broken-at";
const MT_RETRY_MS = 7 * 24 * 3600 * 1000;

function mtKnownBroken(): boolean {
  try {
    const at = Number(localStorage.getItem(MT_STICKY_KEY) ?? 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at < MT_RETRY_MS;
  } catch {
    return false;
  }
}

/** Lazy-load the ~30MB core once. Tries MT when isolated, falls back to ST. */
export function ensureEngine(): Promise<EngineVariant> {
  if (ff && variant) return Promise.resolve(variant);
  if (loadPromise) return loadPromise;
  state = "loading";
  loadPromise = (async () => {
    const gen = generation;
    const order: EngineVariant[] = wantsMT() && !mtKnownBroken() ? ["mt", "st"] : ["st"];
    let lastErr: unknown = null;
    for (const v of order) {
      let inst: FFmpeg | null = null;
      try {
        inst = await loadWithTimeout(v);
        if (gen !== generation) {
          try {
            inst.terminate();
          } catch {
            /* noop */
          }
          throw new Error("cancelled");
        }
        ff = inst;
        variant = v;
        state = "ready";
        return v;
      } catch (e) {
        lastErr = e;
        if (v === "mt" && gen === generation) {
          try {
            localStorage.setItem(MT_STICKY_KEY, String(Date.now()));
          } catch {
            /* private mode */
          }
        }
        if (inst && ff !== inst) {
          try {
            inst.terminate();
          } catch {
            /* noop */
          }
        }
        if (gen === generation) ff = null;
      }
    }
    if (gen === generation) state = "error";
    throw lastErr instanceof Error ? lastErr : new Error("ffmpeg load failed");
  })();
  return loadPromise;
}
export function engine(): FFmpeg {
  if (!ff) throw new Error("engine not loaded — call ensureEngine() first");
  return ff;
}

export function onProgress(cb: (p: number) => void): void {
  engine().on("progress", ({ progress }) => cb(Math.max(0, Math.min(1, progress || 0))));
}

export async function runFFmpeg(args: string[], files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const inst = engine();
  for (const f of files) await inst.writeFile(f.name, f.data);
  try {
    const code = await inst.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    // Last arg is the output file (all our builders follow this).
    const outName = args[args.length - 1]!;
    const data = (await inst.readFile(outName)) as Uint8Array;
    await inst.deleteFile(outName).catch(() => {});
    return data;
  } finally {
    for (const f of files) await inst.deleteFile(f.name).catch(() => {});
  }
}

export async function cancelEngine(): Promise<void> {
  generation++;
  loadPromise = null;
  try {
    await engine().terminate();
  } catch {
    /* noop */
  } finally {
    ff = null;
    state = "idle";
    variant = null;
  }
}

export async function fileBytes(file: File): Promise<Uint8Array> {
  return (await fetchFile(file)) as Uint8Array;
}
