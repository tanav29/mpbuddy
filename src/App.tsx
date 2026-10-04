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
  parseTime,
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
import {
  Field,
  RangeSlider,
  Segmented,
  Slider,
  Switch,
  TextInput,
  trimNum,
} from "./components/fields";
import PwaStatus from "./components/PwaStatus";
import TrimEditor, { type PickedKind } from "./components/TrimEditor";
import ComparePreview from "./components/ComparePreview";
import ToolPicker from "./components/ToolPicker";
import RecentJobs from "./components/RecentJobs";
import {
  clearHistory as forgetHistory,
  loadHistory,
  newJobId,
  saveHistory,
  type JobHistory,
} from "./history";

type Opts = Record<ToolId, Record<string, string>>;
/** "idle" = waiting for input, otherwise ffmpeg is busy. */
type Phase = "idle" | "loading" | "working";
type Failure = { title: string; hint: string | null; detail: string };

/**
 * Two pages, not one long scroll: the index lists every tool, the tool page
 * does one job. Kept in the hash so the browser's back button walks back out
 * of a tool instead of leaving the app.
 */
type View = { name: "home" } | { name: "tool"; id: ToolId };

function readHash(): View {
  const m = /^#\/tool\/([a-z0-9]+)$/.exec(window.location.hash);
  const id = m?.[1] as ToolId | undefined;
  if (id && TOOLS.some((t) => t.id === id)) return { name: "tool", id };
  return { name: "home" };
}

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

/**
 * Limits, stripped of container boxes per the house style: items separated by
 * hairlines only, with a sharp + / − toggle.
 */
function LimitsNote() {
  return (
    <details className="group border-t border-[#eaeaea] pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[14px] font-semibold text-[#111] [&::-webkit-details-marker]:hidden">
        <span>Limits &amp; privacy</span>
        <span aria-hidden="true" className="font-mono text-[16px] font-normal text-[#a3a099] group-open:hidden">
          +
        </span>
        <span aria-hidden="true" className="hidden font-mono text-[16px] font-normal text-[#a3a099] group-open:inline">
          −
        </span>
      </summary>
      <ul className="mt-1 divide-y divide-[#eaeaea] text-[14px] leading-relaxed text-[#55534e]">
        <li className="py-2.5">
          Everything runs locally via ffmpeg.wasm. No uploads, works offline after first load.
        </li>
        <li className="py-2.5">
          Best for clips under 2 min, 1080p or less, and files under 200 MB.
        </li>
        <li className="py-2.5">First run downloads a ~30 MB engine once, then it&apos;s cached.</li>
      </ul>
    </details>
  );
}

export default function App() {
  const [view, setView] = useState<View>(readHash);
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
  // Only the tool page has one; the index shows every tool at once instead.
  const onIndex = view.name === "home";
  const activeTool: ToolId = view.name === "tool" ? view.id : "compress";
  const tool = toolById(activeTool);
  const pickedKind = pickedKindOf(picked);
  const validationError = tool.validate?.(opts[activeTool]!) ?? null;
  const engineReady = engineState().state === "ready";

  const go = useCallback((next: View) => {
    const hash = next.name === "home" ? "#/" : `#/tool/${next.id}`;
    if (window.location.hash === hash) {
      setView(next);
      return;
    }
    // The hashchange listener below picks this up.
    window.location.hash = hash;
  }, []);

  const patchOpt = useCallback((id: ToolId, key: string, value: string) => {
    setOpts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }, []);

  useEffect(() => {
    const onHash = (): void => setView(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Every page change starts at the top — an editor scrolled halfway down is
  // disorienting when you land on it fresh.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

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

  const clearPicked = useCallback(() => {
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
  }, [clearResult]);

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
      go({ name: "tool", id });
      clearResult();
      setFailure(null);
      // A picture can't feed a video tool, or the other way round. Better to
      // drop it here than to fail at run time with a confusing error.
      const cur = pickedRef.current;
      const wantsImage = toolById(id).acceptKind === "image";
      if (cur && wantsImage !== (fileKind(cur) === "image")) clearPicked();
    },
    [clearPicked, clearResult, go],
  );

  const handleFile = useCallback(
    async (f: File) => {
      setFailure(null);
      setRejected(null);
      // A drop on the index would go nowhere, since only a tool page can show
      // a file. Land on the tool that handles this kind.
      if (onIndex) go({ name: "tool", id: fileKind(f) === "image" ? "image" : "compress" });
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
            ? "Images only works on pictures. Pick a video or audio tool instead."
            : "That's a picture — the Images tool is the one for it.",
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
    [clearResult, activeTool, onIndex, go],
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
            id: newJobId(),
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
            id: newJobId(),
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

  const handleRemoveFile = clearPicked;

  const handleShare = async (): Promise<void> => {
    if (!resultFile) return;
    const r = await shareFile(resultFile);
    if (r === "shared") {
      setShareLabel("Shared");
      setTimeout(() => setShareLabel("Share"), 2000);
    } else if (r === "unsupported") {
      // No share sheet for this file — hand them the download instead.
      document.getElementById("downloadBtn")?.click();
    }
  };

  const rerunFromHistory = (job: JobHistory): void => {
    setOpts((prev) => ({ ...prev, [job.tool]: { ...prev[job.tool], ...job.opts } }));
    handleSelectTool(job.tool);
  };

  const clearHistory = (): void => {
    setJobHistory([]);
    forgetHistory();
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
    saveHistory(jobHistory);
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
  const wantsImage = tool.acceptKind === "image";

  /** Compress (video or image) gets a Squoosh-style before/after slider. */
  const compressCompare =
    (activeTool === "compress" && pickedKind === "video") ||
    (activeTool === "image" && opts.image!.op === "compress");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-5 pb-6 sm:px-8 lg:px-10">
      <header className="sticky top-0 z-40 -mx-5 border-b border-[#eaeaea] bg-[#f7f6f3]/85 px-5 backdrop-blur sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4">
          {view.name === "tool" ? (
            // On a tool page the way out matters more than the brand mark.
            <button
              type="button"
              onClick={() => go({ name: "home" })}
              className="btn-secondary flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-[14px] font-semibold"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-4"
              >
                <path d="M15 6l-6 6l6 6" />
              </svg>
              All tools
            </button>
          ) : (
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="font-serif text-[22px] font-semibold tracking-[-0.02em] text-[#111]">
                MpBuddy
              </span>
              <span className="hidden font-mono text-[11px] uppercase tracking-[0.08em] text-[#a3a099] sm:inline">
                Local media tools
              </span>
            </div>
          )}
          {engineNote && engineVisible && (
            <p
              role="status"
              className={
                "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] " +
                (engineNote.busy
                  ? "border-[#ebd9a8] bg-[#fbf3db] text-[#956400]"
                  : "border-[#cbe3cf] bg-[#edf3ec] text-[#346538]")
              }
            >
              <span
                className={
                  "size-1.5 rounded-full " +
                  (engineNote.busy ? "animate-pulse bg-[#956400]" : "bg-[#346538]")
                }
              />
              {engineNote.text}
            </p>
          )}
        </div>
      </header>

      {view.name === "home" ? (
        <main className="mt-10 flex flex-col gap-10 pb-8">
          <div className="max-w-2xl">
            <p className="section-label">Private · on-device · offline-capable</p>
            <h1 className="mt-3 font-serif text-[40px] font-medium leading-[1.1] tracking-[-0.02em] text-[#111] sm:text-[48px]">
              Media tools that never upload.
            </h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[#55534e]">
              Compress, trim, convert and crop with ffmpeg running in this tab. Pick a tool to
              start — your files stay on this machine.
            </p>
          </div>
          <ToolPicker onOpen={handleSelectTool} />
          <div className="grid items-start gap-8 lg:grid-cols-2">
            <RecentJobs
              jobs={jobHistory}
              onReuse={rerunFromHistory}
              onClear={clearHistory}
            />
            <LimitsNote />
          </div>
        </main>
      ) : (
        <>
          <main className="mt-8 grid items-start gap-6 pb-8 lg:grid-cols-[240px_minmax(0,1fr)_360px]" aria-busy={running}>
          <nav aria-label="Tools" className="hidden lg:block">
            <div className="sticky top-20">
              <p className="section-label px-2">Tools</p>
              <ul className="mt-2 space-y-0.5">
                {TOOLS.map((t) => {
                  const current = t.id === activeTool;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        aria-current={current ? "page" : undefined}
                        onClick={() => handleSelectTool(t.id)}
                        className={
                          "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[14px] font-medium transition-colors " +
                          (current
                            ? "border-[#111] bg-[#111] text-white"
                            : "border-transparent text-[#55534e] hover:border-[#e5e4e0] hover:bg-white hover:text-[#111]")
                        }
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className="size-4 shrink-0"
                          dangerouslySetInnerHTML={{ __html: t.icon }}
                        />
                        <span className="min-w-0 flex-1 truncate">{t.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>
          <div className="min-w-0 space-y-4">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden="true"
              className="grid size-11 shrink-0 place-items-center rounded-lg bg-[#111] text-white"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
                dangerouslySetInnerHTML={{ __html: tool.icon }}
              />
            </span>
            <div className="min-w-0 pt-0.5">
              <h1 className="font-serif text-[30px] font-medium leading-[1.15] tracking-[-0.02em] text-[#111]">
                {tool.label}
              </h1>
              <p className="mt-1 text-[14px] leading-snug text-[#787774]">{tool.hint}</p>
            </div>
          </div>
        {picked ? (
          <div className="panel flex items-center gap-3 p-5">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-md bg-[#f1f0ed] text-[#111]"
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
              ) : pickedKind === "image" ? (
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
                  <circle cx="9" cy="10" r="1.5" />
                  <path d="M4 18l5-5 3 3 4-4 4 4" />
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
              <span className="block max-w-full truncate text-[15px] font-semibold tracking-[-0.01em] text-[#111]">
                {picked.name}
              </span>
              <span className="mt-0.5 block font-mono text-[12px] tabular-nums text-[#787774]">{fileMeta}</span>
              {sizeWarn && (
                <span className="mt-1 block max-w-full text-xs font-medium text-[#956400]">
                  {sizeWarn}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-secondary shrink-0 px-3.5 py-2 text-[14px] font-medium"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={handleRemoveFile}
              aria-label="Remove file"
              className="grid size-9 shrink-0 place-items-center rounded-md text-[#a3a099] transition-colors hover:bg-[#fdebec] hover:text-[#9f2f2d]"
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
              <p className="rounded-lg border border-[#ebd9a8] bg-[#fbf3db] px-3.5 py-2.5 text-[13px] font-medium text-[#956400]">
                {rejected.name}: {rejected.message}
              </p>
            )}
            <button
              type="button"
              className="group flex min-h-56 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#d8d7d2] bg-white px-6 py-8 text-center transition-colors hover:border-[#111]"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="grid size-11 place-items-center rounded-lg bg-[#f1f0ed] text-[#111]">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
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
              <span className="mt-1.5 text-[16px] font-semibold tracking-[-0.01em] text-[#111]">
                Drop {wantsImage ? "an image" : "a video or audio file"}
              </span>
              <span className="text-[14px] text-[#787774]">or click to browse — paste works too</span>
              <span className="mt-1 font-mono text-[12px] uppercase tracking-[0.06em] text-[#a3a099]">
                {wantsImage ? "PNG · JPG · WebP" : "MP4 · MOV · WebM · MP3 · WAV · 200 MB"}
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
          <div className="rounded-lg border border-[#c4dff2] bg-[#e1f3fe] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#1f6c9f]">
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
                className="shrink-0 text-[13px] font-semibold underline underline-offset-2"
              >
                Clear
              </button>
            </div>
            <ul className="mt-1.5 space-y-1">
              {batchQueue.slice(0, 5).map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate tabular-nums">
                    {i + 2}. {f.name} · {formatBytes(f.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setBatchQueue((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 opacity-70 hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
              {batchQueue.length > 5 && (
                <li className="opacity-70">and {batchQueue.length - 5} more…</li>
              )}
            </ul>
          </div>
        )}
        {activeTool === "merge" && batchQueue.length === 0 && picked && (
          <p className="rounded-lg border border-[#c4dff2] bg-[#e1f3fe] px-3.5 py-2.5 text-[13px] leading-snug text-[#1f6c9f]">
            Add more files to merge: drop them anywhere or pick again — they queue up and
            join in order.
          </p>
        )}

        <section className="panel p-6 sm:p-7" aria-label="Settings">
          {activeTool === "compress" && (
            <div className="flex flex-col gap-2">
              <Slider
                label="Quality"
                value={opts.compress!.quality!}
                options={[
                  ["high", "High"],
                  ["med", "Medium"],
                  ["low", "Low"],
                ]}
                onChange={(v) => patchOpt("compress", "quality", v)}
                hint="Left keeps more detail and makes a bigger file."
              />
              <Slider
                label="Max height"
                value={opts.compress!.maxH!}
                options={[
                  ["orig", "Original"],
                  ["1080", "1080p"],
                  ["720", "720p"],
                  ["480", "480p"],
                ]}
                onChange={(v) => patchOpt("compress", "maxH", v)}
                hint="Only ever scales down — a small clip is never stretched."
              />
              {compressEstimate && (
                <p className="text-[13px] leading-snug text-neutral-500">
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
                <p className="text-[12px] leading-snug text-neutral-400">
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
              <Slider
                label="Bitrate"
                value={opts.mp3!.bitrate!}
                options={[
                  ["128k", "128 kbps"],
                  ["192k", "192 kbps"],
                  ["256k", "256 kbps"],
                ]}
                onChange={(v) => patchOpt("mp3", "bitrate", v)}
                hint={
                  pickedKind === "audio"
                    ? "Re-encodes the audio it already has."
                    : "192 kbps is about the ceiling where MP3 stops sounding worse than the source."
                }
              />
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
                <p className="rounded-lg border border-[#eaeaea] bg-[#fafaf8] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#55534e]">
                  {GIF_MAX_SEC} seconds, no sound, 480px wide.
                  {gifTooLong && (
                    <span className="font-semibold text-[#9f2f2d]">
                      {" "}
                      This clip is {fmtTime(pickedDuration!)} — only the first {GIF_MAX_SEC}s will be
                      exported.
                    </span>
                  )}
                </p>
              ) : opts.convert!.format === "mp3" ? (
                <p className="rounded-lg border border-[#eaeaea] bg-[#fafaf8] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#55534e]">
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
                  <Slider
                    label="Target size"
                    value={opts.convert!.targetMB ?? "off"}
                    options={[
                      ["off", "Off"],
                      ["10", "10 MB"],
                      ["25", "25 MB"],
                      ["50", "50 MB"],
                    ]}
                    onChange={(v) => patchOpt("convert", "targetMB", v)}
                    hint={
                      (opts.convert!.targetMB ?? "off") === "off"
                        ? "Off lets ffmpeg pick the quality for the format."
                        : "Caps the bitrate to land under this size. Duration is unknown until a file is picked."
                    }
                  />
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
                  className="relative h-28 touch-none rounded-lg border border-[#e0dfdb] bg-[#f1f0ed]"
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
                    className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#111] bg-white"
                    style={{
                      left: `${Math.max(0, Math.min(100, Number(opts.crop!.focalX ?? "50") || 50))}%`,
                      top: `${Math.max(0, Math.min(100, Number(opts.crop!.focalY ?? "50") || 50))}%`,
                    }}
                  />
                </div>
              </Field>
              <div className="flex items-center gap-3 rounded-lg border border-[#eaeaea] bg-[#fafaf8] px-3.5 py-2.5">
                <div className="grid h-12 w-12 shrink-0 place-items-center">
                  {cropPreview ? (
                    <div
                      className="max-h-full max-w-full rounded-[4px] border-2 border-[#111] bg-[#111]/[0.06]"
                      style={{
                        aspectRatio: `${cropPreview.W} / ${cropPreview.H}`,
                        ...(cropPreview.W / cropPreview.H >= 1
                          ? { width: "100%", height: "auto" }
                          : { width: "auto", height: "100%" }),
                      }}
                    />
                  ) : (
                    <div
                      className="rounded-[4px] border-2 border-[#111] bg-[#111]/[0.06]"
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
              {pickedDuration != null ? (
                <RangeSlider
                  label="Frame at"
                  value={parseTime(opts.thumbnail!.frameAt ?? "") ?? 0}
                  min={0}
                  max={Math.max(1, pickedDuration)}
                  step={0.1}
                  format={fmtTrim}
                  onChange={(v) => patchOpt("thumbnail", "frameAt", fmtTrim(v))}
                  hint="Drag along the clip, then run to save that frame as a JPG."
                />
              ) : (
                <Field
                  label="Frame at"
                  inline
                  hint="Pick a file and you can scrub its timeline here."
                >
                  <TextInput
                    value={opts.thumbnail!.frameAt ?? "0:01"}
                    placeholder="0:01"
                    ariaLabel="Frame time"
                    onChange={(v) => patchOpt("thumbnail", "frameAt", v)}
                  />
                </Field>
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
              <RangeSlider
                label="Speed"
                value={Number(opts.speed!.rate ?? "1.5") || 1.5}
                min={0.5}
                max={3}
                step={0.25}
                format={(v) => `${trimNum(v)}×`}
                ticks={[0.5, 1, 2]}
                onChange={(v) => patchOpt("speed", "rate", trimNum(v))}
                hint="1× is the original speed. Audio tempo follows it, so nobody sounds like a chipmunk."
              />
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
              <RangeSlider
                label="Fade length"
                value={Number(opts.fade!.seconds ?? "1") || 1}
                min={0.2}
                max={5}
                step={0.1}
                format={(v) => `${trimNum(v)}s`}
                onChange={(v) => patchOpt("fade", "seconds", trimNum(v))}
                hint="Half a second is a quick dip; a couple of seconds is a soft landing."
              />
            </div>
          )}

          {activeTool === "merge" && (
            <p className="rounded-lg border border-[#eaeaea] bg-[#fafaf8] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#55534e]">
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
                <Slider
                  label="Repeats"
                  value={opts.loop!.times ?? "2"}
                  options={[
                    ["2", "×2"],
                    ["3", "×3"],
                    ["4", "×4"],
                    ["5", "×5"],
                    ["6", "×6"],
                    ["7", "×7"],
                    ["8", "×8"],
                  ]}
                  onChange={(v) => patchOpt("loop", "times", v)}
                  hint="Each repeat re-encodes, so a high count takes a while."
                />
              )}
            </div>
          )}

          {activeTool === "reverse" && (
            <p className="rounded-lg border border-[#eaeaea] bg-[#fafaf8] px-3.5 py-2.5 text-[13px] leading-relaxed text-[#55534e]">
              The whole clip plays backwards, audio included. Long clips take a moment —
              reverse buffers the entire video before writing.
            </p>
          )}

          {activeTool === "resize" && (
            <div className="flex flex-col gap-2">
              <Slider
                label="Max height"
                value={opts.resize!.maxH!}
                options={[
                  ["orig", "Original"],
                  ["1080", "1080p"],
                  ["720", "720p"],
                  ["480", "480p"],
                ]}
                onChange={(v) => patchOpt("resize", "maxH", v)}
                hint="Downscale only — small clips never get stretched bigger."
              />
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
              <RangeSlider
                label="Save a frame every"
                value={Number(opts.frames!.every ?? "2") || 2}
                min={0.5}
                max={20}
                step={0.5}
                format={(v) => `${trimNum(v)}s`}
                ticks={[1, 5, 10]}
                onChange={(v) => patchOpt("frames", "every", trimNum(v))}
                hint="One second on a 60-second clip gives you 60 images — they save as a numbered set."
              />
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
                <Slider
                  label="Quality"
                  value={opts.image!.quality!}
                  options={[
                    ["high", "High"],
                    ["med", "Medium"],
                    ["low", "Low"],
                  ]}
                  onChange={(v) => patchOpt("image", "quality", v)}
                />
              )}
              {opts.image!.op === "resize" && (
                <Slider
                  label="Max width"
                  value={opts.image!.maxW ?? "orig"}
                  options={[
                    ["orig", "Original"],
                    ["1920", "1920"],
                    ["1280", "1280"],
                    ["800", "800"],
                  ]}
                  onChange={(v) => patchOpt("image", "maxW", v)}
                  hint="Scales down only, so a small photo stays its own size."
                />
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
          <section className="rounded-xl border border-[#f0d3d4] bg-[#fdebec] p-5">
            <p className="text-[15px] font-semibold tracking-[-0.01em] text-[#9f2f2d]">
              {failure.title}
            </p>
            {failure.hint && (
              <p className="mt-1 text-[14px] leading-snug text-[#9f2f2d]/85">{failure.hint}</p>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] font-medium text-[#9f2f2d]">
                Technical details
              </summary>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[#f0d3d4] bg-white/70 p-2 font-mono text-[12px] text-[#9f2f2d]">
                {failure.detail}
              </pre>
            </details>
          </section>
        )}

        {resultUrl && resultFile && (
          <section ref={resultWrapRef} className="panel scroll-mt-24 p-6">
            <div className="flex items-center justify-between gap-3">
              <span className="tag tag-green">Saved</span>
              <p className="truncate font-mono text-[12px] tabular-nums text-[#a3a099]">{resultMeta}</p>
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
                  className="mt-4 max-h-80 w-full rounded-lg border border-[#eaeaea] bg-black"
                />
              )
            )}
            {resultKind === "audio" && <audio src={resultUrl} controls className="mt-3 w-full" />}
            {resultKind === "image" && !compressCompare && (
              <img
                src={resultUrl}
                alt="Converted image preview"
                className="mt-4 max-h-80 w-full rounded-lg border border-[#eaeaea] bg-black object-contain"
              />
            )}
            {frameFiles.length > 0 && (
              <div className="mt-3">
                <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-[#a3a099]">
                  Extracted frames — click one to download it.
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
                        className="h-16 w-auto rounded-[8px] border border-[#e5e4e0] bg-black"
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
                className="mt-4 max-h-80 w-full rounded-lg border border-[#eaeaea] bg-black object-contain"
              />
            )}
            {picked && (
              <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-[#eaeaea] bg-[#fafaf8] p-3">
                <div>
                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#a3a099]">
                    In
                  </dt>
                  <dd className="mt-0.5 text-[14px] font-semibold tabular-nums text-[#111]">
                    {formatBytes(picked.size)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#a3a099]">
                    Out
                  </dt>
                  <dd className="mt-0.5 text-[14px] font-semibold tabular-nums text-[#111]">
                    {formatBytes(resultFile.size)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#a3a099]">
                    Change
                  </dt>
                  <dd
                    className={
                      "text-[14px] font-semibold tabular-nums " +
                      (change.startsWith("−") ? "text-[#346538]" : "text-[#111]")
                    }
                  >
                    {change}
                  </dd>
                </div>
              </dl>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleRunClick()}
                className="btn-secondary min-h-11 text-[14px] font-semibold"
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
                className="btn-secondary min-h-11 text-[14px] font-semibold"
              >
                Another file
              </button>
            </div>
          </section>
        )}

        <LimitsNote />
        </div>
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-20">
          <section className="panel p-6" aria-label="Run">
            <div className="flex items-baseline justify-between gap-3">
              <p className="section-label">Run</p>
              {picked && (
                <p className="truncate font-mono text-[12px] tabular-nums text-[#a3a099]">
                  {formatBytes(picked.size)}
                </p>
              )}
            </div>
            {running ? (
              <div className="mt-3" role="status" aria-live="polite">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-[14px] font-semibold text-[#111]">
                    {runningLabel}
                  </p>
                  <p className="shrink-0 font-mono text-[13px] tabular-nums text-[#787774]">
                    {Math.round(progress * 100)}%
                  </p>
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#ecebe8]">
                  <div
                    className="h-full rounded-full bg-[#111] transition-[width] duration-200"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="btn-secondary mt-3 min-h-11 w-full text-[14px] font-semibold"
                >
                  Cancel
                </button>
              </div>
            ) : resultUrl && resultFile ? (
              <div className="mt-3 flex flex-col gap-2">
                <a
                  id="downloadBtn"
                  href={resultUrl}
                  download={resultFile.name}
                  className="btn-primary flex min-h-12 items-center justify-center px-4 text-center text-[15px] no-underline"
                >
                  Download · {formatBytes(resultFile.size)}
                </a>
                {shareSupported && (
                  <button
                    type="button"
                    onClick={() => void handleShare()}
                    className="btn-secondary min-h-11 text-[14px] font-semibold"
                  >
                    {shareLabel}
                  </button>
                )}
                <p className="font-mono text-[12px] leading-relaxed text-[#a3a099]">
                  Saved to this device only — nothing was uploaded.
                </p>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {picked && validationError ? (
                  <p role="status" className="text-[13px] font-medium leading-snug text-[#9f2f2d]">
                    {validationError}
                  </p>
                ) : !picked && !engineReady ? (
                  <p className="text-[13px] leading-snug text-[#a3a099]">
                    First run downloads a ~30 MB engine, then it&apos;s cached.
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={runDisabled}
                  onClick={() => void handleRunClick()}
                  className="btn-primary min-h-12 text-[15px]"
                >
                  {picked ? runLabel : "Pick a file to start"}
                </button>
              </div>
            )}
          </section>
          <RecentJobs jobs={jobHistory} onReuse={rerunFromHistory} onClear={clearHistory} />
        </aside>
      </main>
        </>
      )}

      <footer className="mt-10 border-t border-[#eaeaea] py-6">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-[#a3a099]">
            Files never leave this device
          </p>
          <a
            href="https://x.com/tanavtwt"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[13px] font-medium text-[#787774] transition-colors hover:text-[#111]"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>@tanavtwt</span>
          </a>
        </div>
      </footer>

      {dragActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-[#f7f6f3]/85 backdrop-blur-sm"
        >
          <p className="rounded-xl border-2 border-dashed border-[#111] bg-white px-10 py-12 text-center font-serif text-[20px] text-[#111]">
            Drop it anywhere to load
          </p>
        </div>
      )}

      <PwaStatus />
    </div>
  );
}
