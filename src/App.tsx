import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CROP_RATIOS,
  GIF_MAX_SEC,
  IN,
  OUT,
  OUTPUT_FORMATS,
  TOOLS,
  cropWH,
  toolById,
  trimMode,
  type ToolId,
} from "./tools";
import {
  canAttemptShare,
  extOf,
  fmtTime,
  fmtTrim,
  formatBytes,
  probeDuration,
  shareFile,
  sizeWarning,
} from "./files";
import {
  cancelEngine,
  ensureEngine,
  engine,
  engineState,
  fileBytes,
  onProgress,
  runFFmpeg,
} from "./ffmpeg";
import { Field, Segmented, Switch, TextInput } from "./components/fields";
import PwaStatus from "./components/PwaStatus";
import TrimEditor, { type PickedKind } from "./components/TrimEditor";
import ComparePreview from "./components/ComparePreview";

type Opts = Record<ToolId, Record<string, string>>;
type JobHistory = {
  id: string;
  fileName: string;
  tool: ToolId;
  opts: Record<string, string>;
  inputBytes: number;
  outputBytes: number;
  at: number;
};
/** "idle" = waiting for input, otherwise ffmpeg is busy. */
type Phase = "idle" | "loading" | "working";
type Failure = { title: string; hint: string | null; detail: string };

const INITIAL_OPTS: Opts = {
  compress: { quality: "med", maxH: "720" },
  trim: { start: "", end: "", exact: "off", snap: "on", mode: "keep", cuts: "" },
  mp3: { bitrate: "128k" },
  convert: { format: "mp4", shorts: "off", targetMB: "off", audio: "keep" },
  crop: { ratio: "9:16", customW: "4", customH: "5", focalX: "50", focalY: "50" },
  thumbnail: { frameAt: "0:01" },
  rotate: { dir: "cw" },
  speed: { rate: "1.5" },
  volume: { mode: "louder" },
  fade: { which: "both", seconds: "1", durationSec: "" },
  merge: {},
  loop: { mode: "loop", times: "2" },
  reverse: {},
  resize: { maxH: "720" },
  filter: { preset: "normal" },
  frames: { every: "2", fmt: "png" },
  image: { op: "compress", quality: "med", maxW: "orig", format: "webp" },
};

const MEDIA_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "3gp", "avi", "mpg", "mpeg",
  "mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac",
  "png", "jpg", "jpeg", "webp",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

function fileKind(f: File): "video" | "audio" | "image" {
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("audio/")) return "audio";
  if (f.type.startsWith("video/")) return "video";
  const ext = extOf(f.name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (["mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac"].includes(ext)) return "audio";
  return "video";
}

function loadOpts(): Opts {
  try {
    const raw = localStorage.getItem("mpb-opts");
    if (!raw) return INITIAL_OPTS;
    const parsed = JSON.parse(raw) as Partial<Opts>;
    return {
      compress: { ...INITIAL_OPTS.compress, ...(parsed.compress ?? {}) },
      trim: { ...INITIAL_OPTS.trim, ...(parsed.trim ?? {}) },
      mp3: { ...INITIAL_OPTS.mp3, ...(parsed.mp3 ?? {}) },
      convert: { ...INITIAL_OPTS.convert, ...(parsed.convert ?? {}) },
      crop: { ...INITIAL_OPTS.crop, ...(parsed.crop ?? {}) },
      thumbnail: { ...INITIAL_OPTS.thumbnail, ...(parsed.thumbnail ?? {}) },
      rotate: { ...INITIAL_OPTS.rotate, ...(parsed.rotate ?? {}) },
      speed: { ...INITIAL_OPTS.speed, ...(parsed.speed ?? {}) },
      volume: { ...INITIAL_OPTS.volume, ...(parsed.volume ?? {}) },
      fade: { ...INITIAL_OPTS.fade, ...(parsed.fade ?? {}) },
      merge: { ...INITIAL_OPTS.merge, ...(parsed.merge ?? {}) },
      loop: { ...INITIAL_OPTS.loop, ...(parsed.loop ?? {}) },
      reverse: { ...INITIAL_OPTS.reverse, ...(parsed.reverse ?? {}) },
      resize: { ...INITIAL_OPTS.resize, ...(parsed.resize ?? {}) },
      filter: { ...INITIAL_OPTS.filter, ...(parsed.filter ?? {}) },
      frames: { ...INITIAL_OPTS.frames, ...(parsed.frames ?? {}) },
      image: { ...INITIAL_OPTS.image, ...(parsed.image ?? {}) },
    };
  } catch {
    return INITIAL_OPTS;
  }
}

function loadHistory(): JobHistory[] {
  try {
    return (JSON.parse(localStorage.getItem("mpb-history") ?? "[]") as JobHistory[]).slice(0, 10);
  } catch {
    return [];
  }
}

function isMediaFile(f: File): boolean {
  if (f.type.startsWith("video/") || f.type.startsWith("audio/") || f.type.startsWith("image/"))
    return true;
  return MEDIA_EXTS.has(extOf(f.name));
}

function pickedKindOf(f: File | null): PickedKind {
  if (!f) return null;
  const k = fileKind(f);
  return k === "image" ? ("image" as PickedKind) : k;
}

function mimeForExt(ext: string): string | null {
  switch (ext) {
    case "mp4": return "video/mp4";
    case "m4v": return "video/mp4";
    case "webm": return "video/webm";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "wav": return "audio/wav";
    case "gif": return "image/gif";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    default: return null;
  }
}

/** Did ffmpeg bail because the input has no such stream to filter? */
function missingAudioStream(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /matches no streams|stream specifier|invalid stream|no such filter|does not contain any stream|stream map|cannot find a matching/i.test(
    msg,
  );
}

/**
 * ffmpeg reports failures as a wall of stderr. Name the cause in the user's
 * terms, keep the raw text one tap away.
 */
function explainFailure(msg: string): Failure {
  if (/memory|oom|out of memory|alloc/i.test(msg))
    return {
      title: "Ran out of memory",
      hint: "This clip is bigger than the tab can hold. Trim it first, drop to 480p, or run one file at a time.",
      detail: msg,
    };
  if (/cancelled|terminated|abort/i.test(msg))
    return { title: "Stopped before it finished", hint: null, detail: msg };
  if (/Invalid data|moov atom|no such file|Invalid argument|Permission denied|404/i.test(msg))
    return {
      title: "Couldn't read that file",
      hint: "It may be damaged, or use a codec this browser can't decode. Try a different export of it.",
      detail: msg,
    };
  if (/Unknown encoder|Unknown decoder|not supported|Invalid audio stream/i.test(msg))
    return { title: "That format isn't supported here", hint: "MP4 (H.264) and MP3 are the safest inputs.", detail: msg };
  return { title: "Couldn't finish that", hint: "Try again, or try a different file.", detail: msg };
}

export default function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("compress");
  const [opts, setOpts] = useState<Opts>(loadOpts);
  const [picked, setPicked] = useState<File | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);
  const [pickedDuration, setPickedDuration] = useState<number | null>(null);
  const [probing, setProbing] = useState(false);
  const [batchQueue, setBatchQueue] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState("");
  const [engineNote, setEngineNote] = useState<{ text: string; busy: boolean } | null>(null);
  const [engineVisible, setEngineVisible] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultFile, setResultFile] = useState<File | null>(null);
  const [resultMeta, setResultMeta] = useState("");
  const [resultKind, setResultKind] = useState<"video" | "audio" | "gif" | "image" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [rejected, setRejected] = useState<{ name: string; message: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [jobHistory, setJobHistory] = useState<JobHistory[]>(loadHistory);
  const [shareLabel, setShareLabel] = useState("Share");
  const [frameFiles, setFrameFiles] = useState<File[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<File | null>(null);
  const resultWrapRef = useRef<HTMLElement>(null);
  pickedRef.current = picked;

  const running = phase !== "idle";
  const shareSupported = useMemo(() => canAttemptShare(), []);
  const tool = toolById(activeTool);
  const pickedKind = pickedKindOf(picked);
  const validationError = tool.validate?.(opts[activeTool]!) ?? null;
  const engineReady = engineState().state === "ready";

  const patchOpt = useCallback((id: ToolId, key: string, value: string) => {
    setOpts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }, []);

  const clearResult = useCallback(() => {
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResultFile(null);
    setResultKind(null);
    setResultMeta("");
    setFrameFiles([]);
  }, []);

  /** Engine chatter is transient: show it while it matters, then get out of the way. */
  const noteEngine = useCallback((text: string, busy = false) => {
    setEngineNote({ text, busy });
    setEngineVisible(true);
  }, []);

  useEffect(() => {
    if (!engineNote || engineNote.busy) return;
    const t = setTimeout(() => setEngineVisible(false), 4500);
    return () => clearTimeout(t);
  }, [engineNote]);

  const handleSelectTool = useCallback(
    (id: ToolId) => {
      setActiveTool(id);
      clearResult();
      setFailure(null);
    },
    [clearResult],
  );

  const handleFile = useCallback(
    async (f: File) => {
      setFailure(null);
      setRejected(null);
      if (!isMediaFile(f)) {
        setPickedUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setPicked(null);
        setPickedDuration(null);
        clearResult();
        setRejected({
          name: f.name,
          message: "That's not a media file. Pick a video, audio or image file.",
        });
        return;
      }
      const kind = fileKind(f);
      const wantsImage = toolById(activeTool).acceptKind === "image";
      if (wantsImage !== (kind === "image")) {
        setRejected({
          name: f.name,
          message: wantsImage
            ? "The Images tab works on pictures. Switch tools for video or audio."
            : "That's a picture — use the Images tab for it.",
        });
        return;
      }
      setPickedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(f);
      });
      setPicked(f);
      setPickedDuration(null);
      setProbing(true);
      clearResult();
      setBatchQueue([]);

      const dur = fileKind(f) === "image" ? null : await probeDuration(f);
      // Drop stale probes if the user picked another file meanwhile.
      if (pickedRef.current && pickedRef.current.name === f.name) {
        setProbing(false);
        setPickedDuration(dur);
        setOpts((prev) => {
          const t = prev.trim!;
          // A new file has its own timeline: stale cut marks would point at
          // the wrong moments.
          const fade = {
            ...prev.fade!,
            durationSec: dur != null ? String(dur) : (prev.fade!.durationSec ?? ""),
          };
          if (t.end && !t.cuts) return { ...prev, fade };
          return { ...prev, fade, trim: { ...t, cuts: "", end: t.end || (dur != null ? fmtTrim(dur) : "") } };
        });
      }
    },
    [clearResult, activeTool],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const list = Array.from(files).filter(isMediaFile);
      if (list.length === 0) {
        const first = files[0];
        if (first) void handleFile(first);
        return;
      }
      const [first, ...rest] = list;
      if (first) void handleFile(first);
      setBatchQueue(rest);
    },
    [handleFile],
  );

  // Dropping a file anywhere, and pasting one, both feed the same path as the
  // picker — a drop target the size of the whole window is easier to hit.
  useEffect(() => {
    const carriesFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent): void => {
      if (!carriesFiles(e)) return;
      depth++;
      setDragActive(true);
    };
    const onOver = (e: DragEvent): void => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent): void => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent): void => {
      depth = 0;
      setDragActive(false);
      if (!carriesFiles(e)) return;
      e.preventDefault();
      handleFiles(e.dataTransfer?.files ?? null);
    };
    const onPaste = (e: ClipboardEvent): void => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) handleFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [handleFiles]);

  const processOne = useCallback(
    async (file: File, id: ToolId, inputOpts: Record<string, string>) => {
      const t = toolById(id);
      const baseOpts: Record<string, string> = {
        ...inputOpts,
        durationSec: String(pickedDuration ?? ""),
        inputKind: pickedKindOf(file) ?? "video",
      };
      const ext = extOf(file.name) || "mp4";
      const inName = `${IN}.${ext}`;
      const wantExt = extOf(t.outName(file.name, baseOpts)) || "mp4";
      const outName = `${OUT}.${wantExt}`;
      const data = await fileBytes(file);

      // Burst tools (Frames) produce a numbered file set, not one output.
      if (t.burst) {
        const inst = engine();
        await inst.writeFile(inName, data);
        try {
          const fmt = baseOpts.fmt === "jpg" ? "jpg" : "png";
          const pattern = `frames_%03d.${fmt}`;
          const code = await inst.exec(t.buildArgs(inName, pattern, baseOpts));
          if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
          const nodes = await inst.listDir("/");
          const names = nodes
            .map((n) => n.name)
            .filter((n) => n.startsWith("frames_") && n.endsWith(`.${fmt}`))
            .sort();
          if (names.length === 0) throw new Error("No frames came out");
          const mime = fmt === "jpg" ? "image/jpeg" : "image/png";
          const frames: File[] = [];
          for (const name of names) {
            const d = (await inst.readFile(name)) as Uint8Array;
            frames.push(
              new File([d.slice() as unknown as BlobPart], name, { type: mime }),
            );
            await inst.deleteFile(name).catch(() => {});
          }
          const total = frames.reduce((s, f) => s + f.size, 0);
          return {
            bytes: new Uint8Array(0),
            mime,
            outFile: frames[0]!,
            frames,
            totalBytes: total,
            resolvedOpts: { ...baseOpts, hasAudio: "1" },
          };
        } finally {
          await inst.deleteFile(inName).catch(() => {});
        }
      }

      // A source with no audio track has no [0:a] for a filtergraph to trim, so
      // the first attempt fails at graph setup (instantly) — retry without audio.
      const guesses = t.probeAudio ? ["1", "0"] : ["1"];
      let resolvedOpts = { ...baseOpts, hasAudio: "1" };
      let out: Uint8Array | null = null;
      let failure: unknown = null;
      for (const g of guesses) {
        resolvedOpts = { ...baseOpts, hasAudio: g };
        try {
          out = await runFFmpeg(t.buildArgs(inName, outName, resolvedOpts), [
            { name: inName, data },
          ]);
          failure = null;
          break;
        } catch (e) {
          failure = e;
          if (g === "1" && missingAudioStream(e)) continue;
          break;
        }
      }
      if (!out) throw failure instanceof Error ? failure : new Error("ffmpeg failed");

      const outFileName = t.outName(file.name, resolvedOpts);
      const mime = mimeForExt(extOf(outFileName)) ?? t.outMime(resolvedOpts);
      const outFile = new File([out.slice() as unknown as BlobPart], outFileName, { type: mime });
      // Only `out` is safe to measure: writing the input into the engine detaches
      // its buffer, so `data.byteLength` reads 0 from here on.
      return { bytes: out, mime, outFile, totalBytes: out.byteLength, resolvedOpts };
    },
    [pickedDuration],
  );

  const handleRunClick = async (): Promise<void> => {
    if (!picked || running) return;
    const t = toolById(activeTool);
    const o = opts[activeTool]!;
    const err = t.validate?.(o) ?? null;
    if (err) return;

    setPhase("loading");
    setProgress(0);
    setDetail("");
    setFailure(null);

    try {
      noteEngine("Loading engine…", true);
      const v = await ensureEngine();
      noteEngine(v === "mt" ? "Engine ready · fast" : "Engine ready · single-threaded");
      setPhase("working");
      onProgress((p) => setProgress(p));

      const runList = [picked, ...batchQueue];

      // Merge joins every file into a single output instead of looping per file.
      if (t.multiInput && t.buildArgsList) {
        const files = [picked, ...batchQueue];
        if (files.length < 2) {
          setFailure({
            title: "Need one more file",
            hint: "Merge joins the picked file with everything queued. Drop or pick more files to queue them.",
            detail: "",
          });
          setPhase("idle");
          return;
        }
        setDetail(`Merging ${files.length} files…`);
        const exts = files.map((f) => extOf(f.name) || "mp4");
        const inNames = files.map((_, i) => `in_${i}.${exts[i]}`);
        const outName = `${OUT}.mp4`;
        const datas = await Promise.all(files.map((f) => fileBytes(f)));
        const baseOpts: Record<string, string> = {
          ...o,
          inputKind: "video",
          durationSec: String(pickedDuration ?? ""),
          inputCount: String(files.length),
        };
        const guesses = t.probeAudio ? ["1", "0"] : ["1"];
        let resolvedOpts = { ...baseOpts, hasAudio: "1" };
        let out: Uint8Array | null = null;
        let mergeErr: unknown = null;
        for (const g of guesses) {
          resolvedOpts = { ...baseOpts, hasAudio: g };
          try {
            out = await runFFmpeg(
              t.buildArgsList(inNames, outName, resolvedOpts),
              inNames.map((name, i) => ({ name, data: datas[i]! })),
            );
            mergeErr = null;
            break;
          } catch (e) {
            mergeErr = e;
            if (g === "1" && missingAudioStream(e)) continue;
            break;
          }
        }
        if (!out) throw mergeErr instanceof Error ? mergeErr : new Error("ffmpeg failed");
        const outFile = new File([out.slice() as unknown as BlobPart], t.outName(picked.name, resolvedOpts), { type: "video/mp4" });
        setJobHistory((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            fileName: `${files.length} files`,
            tool: activeTool,
            opts: resolvedOpts,
            inputBytes: files.reduce((s, f) => s + f.size, 0),
            outputBytes: out.byteLength,
            at: Date.now(),
          },
          ...prev,
        ].slice(0, 10));
        setResultFile(outFile);
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(outFile);
        });
        setResultKind("video");
        setResultMeta(`· ${formatBytes(files.reduce((s, f) => s + f.size, 0))} → ${formatBytes(out.byteLength)}`);
        setShareLabel("Share");
        setProgress(1);
        setBatchQueue([]);
        requestAnimationFrame(() => {
          resultWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        setPhase("idle");
        return;
      }

      let finalOut: File | null = null;
      for (let i = 0; i < runList.length; i++) {
        const file = runList[i]!;
        setDetail(
          runList.length > 1 ? `${i + 1} of ${runList.length} · ${file.name}` : file.name,
        );
        const { bytes, mime, outFile, totalBytes, frames, resolvedOpts } = await processOne(file, activeTool, o);
        setJobHistory((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            fileName: file.name,
            tool: activeTool,
            opts: resolvedOpts,
            inputBytes: file.size,
            outputBytes: totalBytes,
            at: Date.now(),
          },
          ...prev,
        ].slice(0, 10));
        finalOut = outFile;
        const url = URL.createObjectURL(outFile);
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setResultFile(outFile);
        const kind = mime.startsWith("audio/")
          ? "audio"
          : mime === "image/gif"
            ? "gif"
            : mime.startsWith("image/")
              ? "image"
              : "video";
        setResultKind(kind);
        setFrameFiles(frames ?? []);
        setResultMeta(
          frames && frames.length > 0
            ? `· ${frames.length} frames · ${formatBytes(totalBytes)} total`
            : `· ${formatBytes(file.size)} → ${formatBytes(totalBytes)}`,
        );
      }
      if (finalOut) {
        setShareLabel("Share");
        setProgress(1);
        setBatchQueue([]);
        requestAnimationFrame(() => {
          // "center", not "nearest": the result's own actions sit below the
          // preview, and the job bar covers the bottom of the viewport.
          resultWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    } catch (e) {
      setFailure(explainFailure(e instanceof Error ? e.message : String(e)));
      setProgress(0);
      if (engineState().state === "error") noteEngine("Engine couldn't load");
    } finally {
      setPhase("idle");
    }
  };

  const handleCancel = (): void => {
    void cancelEngine().then(() => {
      setPhase("idle");
      setProgress(0);
      setDetail("");
      noteEngine("Engine stopped · will reload next run");
    });
  };

  const handleRemoveFile = (): void => {
    setPickedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPicked(null);
    setPickedDuration(null);
    setProbing(false);
    setBatchQueue([]);
    setRejected(null);
    clearResult();
    setFailure(null);
  };

  const handleShare = async (): Promise<void> => {
    if (!resultFile) return;
    const r = await shareFile(resultFile);
    if (r === "shared") {
      setShareLabel("Shared ✓");
      setTimeout(() => setShareLabel("Share"), 2000);
    } else if (r === "unsupported") {
      // No share sheet for this file — hand them the download instead.
      document.getElementById("downloadBtn")?.click();
    }
  };

  const rerunFromHistory = (job: JobHistory): void => {
    setActiveTool(job.tool);
    setOpts((prev) => ({ ...prev, [job.tool]: { ...prev[job.tool], ...job.opts } }));
    clearResult();
    setFailure(null);
  };

  const clearHistory = (): void => {
    setJobHistory([]);
    try {
      localStorage.removeItem("mpb-history");
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    // One-time housekeeping: the theme switch and first-run tip are gone.
    try {
      localStorage.removeItem("mpb-theme");
      localStorage.removeItem("mpb-onboarding-dismissed");
    } catch {
      /* private mode */
    }
    return () => {
      setPickedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return prev;
      });
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("mpb-opts", JSON.stringify(opts));
    } catch {
      /* noop */
    }
  }, [opts]);

  useEffect(() => {
    try {
      localStorage.setItem("mpb-history", JSON.stringify(jobHistory.slice(0, 10)));
    } catch {
      /* noop */
    }
  }, [jobHistory]);

  // Revoke result URL on unmount.
  useEffect(() => {
    return () => {
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const runDisabled =
    running || !picked || validationError != null || (activeTool === "merge" && batchQueue.length === 0);
  const runLabel = failure ? "Try again" : tool.action(opts[activeTool]!);
  const runningLabel =
    phase === "loading" ? "Loading engine…" : `Working…${detail ? ` · ${detail}` : ""}`;

  const fileMeta = picked
    ? `${formatBytes(picked.size)}${probing ? " · reading…" : pickedDuration != null ? ` · ${fmtTime(pickedDuration)}` : ""}`
    : "";
  const sizeWarn = picked ? sizeWarning(picked.size) : null;

  const cropOpts = opts.crop!;
  const cropPreview = cropWH(cropOpts);
  const cropName = CROP_RATIOS.find(([v]) => v === cropOpts.ratio)?.[1] ?? "Crop";
  const compressEstimate = (() => {
    if (!picked) return null;
    const q = opts.compress!.quality ?? "med";
    const maxH = opts.compress!.maxH ?? "720";
    const qualityFactor = q === "high" ? 0.68 : q === "med" ? 0.46 : 0.32;
    const scaleFactor = maxH === "1080" ? 0.9 : maxH === "720" ? 0.62 : maxH === "480" ? 0.4 : 1;
    const est = Math.max(1, Math.round(picked.size * qualityFactor * scaleFactor));
    return { bytes: formatBytes(est), pct: Math.max(0, Math.round((1 - est / picked.size) * 100)) };
  })();
  const change = (() => {
    if (!picked || !resultFile || picked.size <= 0) return "—";
    const pct = Math.round((1 - resultFile.size / picked.size) * 100);
    if (pct > 0) return `−${pct}%`;
    if (pct < 0) return `+${-pct}%`;
    return "same";
  })();
  const gifTooLong = activeTool === "convert" && opts.convert!.format === "gif" && (pickedDuration ?? 0) > GIF_MAX_SEC;

  /** Compress (video or image) gets a Squoosh-style before/after slider. */
  const compressCompare =
    (activeTool === "compress" && pickedKind === "video") ||
    (activeTool === "image" && opts.image!.op === "compress");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-2 pt-4 sm:max-w-lg">
      <header className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold leading-none tracking-tight">MpBuddy</h1>
          <p className="mt-1.5 text-[12px] leading-snug text-neutral-500">
            Everything runs on your device.
          </p>
        </div>
        {engineNote && engineVisible && (
          <p
            role="status"
            className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-neutral-600"
          >
            <span
              className={
                "size-1.5 rounded-full " + (engineNote.busy ? "animate-pulse bg-amber-500" : "bg-emerald-500")
              }
            />
            {engineNote.text}
          </p>
        )}
      </header>

      <nav
        className="mt-4 grid grid-cols-3 gap-1 rounded-[20px] bg-black/[0.06] p-1 sm:grid-cols-6"
        aria-label="Tools"
      >
        {TOOLS.map((t) => {
          const active = t.id === activeTool;
          return (
            <button
              key={t.id}
              className={
                (active
                  ? "rounded-[15px] bg-white text-neutral-900 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
                  : "rounded-[15px] text-neutral-500 transition-colors hover:text-neutral-800") +
                " flex min-h-[62px] flex-col items-center justify-center gap-1 px-1 py-2 text-center"
              }
              aria-pressed={active}
              onClick={() => handleSelectTool(t.id)}
            >
              <span aria-hidden="true" className={active ? "text-accent" : ""}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                  dangerouslySetInnerHTML={{ __html: t.icon }}
                />
              </span>
              <span className="text-[11px] font-medium tracking-tight">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-5 px-1">
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{tool.label}</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-neutral-500">{tool.hint}</p>
      </div>

      <main className="mt-4 flex flex-col gap-2.5" aria-busy={running}>
        {picked ? (
          <div className="card card-tint flex items-center gap-3 rounded-[22px] p-3">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-accent/10 text-accent"
            >
              {pickedKind === "audio" ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M10 9l5 3l-5 3z" />
                </svg>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block max-w-full truncate text-[14px] font-semibold tracking-tight">
                {picked.name}
              </span>
              <span className="mt-0.5 block text-xs tabular-nums text-neutral-500">{fileMeta}</span>
              {sizeWarn && (
                <span className="mt-1 block max-w-full text-xs font-medium text-amber-600">
                  {sizeWarn}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-apple-secondary shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium text-neutral-700"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={handleRemoveFile}
              aria-label="Remove file"
              className="grid size-9 shrink-0 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M18 6l-12 12" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {rejected && (
              <p className="rounded-[14px] bg-amber-100 px-3 py-2 text-[12px] font-medium text-amber-800">
                {rejected.name}: {rejected.message}
              </p>
            )}
            <button
              type="button"
              className="group flex min-h-40 flex-col items-center justify-center gap-2 rounded-[22px] border border-dashed border-black/15 bg-white/60 px-6 py-6 text-center transition-colors hover:border-accent/50 hover:bg-white"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="grid size-12 place-items-center rounded-full bg-accent/10 text-accent transition-transform group-hover:scale-105">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 16V4" />
                  <path d="M7 9l5-5l5 5" />
                  <path d="M20 16v2a2 2 0 0 1 -2 2H6a2 2 0 0 1 -2 -2v-2" />
                </svg>
              </span>
              <span className="mt-1 text-[15px] font-semibold tracking-tight">
                Drop a video or audio file
              </span>
              <span className="text-[13px] text-neutral-500">or tap to browse</span>
              <span className="mt-1 text-[11px] text-neutral-400">
                MP4 · MOV · WebM · MP3 · WAV · up to 200 MB
              </span>
            </button>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={tool.accept}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files ?? null);
            e.target.value = "";
          }}
        />

        {batchQueue.length > 0 && (
          <div className="rounded-[14px] bg-accent/[0.07] px-3 py-2 text-[12px] text-neutral-700">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {activeTool === "merge" ? `${batchQueue.length + 1} files to merge` : `${batchQueue.length + 1} files queued`}
                </span>{" "}
                {activeTool === "merge"
                  ? "— they join into one video, in this order."
                  : "— they run one after another, and you get the last result."}
              </span>
              <button
                type="button"
                onClick={() => setBatchQueue([])}
                className="shrink-0 text-[12px] font-semibold text-accent"
              >
                Clear
              </button>
            </div>
            <ul className="mt-1.5 space-y-1">
              {batchQueue.slice(0, 5).map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-neutral-600">
                    {i + 2}. {f.name} · {formatBytes(f.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setBatchQueue((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 text-neutral-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </li>
              ))}
              {batchQueue.length > 5 && (
                <li className="text-neutral-400">and {batchQueue.length - 5} more…</li>
              )}
            </ul>
          </div>
        )}
        {activeTool === "merge" && batchQueue.length === 0 && picked && (
          <p className="rounded-[14px] bg-accent/[0.07] px-3 py-2 text-[12px] leading-snug text-neutral-700">
            Add more files to merge: drop them anywhere or pick again — they queue up and
            join in order.
          </p>
        )}

        <section className="cardd card-tintt roundedd-[22px] p-2">
          {activeTool === "compress" && (
            <div className="flex flex-col gap-2">
              <Field label="Quality" group inline>
                <Segmented
                  value={opts.compress!.quality!}
                  options={[
                    ["high", "High"],
                    ["med", "Medium"],
                    ["low", "Low"],
                  ]}
                  onChange={(v) => patchOpt("compress", "quality", v)}
                />
              </Field>
              <Field label="Max height" group inline>
                <Segmented
                  cols={4}
                  value={opts.compress!.maxH!}
                  options={[
                    ["orig", "Original"],
                    ["1080", "1080p"],
                    ["720", "720p"],
                    ["480", "480p"],
                  ]}
                  onChange={(v) => patchOpt("compress", "maxH", v)}
                />
              </Field>
              {compressEstimate && (
                <p className="text-[12px] leading-snug text-neutral-500">
                  Roughly{" "}
                  <span className="font-semibold tabular-nums text-neutral-700">
                    {compressEstimate.bytes}
                  </span>{" "}
                  — about {compressEstimate.pct}% smaller than the original.
                </p>
              )}
            </div>
          )}

          {activeTool === "trim" && (
            <div className="flex flex-col gap-2">
              <Field label="What to do" group inline>
                <Segmented
                  cols={2}
                  value={opts.trim!.mode ?? "keep"}
                  options={[
                    ["keep", "Keep a range"],
                    ["remove", "Cut sections out"],
                  ]}
                  onChange={(v) => patchOpt("trim", "mode", v)}
                />
              </Field>
              {trimMode(opts.trim!) === "keep" ? (
                <>
                  <Field
                    label="Cut mode"
                    group
                    inline
                    hint={
                      opts.trim!.exact === "on"
                        ? "Exact re-encodes, so the cut lands on the frame you picked. Slower on long clips."
                        : "Fast copies whole chunks and starts at the nearest keyframe — quick, but the cut can drift a moment."
                    }
                  >
                    <Segmented
                      cols={2}
                      value={opts.trim!.exact ?? "off"}
                      options={[
                        ["off", "Fast copy"],
                        ["on", "Exact"],
                      ]}
                      onChange={(v) => patchOpt("trim", "exact", v)}
                    />
                  </Field>
                  {(opts.trim!.exact ?? "off") === "off" && (
                    <Switch
                      label="Snap to keyframes"
                      checked={(opts.trim!.snap ?? "on") === "on"}
                      onChange={(v) => patchOpt("trim", "snap", v ? "on" : "off")}
                    />
                  )}
                </>
              ) : (
                <p className="text-[11px] leading-snug text-neutral-400">
                  Mark every section you want gone — the head and tail are kept and joined back
                  together. Always re-encodes.
                </p>
              )}
              <TrimEditor
                mode={trimMode(opts.trim!)}
                start={opts.trim!.start ?? ""}
                end={opts.trim!.end ?? ""}
                cuts={opts.trim!.cuts ?? ""}
                onStart={(v) => patchOpt("trim", "start", v)}
                onEnd={(v) => patchOpt("trim", "end", v)}
                onCuts={(v) => patchOpt("trim", "cuts", v)}
                onCommit={(s, e) =>
                  setOpts((prev) => ({ ...prev, trim: { ...prev.trim, start: s, end: e } }))
                }
                picked={picked}
                pickedUrl={pickedUrl}
                pickedKind={pickedKind}
                duration={pickedDuration}
                running={running}
              />
            </div>
          )}

          {activeTool === "mp3" && (
            <div className="flex flex-col gap-2">
              <Field
                label="Bitrate"
                group
                inline
                hint={
                  pickedKind === "audio"
                    ? "Re-encodes the audio it already has."
                    : "192 kbps is about the ceiling where MP3 stops sounding worse than the source."
                }
              >
                <Segmented
                  value={opts.mp3!.bitrate!}
                  options={[
                    ["128k", "128 kbps"],
                    ["192k", "192 kbps"],
                    ["256k", "256 kbps"],
                  ]}
                  onChange={(v) => patchOpt("mp3", "bitrate", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "convert" && (
            <div className="flex flex-col gap-2">
              <Field label="Output" group inline>
                <Segmented
                  cols={4}
                  value={opts.convert!.format!}
                  options={OUTPUT_FORMATS}
                  onChange={(v) => patchOpt("convert", "format", v)}
                />
              </Field>
              {opts.convert!.format === "gif" ? (
                <p className="rounded-[12px] bg-black/[0.04] px-3 py-2 text-[12px] leading-snug text-neutral-600">
                  {GIF_MAX_SEC} seconds, no sound, 480px wide.
                  {gifTooLong && (
                    <span className="font-semibold text-amber-700">
                      {" "}
                      This clip is {fmtTime(pickedDuration!)} — only the first {GIF_MAX_SEC}s will be
                      exported.
                    </span>
                  )}
                </p>
              ) : opts.convert!.format === "mp3" ? (
                <p className="rounded-[12px] bg-black/[0.04] px-3 py-2 text-[12px] leading-snug text-neutral-600">
                  Audio only — the picture is dropped and the file comes out at 192 kbps.
                </p>
              ) : (
                <>
                  <Field label="Vertical 9:16" group inline>
                    <Segmented
                      value={opts.convert!.shorts!}
                      options={[
                        ["off", "Off"],
                        ["pad", "Pad"],
                        ["crop", "Crop"],
                      ]}
                      onChange={(v) => patchOpt("convert", "shorts", v)}
                    />
                  </Field>
                  <Field
                    label="Target size"
                    group
                    inline
                    hint={
                      (opts.convert!.targetMB ?? "off") === "off"
                        ? "Off keeps the quality setting ffmpeg picks for the format."
                        : "Caps the bitrate to land under this size. Duration is unknown until a file is picked."
                    }
                  >
                    <Segmented
                      cols={4}
                      value={opts.convert!.targetMB!}
                      options={[
                        ["off", "Off"],
                        ["10", "<10 MB"],
                        ["25", "<25 MB"],
                        ["50", "<50 MB"],
                      ]}
                      onChange={(v) => patchOpt("convert", "targetMB", v)}
                    />
                  </Field>
                  <Field label="Sound" group inline>
                    <Segmented
                      cols={2}
                      value={opts.convert!.audio!}
                      options={[
                        ["keep", "Keep audio"],
                        ["mute", "Remove audio"],
                      ]}
                      onChange={(v) => patchOpt("convert", "audio", v)}
                    />
                  </Field>
                </>
              )}
            </div>
          )}

          {activeTool === "crop" && (
            <div className="flex flex-col gap-2">
              <Field label="Shape" group inline>
                <Segmented
                  cols={3}
                  value={opts.crop!.ratio!}
                  options={CROP_RATIOS}
                  onChange={(v) => patchOpt("crop", "ratio", v)}
                />
              </Field>
              {opts.crop!.ratio === "custom" && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width">
                    <TextInput
                      value={opts.crop!.customW ?? ""}
                      placeholder="4"
                      inputMode="decimal"
                      ariaLabel="Custom ratio width"
                      onChange={(v) => patchOpt("crop", "customW", v)}
                    />
                  </Field>
                  <Field label="Height">
                    <TextInput
                      value={opts.crop!.customH ?? ""}
                      placeholder="5"
                      inputMode="decimal"
                      ariaLabel="Custom ratio height"
                      onChange={(v) => patchOpt("crop", "customH", v)}
                    />
                  </Field>
                </div>
              )}
              <Field
                label="Focal point — tap the frame"
                group
                hint="Keeps the area around your tap, so faces stay in shot."
              >
                <div
                  className="relative h-24 touch-none rounded-[14px] border border-black/10 bg-gradient-to-br from-neutral-100 to-neutral-200"
                  onPointerDown={(e) => {
                    const el = e.currentTarget;
                    const r = el.getBoundingClientRect();
                    const setFrom = (clientX: number, clientY: number) => {
                      const x = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
                      const y = Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100));
                      setOpts((prev) => ({
                        ...prev,
                        crop: { ...prev.crop, focalX: String(Math.round(x)), focalY: String(Math.round(y)) },
                      }));
                    };
                    setFrom(e.clientX, e.clientY);
                    const move = (ev: PointerEvent) => setFrom(ev.clientX, ev.clientY);
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up, { once: true });
                  }}
                >
                  <div
                    className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white shadow"
                    style={{
                      left: `${Math.max(0, Math.min(100, Number(opts.crop!.focalX ?? "50") || 50))}%`,
                      top: `${Math.max(0, Math.min(100, Number(opts.crop!.focalY ?? "50") || 50))}%`,
                    }}
                  />
                </div>
              </Field>
              <div className="flex items-center gap-3 rounded-[14px] bg-black/[0.04] px-3 py-2">
                <div className="grid h-12 w-12 shrink-0 place-items-center">
                  {cropPreview ? (
                    <div
                      className="max-h-full max-w-full rounded-[4px] border-2 border-accent bg-accent/15"
                      style={{
                        aspectRatio: `${cropPreview.W} / ${cropPreview.H}`,
                        ...(cropPreview.W / cropPreview.H >= 1
                          ? { width: "100%", height: "auto" }
                          : { width: "auto", height: "100%" }),
                      }}
                    />
                  ) : (
                    <div
                      className="rounded-[4px] border-2 border-accent bg-accent/15"
                      style={{ width: "1.75rem", height: "1.75rem" }}
                    />
                  )}
                </div>
                <p className="text-xs leading-snug text-neutral-500">
                  {cropPreview ? (
                    <>
                      <span className="font-semibold text-neutral-800">
                        {cropName} · {cropPreview.W}:{cropPreview.H}
                      </span>
                      <br />
                      Full resolution, cropped to that shape. No black bars, no stretch.
                    </>
                  ) : (
                    "Enter a width and height above — 4 and 5 gives you 4:5."
                  )}
                </p>
              </div>
            </div>
          )}

          {activeTool === "thumbnail" && (
            <div className="flex flex-col gap-2">
              <Field label="Frame at" inline hint="Seconds, or m:ss — 90 and 1:30 both work.">
                <TextInput
                  value={opts.thumbnail!.frameAt ?? "0:01"}
                  placeholder="0:01"
                  ariaLabel="Frame time"
                  onChange={(v) => patchOpt("thumbnail", "frameAt", v)}
                />
              </Field>
              {pickedDuration != null && (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Start", 0],
                    ["Middle", pickedDuration / 2],
                    ["End", Math.max(0, pickedDuration - 0.5)],
                  ].map(([label, at]) => (
                    <button
                      key={label as string}
                      type="button"
                      onClick={() => patchOpt("thumbnail", "frameAt", fmtTrim(at as number))}
                      className="btn-apple-secondary flex min-h-10 flex-col items-center justify-center rounded-[12px] text-[13px] font-semibold text-neutral-800"
                    >
                      {label as string}
                      <span className="text-[11px] font-medium tabular-nums text-neutral-500">
                        {fmtTrim(at as number)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTool === "rotate" && (
            <div className="flex flex-col gap-2">
              <Field label="Direction" group inline hint="Always re-encodes so the rotation sticks everywhere.">
                <Segmented
                  cols={3}
                  value={opts.rotate!.dir!}
                  options={[
                    ["cw", "90° CW"],
                    ["ccw", "90° CCW"],
                    ["180", "180°"],
                    ["hflip", "Flip ↔"],
                    ["vflip", "Flip ↕"],
                  ]}
                  onChange={(v) => patchOpt("rotate", "dir", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "speed" && (
            <div className="flex flex-col gap-2">
              <Field label="Speed" group inline hint="Audio tempo adjusts to match — no chipmunks.">
                <Segmented
                  cols={3}
                  value={opts.speed!.rate!}
                  options={[
                    ["0.5", "0.5×"],
                    ["0.75", "0.75×"],
                    ["1.25", "1.25×"],
                    ["1.5", "1.5×"],
                    ["2", "2×"],
                  ]}
                  onChange={(v) => patchOpt("speed", "rate", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "volume" && (
            <div className="flex flex-col gap-2">
              <Field label="Level" group inline hint="Loudness keeps the video stream untouched, so it stays fast.">
                <Segmented
                  cols={4}
                  value={opts.volume!.mode!}
                  options={[
                    ["louder", "2× Louder"],
                    ["quiet", "Half"],
                    ["norm", "Normalize"],
                    ["mute", "Mute"],
                  ]}
                  onChange={(v) => patchOpt("volume", "mode", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "fade" && (
            <div className="flex flex-col gap-2">
              <Field label="Apply to" group inline>
                <Segmented
                  cols={3}
                  value={opts.fade!.which!}
                  options={[
                    ["in", "Fade in"],
                    ["out", "Fade out"],
                    ["both", "Both"],
                  ]}
                  onChange={(v) => patchOpt("fade", "which", v)}
                />
              </Field>
              <Field label="Duration" group inline>
                <Segmented
                  cols={3}
                  value={opts.fade!.seconds!}
                  options={[
                    ["0.5", "0.5s"],
                    ["1", "1s"],
                    ["2", "2s"],
                  ]}
                  onChange={(v) => patchOpt("fade", "seconds", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "merge" && (
            <p className="rounded-[12px] bg-black/[0.04] px-3 py-2 text-[12px] leading-snug text-neutral-600">
              Everything is normalized to 720p30 + AAC so mismatched clips join cleanly.
              Mixed-size videos get letterboxed, not stretched.
            </p>
          )}

          {activeTool === "loop" && (
            <div className="flex flex-col gap-2">
              <Field label="Mode" group inline>
                <Segmented
                  cols={2}
                  value={opts.loop!.mode!}
                  options={[
                    ["loop", "Repeat"],
                    ["boomerang", "Boomerang"],
                  ]}
                  onChange={(v) => patchOpt("loop", "mode", v)}
                />
              </Field>
              {opts.loop!.mode !== "boomerang" && (
                <Field label="Repeats" group inline>
                  <Segmented
                    cols={4}
                    value={opts.loop!.times!}
                    options={[
                      ["2", "×2"],
                      ["3", "×3"],
                      ["4", "×4"],
                      ["8", "×8"],
                    ]}
                    onChange={(v) => patchOpt("loop", "times", v)}
                  />
                </Field>
              )}
            </div>
          )}

          {activeTool === "reverse" && (
            <p className="rounded-[12px] bg-black/[0.04] px-3 py-2 text-[12px] leading-snug text-neutral-600">
              The whole clip plays backwards, audio included. Long clips take a moment —
              reverse buffers the entire video before writing.
            </p>
          )}

          {activeTool === "resize" && (
            <div className="flex flex-col gap-2">
              <Field label="Max height" group inline hint="Downscale only — small clips never get stretched bigger.">
                <Segmented
                  cols={4}
                  value={opts.resize!.maxH!}
                  options={[
                    ["orig", "Original"],
                    ["1080", "1080p"],
                    ["720", "720p"],
                    ["480", "480p"],
                  ]}
                  onChange={(v) => patchOpt("resize", "maxH", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "filter" && (
            <div className="flex flex-col gap-2">
              <Field label="Look" group inline>
                <Segmented
                  cols={4}
                  value={opts.filter!.preset!}
                  options={[
                    ["normal", "Normal"],
                    ["vivid", "Vivid"],
                    ["faded", "Faded"],
                    ["bw", "B&W"],
                    ["sepia", "Sepia"],
                    ["warm", "Warm"],
                    ["cool", "Cool"],
                  ]}
                  onChange={(v) => patchOpt("filter", "preset", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "frames" && (
            <div className="flex flex-col gap-2">
              <Field label="Every" group inline>
                <Segmented
                  cols={4}
                  value={opts.frames!.every!}
                  options={[
                    ["1", "1s"],
                    ["2", "2s"],
                    ["5", "5s"],
                    ["10", "10s"],
                  ]}
                  onChange={(v) => patchOpt("frames", "every", v)}
                />
              </Field>
              <Field label="Format" group inline>
                <Segmented
                  cols={2}
                  value={opts.frames!.fmt!}
                  options={[
                    ["png", "PNG"],
                    ["jpg", "JPG"],
                  ]}
                  onChange={(v) => patchOpt("frames", "fmt", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "image" && (
            <div className="flex flex-col gap-2">
              <Field label="Do" group inline>
                <Segmented
                  cols={3}
                  value={opts.image!.op!}
                  options={[
                    ["compress", "Compress"],
                    ["resize", "Resize"],
                    ["convert", "Convert"],
                  ]}
                  onChange={(v) => patchOpt("image", "op", v)}
                />
              </Field>
              {opts.image!.op === "compress" && (
                <Field label="Quality" group inline>
                  <Segmented
                    value={opts.image!.quality!}
                    options={[
                      ["high", "High"],
                      ["med", "Medium"],
                      ["low", "Low"],
                    ]}
                    onChange={(v) => patchOpt("image", "quality", v)}
                  />
                </Field>
              )}
              {opts.image!.op === "resize" && (
                <Field label="Max width" group inline>
                  <Segmented
                    cols={4}
                    value={opts.image!.maxW!}
                    options={[
                      ["orig", "Original"],
                      ["1920", "1920"],
                      ["1280", "1280"],
                      ["800", "800"],
                    ]}
                    onChange={(v) => patchOpt("image", "maxW", v)}
                  />
                </Field>
              )}
              {opts.image!.op === "convert" && (
                <Field label="Format" group inline>
                  <Segmented
                    cols={3}
                    value={opts.image!.format!}
                    options={[
                      ["webp", "WebP"],
                      ["jpg", "JPG"],
                      ["png", "PNG"],
                    ]}
                    onChange={(v) => patchOpt("image", "format", v)}
                  />
                </Field>
              )}
            </div>
          )}
        </section>

        {failure && (
          <section className="card card-warn rounded-[22px] p-3">
            <p className="text-[14px] font-semibold tracking-tight text-amber-900">
              {failure.title}
            </p>
            {failure.hint && (
              <p className="mt-1 text-[13px] leading-snug text-amber-800">{failure.hint}</p>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] font-medium text-amber-700">
                Technical details
              </summary>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-amber-100/70 p-2 text-[11px] text-amber-900">
                {failure.detail}
              </pre>
            </details>
          </section>
        )}

        {resultUrl && resultFile && (
          <section ref={resultWrapRef} className="card card-good rounded-[22px] p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-semibold tracking-tight text-neutral-800">Saved</p>
              <p className="truncate text-[12px] tabular-nums text-neutral-500">{resultMeta}</p>
            </div>
            {compressCompare && pickedUrl && (resultKind === "video" || resultKind === "image") ? (
              <div className="mt-3">
                <ComparePreview
                  before={pickedUrl}
                  after={resultUrl}
                  kind={resultKind === "video" ? "video" : "image"}
                />
              </div>
            ) : (
              resultKind === "video" && (
                <video
                  src={resultUrl}
                  controls
                  playsInline
                  className="mt-3 max-h-64 w-full rounded-2xl bg-black"
                />
              )
            )}
            {resultKind === "audio" && <audio src={resultUrl} controls className="mt-3 w-full" />}
            {resultKind === "image" && !compressCompare && (
              <img
                src={resultUrl}
                alt="Converted image preview"
                className="mt-3 max-h-64 w-full rounded-2xl bg-black object-contain"
              />
            )}
            {frameFiles.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] font-medium text-neutral-500">
                  Extracted frames — tap one to download it.
                </p>
                <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
                  {frameFiles.map((f) => (
                    <a
                      key={f.name}
                      href={URL.createObjectURL(f)}
                      download={f.name}
                      className="shrink-0"
                    >
                      <img
                        src={URL.createObjectURL(f)}
                        alt={f.name}
                        className="h-16 w-auto rounded-[8px] border border-black/10 bg-black"
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {resultKind === "gif" && (
              <img
                src={resultUrl}
                alt="Converted GIF preview"
                className="mt-3 max-h-64 w-full rounded-2xl bg-black object-contain"
              />
            )}
            {picked && (
              <dl className="mt-3 grid grid-cols-3 gap-2 rounded-[14px] bg-white/70 p-2.5">
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                    In
                  </dt>
                  <dd className="text-[13px] font-semibold tabular-nums text-neutral-800">
                    {formatBytes(picked.size)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                    Out
                  </dt>
                  <dd className="text-[13px] font-semibold tabular-nums text-neutral-800">
                    {formatBytes(resultFile.size)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                    Change
                  </dt>
                  <dd
                    className={
                      "text-[13px] font-semibold tabular-nums " +
                      (change.startsWith("−") ? "text-emerald-700" : "text-neutral-800")
                    }
                  >
                    {change}
                  </dd>
                </div>
              </dl>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => void handleRunClick()}
                className="btn-apple-secondary min-h-11 rounded-[12px] text-[13px] font-semibold text-neutral-800"
              >
                Run again
              </button>
              <button
                type="button"
                onClick={() => {
                  clearResult();
                  setFailure(null);
                  fileInputRef.current?.click();
                }}
                className="btn-apple-secondary min-h-11 rounded-[12px] text-[13px] font-semibold text-neutral-800"
              >
                Another file
              </button>
            </div>
          </section>
        )}

        <details className="card card-tint rounded-[22px] p-3 text-[13px] leading-relaxed text-neutral-500">
          <summary className="cursor-pointer font-medium text-neutral-700">Limits &amp; privacy</summary>
          <ul className="mt-2.5 list-disc space-y-1.5 pl-4">
            <li>
              Everything runs locally via ffmpeg.wasm. No uploads, works offline after first load.
            </li>
            <li>
              Best for clips &lt; 2 min, ≤1080p, &lt;200 MB desktop / &lt;50 MB mobile. Bigger files
              can crash mobile tabs.
            </li>
            <li>First run downloads a ~30 MB engine once, then it&apos;s cached.</li>
          </ul>
        </details>

        {jobHistory.length > 0 && (
          <section className="card card-tint rounded-[22px] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold tracking-tight text-neutral-800">
                Recent jobs
              </p>
              <button
                type="button"
                onClick={clearHistory}
                className="text-[12px] font-medium text-neutral-400 hover:text-neutral-600"
              >
                Clear
              </button>
            </div>
            <ul className="mt-2 space-y-2">
              {jobHistory.slice(0, 5).map((j) => (
                <li
                  key={j.id}
                  className="flex items-center justify-between gap-2 rounded-[10px] bg-black/[0.04] px-2.5 py-2"
                >
                  <div className="min-w-0 text-[12px] text-neutral-600">
                    <p className="truncate font-medium text-neutral-800">{j.fileName}</p>
                    <p className="tabular-nums">
                      {toolById(j.tool).label} · {formatBytes(j.inputBytes)} →{" "}
                      {formatBytes(j.outputBytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => rerunFromHistory(j)}
                    className="btn-apple-secondary shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold text-neutral-700"
                  >
                    Reuse
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="mt-8 flex flex-col items-center gap-2 border-t border-black/[0.06] pt-5 pb-2 text-center">
        <a
          href="https://x.com/tanavtwt"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-apple-secondary flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-neutral-600"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span>@tanavtwt</span>
        </a>
        <p className="text-[11px] text-neutral-400">Files never leave this device · Built in the open</p>
      </footer>

      {/* The job bar: one surface that always holds the next useful action, so
          nothing important sits below the fold on a phone. */}
      <div
        data-jobbar=""
        className="sticky bottom-0 z-30 -mx-4 mt-2 px-4 pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-0 -z-10 bg-gradient-to-t from-[#f5f5f7] via-[#f5f5f7]/90 to-transparent"
        />
        <div className="rounded-[22px] border border-black/[0.07] bg-white/85 p-2 shadow-[0_-2px_30px_-16px_rgb(0_0_0/0.35)] backdrop-blur-xl">
          {running ? (
            <div className="px-1 py-1" role="status" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-[13px] font-semibold tracking-tight text-neutral-800">
                  {runningLabel}
                </p>
                <p className="shrink-0 text-[13px] font-semibold tabular-nums text-neutral-500">
                  {Math.round(progress * 100)}%
                </p>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/[0.08]">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={handleCancel}
                className="btn-apple-secondary mt-2 min-h-10 w-full rounded-[12px] text-[13px] font-semibold text-neutral-700"
              >
                Cancel
              </button>
            </div>
          ) : resultUrl && resultFile ? (
            <div className="flex gap-2.5">
              <a
                id="downloadBtn"
                href={resultUrl}
                download={resultFile.name}
                className="btn-apple-primary grid min-h-14 flex-1 place-items-center rounded-[16px] text-[16px] font-semibold no-underline"
              >
                Download · {formatBytes(resultFile.size)}
              </a>
              {shareSupported && (
                <button
                  type="button"
                  onClick={() => void handleShare()}
                  className="btn-apple-secondary min-h-14 rounded-[16px] px-4 text-[15px] font-semibold text-neutral-800"
                >
                  {shareLabel}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {picked && validationError ? (
                <p role="status" className="px-1 text-[12px] font-medium leading-snug text-red-600">
                  {validationError}
                </p>
              ) : !picked && !engineReady ? (
                <p className="px-1 text-[12px] leading-snug text-neutral-400">
                  First run downloads a ~30 MB engine, then it&apos;s cached.
                </p>
              ) : null}
              <button
                type="button"
                disabled={runDisabled}
                onClick={() => void handleRunClick()}
                className="btn-apple-primary min-h-14 rounded-[16px] text-[16px] font-semibold"
              >
                {picked ? runLabel : "Pick a file to start"}
              </button>
            </div>
          )}
        </div>
      </div>

      {dragActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-[#f5f5f7]/85 backdrop-blur-sm"
        >
          <p className="rounded-[22px] border-2 border-dashed border-accent bg-white px-10 py-12 text-center text-[15px] font-semibold tracking-tight">
            Drop it anywhere to load
          </p>
        </div>
      )}

      <PwaStatus />
    </div>
  );
}
