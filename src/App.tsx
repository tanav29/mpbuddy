import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CROP_RATIOS, IN, OUT, TOOLS, cropWH, toolById, type ToolId } from "./tools";
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
  engineState,
  fileBytes,
  onProgress,
  runFFmpeg,
} from "./ffmpeg";
import { Field, Select, TextInput } from "./components/fields";
import PwaStatus from "./components/PwaStatus";
import TrimEditor, { type PickedKind } from "./components/TrimEditor";

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

const INITIAL_OPTS: Opts = {
  compress: { quality: "med", maxH: "720" },
  trim: { start: "", end: "", exact: "off", snap: "on" },
  mp3: { bitrate: "128k" },
  convert: { format: "mp4", shorts: "off", targetMB: "off", audio: "keep" },
  crop: { ratio: "9:16", customW: "4", customH: "5", focalX: "50", focalY: "50" },
  thumbnail: { frameAt: "0:01" },
};

const QUICK_PRESETS: Array<{ id: string; label: string; apply: (patch: (id: ToolId, key: string, value: string) => void, setTool: (t: ToolId) => void) => void }> = [
  {
    id: "reel",
    label: "Reel",
    apply: (patch, setTool) => {
      setTool("convert");
      patch("convert", "format", "mp4");
      patch("convert", "shorts", "crop");
      patch("convert", "targetMB", "25");
    },
  },
  {
    id: "story",
    label: "Story",
    apply: (patch, setTool) => {
      setTool("crop");
      patch("crop", "ratio", "9:16");
      patch("crop", "focalX", "50");
      patch("crop", "focalY", "40");
    },
  },
  {
    id: "youtube",
    label: "YouTube",
    apply: (patch, setTool) => {
      setTool("compress");
      patch("compress", "quality", "high");
      patch("compress", "maxH", "1080");
    },
  },
  {
    id: "podcast",
    label: "Podcast",
    apply: (patch, setTool) => {
      setTool("mp3");
      patch("mp3", "bitrate", "192k");
    },
  },
];

const MEDIA_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "3gp", "avi", "mpg", "mpeg",
  "mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac",
]);

function isMediaFile(f: File): boolean {
  if (f.type.startsWith("video/") || f.type.startsWith("audio/")) return true;
  if (!f.type) return MEDIA_EXTS.has(extOf(f.name));
  return MEDIA_EXTS.has(extOf(f.name));
}

function pickedKindOf(f: File | null): PickedKind {
  if (!f) return null;
  if (f.type.startsWith("video/")) return "video";
  if (f.type.startsWith("audio/")) return "audio";
  const ext = extOf(f.name);
  if (["mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac"].includes(ext)) return "audio";
  return "video";
}

function badgeText(): string {
  const { state, variant } = engineState();
  return `engine: ${state === "ready" ? (variant === "mt" ? "mt · fast" : "st · slow") : state}`;
}

export default function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("compress");
  const [opts, setOpts] = useState<Opts>(() => {
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
      };
    } catch {
      return INITIAL_OPTS;
    }
  });
  const [picked, setPicked] = useState<File | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);
  const [pickedDuration, setPickedDuration] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [showProgressUI, setShowProgressUI] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState("waiting…");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultFile, setResultFile] = useState<File | null>(null);
  const [resultMeta, setResultMeta] = useState("");
  const [resultKind, setResultKind] = useState<"video" | "audio" | "gif" | null>(null);
  const [badge, setBadge] = useState("engine: idle");
  const [fileMeta, setFileMeta] = useState("");
  const [sizeWarn, setSizeWarn] = useState<string | null>(null);
  const [dropLabel, setDropLabel] = useState("Tap to pick video / audio");
  const [shareLabel, setShareLabel] = useState("Share");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("mpb-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return localStorage.getItem("mpb-onboarding-dismissed") !== "1";
    } catch {
      return true;
    }
  });
  const [batchQueue, setBatchQueue] = useState<File[]>([]);
  const [jobHistory, setJobHistory] = useState<JobHistory[]>(() => {
    try {
      return (JSON.parse(localStorage.getItem("mpb-history") ?? "[]") as JobHistory[]).slice(0, 10);
    } catch {
      return [];
    }
  });
  const [retryHint, setRetryHint] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickedRef = useRef<File | null>(null);
  const runningRef = useRef(false);
  const resultWrapRef = useRef<HTMLElement>(null);
  runningRef.current = running;
  pickedRef.current = picked;

  const shareSupported = useMemo(() => canAttemptShare(), []);
  const tool = toolById(activeTool);
  const pickedKind = pickedKindOf(picked);
  const validationError = tool.validate?.(opts[activeTool]!) ?? null;

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
  }, []);

  const handleSelectTool = useCallback(
    (id: ToolId) => {
      setActiveTool(id);
      clearResult();
    },
    [clearResult],
  );

  const handleFile = useCallback(async (f: File) => {
    setRetryHint(null);
    if (!isMediaFile(f)) {
      setPickedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setPicked(null);
      setPickedDuration(null);
      clearResult();
      setDropLabel("Tap to pick video / audio");
      setFileMeta(f.name);
      setSizeWarn("That file type isn't supported — pick an audio or video file.");
      return;
    }
    setPickedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
    setPicked(f);
    setPickedDuration(null);
    clearResult();
    setDropLabel(f.name);
    setFileMeta(`${formatBytes(f.size)} · reading…`);
    setSizeWarn(sizeWarning(f.size));

    const dur = await probeDuration(f);
    // Drop stale probes if the user picked another file meanwhile.
    if (pickedRef.current && pickedRef.current.name === f.name) {
      setPickedDuration(dur);
      setFileMeta(`${formatBytes(f.size)}` + (dur != null ? ` · ${fmtTime(dur)}` : ""));
      if (dur != null) {
        setOpts((prev) => {
          if (prev.trim!.end) return prev;
          return { ...prev, trim: { ...prev.trim, end: fmtTrim(dur) } };
        });
      }
    }
  }, [clearResult]);

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

  const processOne = useCallback(async (file: File, id: ToolId, inputOpts: Record<string, string>) => {
    const t = toolById(id);
    const resolvedOpts = { ...inputOpts, durationSec: String(pickedDuration ?? "") };
    const ext = extOf(file.name) || "mp4";
    const inName = `${IN}.${ext}`;
    const wantExt = extOf(t.outName(file.name, resolvedOpts)) || "mp4";
    const outName = `${OUT}.${wantExt}`;
    const data = await runFFmpeg(t.buildArgs(inName, outName, resolvedOpts), [
      { name: inName, data: await fileBytes(file) },
    ]);
    const mime = t.outMime(resolvedOpts);
    const outFileName = t.outName(file.name, resolvedOpts);
    const outFile = new File([data.slice() as unknown as BlobPart], outFileName, { type: mime });
    return { data, mime, outFile, resolvedOpts };
  }, [pickedDuration]);

  const handleRunClick = async (): Promise<void> => {
    if (!picked || running) return;
    const t = toolById(activeTool);
    const o = opts[activeTool]!;
    const err = t.validate?.(o) ?? null;
    if (err) return;

    setRunning(true);
    setShowProgressUI(true);
    setProgress(0);
    setBadge(badgeText());
    setRetryHint(null);

    try {
      setStatusLine("Loading engine (once, ~30 MB)…");
      setBadge("engine: loading");
      const v = await ensureEngine();
      setBadge(badgeText());
      onProgress((p) => {
        setProgress(p);
        setStatusLine(`Working… ${Math.round(p * 100)}% (${v === "mt" ? "fast" : "slow"} engine)`);
      });

      const runList = [picked, ...batchQueue];
      let finalOut: File | null = null;
      for (let i = 0; i < runList.length; i++) {
        const file = runList[i]!;
        setStatusLine(runList.length > 1 ? `Processing ${i + 1}/${runList.length}: ${file.name}` : "Processing…");
        const { data, mime, outFile, resolvedOpts } = await processOne(file, activeTool, o);
        setJobHistory((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            fileName: file.name,
            tool: activeTool,
            opts: resolvedOpts,
            inputBytes: file.size,
            outputBytes: data.byteLength,
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
        const kind = mime.startsWith("audio/") ? "audio" : mime === "image/gif" ? "gif" : "video";
        setResultKind(kind);
        setResultMeta(`· ${formatBytes(file.size)} → ${formatBytes(data.byteLength)}`);
      }
      if (finalOut) {
        setShareLabel("Share");
        setStatusLine(batchQueue.length ? `Done. Processed ${batchQueue.length + 1} files.` : "Done.");
        setProgress(1);
        setBatchQueue([]);
        requestAnimationFrame(() => {
          resultWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      setStatusLine(`Failed: ${msg}`);
      if (/memory|oom|alloc/i.test(msg)) {
        setRetryHint("Try trimming first, switch to lower quality/480p, or process one file at a time.");
      }
    } finally {
      setRunning(false);
      setBadge(badgeText());
    }
  };

  // Keep the simpler stable handler name for JSX.

  const handleCancel = (): void => {
    void cancelEngine().then(() => {
      setRunning(false);
      setShowProgressUI(false);
      setBadge(badgeText());
      setStatusLine("Cancelled.");
      setShowProgressUI(true);
    });
  };

  const handleReset = (): void => {
    setPickedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPicked(null);
    setPickedDuration(null);
    setDropLabel("Tap to pick video / audio");
    setFileMeta("");
    setSizeWarn(null);
    clearResult();
    setShowProgressUI(false);
  };

  const handleShare = async (): Promise<void> => {
    if (!resultFile) return;
    try {
      const r = await shareFile(resultFile);
      if (r === "shared") {
        setShareLabel("Shared ✓");
        setTimeout(() => setShareLabel("Share"), 2000);
      } else if (r === "dismissed") {
        setShareLabel("Share");
      } else {
        setShareLabel("Share");
        document.getElementById("downloadBtn")?.click();
      }
    } finally {
      /* noop */
    }
  };

  const rerunFromHistory = (job: JobHistory): void => {
    setActiveTool(job.tool);
    setOpts((prev) => ({ ...prev, [job.tool]: { ...prev[job.tool], ...job.opts } }));
  };

  useEffect(() => {
    setBadge(badgeText());
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mpb-theme", theme);
    } catch {
      /* noop */
    }
  }, [theme]);

  // Revoke result URL on unmount.
  useEffect(() => {
    return () => {
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  const runDisabled = running || !picked || validationError != null;
  const runLabel = running
    ? "Working…"
    : !picked
      ? "Pick a file first"
      : (validationError ?? `${batchQueue.length ? `Run ${batchQueue.length + 1} files` : `Run ${tool.label}`}`);

  const cropOpts = opts.crop!;
  const cropPreview = (() => {
    const wh = cropWH(cropOpts);
    if (!wh) return null;
    return wh;
  })();
  const compressEstimate = (() => {
    if (!picked) return null;
    const q = opts.compress!.quality ?? "med";
    const maxH = opts.compress!.maxH ?? "720";
    const qualityFactor = q === "high" ? 0.68 : q === "med" ? 0.46 : 0.32;
    const scaleFactor = maxH === "1080" ? 0.9 : maxH === "720" ? 0.62 : maxH === "480" ? 0.4 : 1;
    const est = Math.max(1, Math.round(picked.size * qualityFactor * scaleFactor));
    return formatBytes(est);
  })();
  const reductionPct =
    picked && resultFile && picked.size > 0
      ? Math.max(0, Math.round((1 - resultFile.size / picked.size) * 100))
      : null;

  return (
    <div className={`mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-8 pt-4 sm:max-w-lg ${theme === "dark" ? "text-neutral-100" : ""}`}>
      <header className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-[9px] bg-neutral-900 text-[13px] font-bold text-white">
            M
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-neutral-900">
            MpBuddy
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="btn-apple-secondary rounded-full px-3 py-1 text-[11px] font-semibold text-neutral-700"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <div className="flex items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-neutral-500">
            {badge}
          </div>
        </div>
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
                  ? "rounded-[15px] bg-white px-1 py-2 text-center text-neutral-900 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
                  : "rounded-[15px] px-1 py-2 text-center text-neutral-500 transition-colors hover:text-neutral-800") +
                " flex min-h-[60px] flex-col items-center justify-center gap-1"
              }
              aria-pressed={active}
              onClick={() => handleSelectTool(t.id)}
            >
              <span
                className={
                  "grid place-items-center " + (active ? "text-neutral-900" : "text-neutral-500")
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
                  className="size-5"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: t.icon }}
                />
              </span>
              <span className="text-[11px] font-medium tracking-tight">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <section className="mt-3 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Quick presets">
        {QUICK_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => p.apply(patchOpt, setActiveTool)}
            className="btn-apple-secondary shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold text-neutral-700"
          >
            {p.label}
          </button>
        ))}
      </section>

      {showOnboarding && (
        <section className="card-apple mt-2 rounded-[16px] border border-[#0071e3]/20 bg-[#0071e3]/[0.07] px-3 py-2.5 text-[12px] text-neutral-700">
          <div className="flex items-start justify-between gap-3">
            <p>
              <strong>First run:</strong> Pick file → choose preset/tool → run.
            </p>
            <button
              type="button"
              onClick={() => {
                setShowOnboarding(false);
                try {
                  localStorage.setItem("mpb-onboarding-dismissed", "1");
                } catch {
                  /* noop */
                }
              }}
              className="text-[11px] font-semibold text-[#0071e3]"
            >
              Got it
            </button>
          </div>
        </section>
      )}

      <div className="mt-5 px-1">
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{tool.label}</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-neutral-500">{tool.hint}</p>
      </div>

      <main className="mt-4 flex flex-col gap-3">
        {picked ? (
          <div
            className="card-apple flex items-center gap-3 rounded-[22px] p-3 pl-4"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer?.files ?? null);
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block max-w-full truncate text-[14px] font-medium text-neutral-900">
                {dropLabel}
              </span>
              <span className="mt-0.5 block text-xs text-neutral-500">{fileMeta}</span>
              {sizeWarn && (
                <span className="mt-0.5 block max-w-full text-xs font-medium text-amber-600">
                  {sizeWarn}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-apple-secondary shrink-0 rounded-full px-4 py-2 text-[13px] font-medium text-neutral-700"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={handleReset}
              aria-label="Remove current file"
              className="shrink-0 rounded-full border border-red-200 bg-amber-50 px-4 py-2 text-[13px] font-semibold text-red-600 transition-colors hover:bg-red-50 active:bg-red-100"
            >
              ✕ Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="card-apple flex min-h-44 flex-col items-center justify-center gap-1.5 rounded-[22px] border-dashed px-6 py-8 text-center transition-colors"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer?.files ?? null);
            }}
          >
            <span className="grid size-11 place-items-center rounded-full bg-[#0071e3]/10 text-[#0071e3]">
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
              >
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
                <path d="M7 9l5 -5l5 5" />
                <path d="M12 4l0 12" />
              </svg>
            </span>
            <span className="mt-1 max-w-full truncate text-[15px] font-medium text-neutral-900">
              {dropLabel}
            </span>
            <span className="text-xs text-neutral-500">{fileMeta}</span>
            {sizeWarn && (
              <span className="max-w-full text-xs font-medium text-amber-600">{sizeWarn}</span>
            )}
            <span className="mt-1 text-[11px] text-neutral-400">MP4 · WebM · MP3 · ≤200 MB</span>
          </button>
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
          <div className="rounded-xl border border-[#0071e3]/25 bg-[#0071e3]/[0.06] px-3 py-2 text-[12px] text-neutral-700">
            Batch queue ready: {batchQueue.length + 1} files will run sequentially.
          </div>
        )}

        <section className="card-apple rounded-[22px] p-4">
          {activeTool === "compress" && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quality">
                  <Select
                    value={opts.compress!.quality!}
                    options={[
                      ["high", "High"],
                      ["med", "Medium"],
                      ["low", "Low"],
                    ]}
                    onChange={(v) => patchOpt("compress", "quality", v)}
                  />
                </Field>
                <Field label="Max height">
                  <Select
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
              </div>
              {compressEstimate && (
                <p className="text-[12px] text-neutral-500">
                  Estimated output: <span className="font-semibold text-neutral-700">{compressEstimate}</span>
                </p>
              )}
            </div>
          )}

          {activeTool === "trim" && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cut mode">
                  <Select
                    value={opts.trim!.exact ?? "off"}
                    options={[
                      ["off", "Fast (copy)"],
                      ["on", "Exact (re-encode)"],
                    ]}
                    onChange={(v) => patchOpt("trim", "exact", v)}
                  />
                </Field>
                <Field label="Snap keyframes">
                  <Select
                    value={opts.trim!.snap ?? "on"}
                    options={[
                      ["on", "On"],
                      ["off", "Off"],
                    ]}
                    onChange={(v) => patchOpt("trim", "snap", v)}
                  />
                </Field>
              </div>
              <TrimEditor
                start={opts.trim!.start ?? ""}
                end={opts.trim!.end ?? ""}
                onStart={(v) => patchOpt("trim", "start", v)}
                onEnd={(v) => patchOpt("trim", "end", v)}
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
            <div className="grid grid-cols-1 gap-3">
              <Field label="Bitrate">
                <Select
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
            <div className="grid grid-cols-2 gap-3">
              <Field label="Output">
                <Select
                  value={opts.convert!.format!}
                  options={[
                    ["mp4", "MP4"],
                    ["webm", "WebM"],
                    ["mp3", "MP3"],
                    ["gif", "GIF (≤10s)"],
                  ]}
                  onChange={(v) => patchOpt("convert", "format", v)}
                />
              </Field>
              <Field label="Vertical">
                <Select
                  value={opts.convert!.shorts!}
                  options={[
                    ["off", "Off"],
                    ["pad", "9:16 pad"],
                    ["crop", "9:16 crop"],
                  ]}
                  onChange={(v) => patchOpt("convert", "shorts", v)}
                />
              </Field>
              <Field label="Target size">
                <Select
                  value={opts.convert!.targetMB!}
                  options={[
                    ["off", "Off"],
                    ["10", "Under 10MB"],
                    ["25", "Under 25MB"],
                    ["50", "Under 50MB"],
                  ]}
                  onChange={(v) => patchOpt("convert", "targetMB", v)}
                />
              </Field>
              <Field label="Audio">
                <Select
                  value={opts.convert!.audio!}
                  options={[
                    ["keep", "Keep audio"],
                    ["mute", "Remove audio"],
                  ]}
                  onChange={(v) => patchOpt("convert", "audio", v)}
                />
              </Field>
            </div>
          )}

          {activeTool === "crop" && (
            <div className="grid grid-cols-1 gap-3">
              <Field label="Ratio">
                <Select
                  value={opts.crop!.ratio!}
                  options={CROP_RATIOS}
                  onChange={(v) => patchOpt("crop", "ratio", v)}
                />
              </Field>
              {opts.crop!.ratio === "custom" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="W">
                    <TextInput
                      value={opts.crop!.customW ?? ""}
                      placeholder="4"
                      inputMode="decimal"
                      ariaLabel="Custom ratio width"
                      onChange={(v) => patchOpt("crop", "customW", v)}
                    />
                  </Field>
                  <Field label="H">
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
              <div className="grid grid-cols-2 gap-3">
                <Field label="Focal X">
                  <TextInput
                    value={opts.crop!.focalX ?? "50"}
                    placeholder="50"
                    inputMode="numeric"
                    ariaLabel="Crop focal X"
                    onChange={(v) => patchOpt("crop", "focalX", v)}
                  />
                </Field>
                <Field label="Focal Y">
                  <TextInput
                    value={opts.crop!.focalY ?? "50"}
                    placeholder="50"
                    inputMode="numeric"
                    ariaLabel="Crop focal Y"
                    onChange={(v) => patchOpt("crop", "focalY", v)}
                  />
                </Field>
              </div>
              <div
                className="relative h-24 rounded-xl border border-black/10 bg-gradient-to-br from-neutral-100 to-neutral-200"
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  const r = el.getBoundingClientRect();
                  const setFrom = (clientX: number, clientY: number) => {
                    const x = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
                    const y = Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100));
                    patchOpt("crop", "focalX", String(Math.round(x)));
                    patchOpt("crop", "focalY", String(Math.round(y)));
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
                  className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0071e3] bg-white shadow"
                  style={{
                    left: `${Math.max(0, Math.min(100, Number(opts.crop!.focalX ?? "50") || 50))}%`,
                    top: `${Math.max(0, Math.min(100, Number(opts.crop!.focalY ?? "50") || 50))}%`,
                  }}
                />
              </div>
              <div className="flex items-center gap-3 rounded-xl bg-black/[0.04] px-3 py-2.5">
                <div className="grid h-16 w-16 shrink-0 place-items-center">
                  {cropPreview ? (
                    <div
                      className="max-h-full max-w-full rounded-[4px] border-2 border-[#0071e3] bg-[#0071e3]/15"
                      style={{
                        aspectRatio: `${cropPreview.W} / ${cropPreview.H}`,
                        ...(cropPreview.W / cropPreview.H >= 1
                          ? { width: "100%", height: "auto" }
                          : { width: "auto", height: "100%" }),
                      }}
                    />
                  ) : (
                    <div
                      className="rounded-[4px] border-2 border-[#0071e3] bg-[#0071e3]/15"
                      style={{ width: "2.5rem", height: "2.5rem" }}
                    />
                  )}
                </div>
                <div className="text-xs leading-snug text-neutral-500">
                  {!cropPreview
                    ? "Enter W and H above, e.g. 4 and 5 for 4:5."
                    : (() => {
                        const o = opts.crop!;
                        const label =
                          o.ratio === "custom"
                            ? `Custom ${cropPreview.W}:${cropPreview.H}`
                            : (CROP_RATIOS.find(([v]) => v === o.ratio)?.[1] ??
                              `${cropPreview.W}:${cropPreview.H}`);
                        return `${label} — output keeps full resolution, cropped.`;
                      })()}
                </div>
              </div>
              <p className="text-[11px] leading-snug text-neutral-400">
                Center crop — keeps the middle, cuts the rest. No black bars, no stretch.
              </p>
            </div>
          )}

          {activeTool === "thumbnail" && (
            <div className="grid grid-cols-1 gap-3">
              <Field label="Frame at">
                <TextInput
                  value={opts.thumbnail!.frameAt ?? "0:01"}
                  placeholder="0:01"
                  ariaLabel="Frame time"
                  onChange={(v) => patchOpt("thumbnail", "frameAt", v)}
                />
              </Field>
              <p className="text-[11px] leading-snug text-neutral-400">
                Enter a timestamp like 0:01 or 1:23.5 and export a high-quality JPG frame.
              </p>
            </div>
          )}
        </section>

        <button
          type="button"
          disabled={runDisabled}
          onClick={handleRunClick}
          className="btn-apple-primary min-h-[52px] rounded-[16px] text-[16px] font-semibold"
        >
          {runLabel}
        </button>

        {showProgressUI && (
          <section className="card-apple rounded-[22px] border border-[#0071e3]/20 p-4">
            <div className="flex items-center justify-between text-[13px] text-neutral-500">
              <span>{statusLine}</span>
              <button
                type="button"
                onClick={handleCancel}
                className="btn-apple-secondary rounded-full px-4 py-1.5 text-[13px] font-medium text-neutral-700"
              >
                Cancel
              </button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.08]">
              <div
                className="h-full rounded-full bg-[#0071e3] transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            {retryHint && (
              <p className="mt-2 rounded-lg bg-amber-100 px-2.5 py-1.5 text-[12px] text-amber-700">
                {retryHint}
              </p>
            )}
            {resultKind === "gif" && resultUrl && (
              <img
                src={resultUrl}
                alt="Converted GIF preview"
                className="mt-3 max-h-64 w-full rounded-2xl bg-black object-contain"
              />
            )}
          </section>
        )}

        {resultUrl && (
          <section ref={resultWrapRef} className="card-apple rounded-[22px] border border-emerald-400/25 p-4">
            <p className="text-[13px] text-neutral-500">
              Done <span className="text-neutral-400">{resultMeta}</span>
            </p>
            {picked && resultFile && (
              <div className="mt-2 grid grid-cols-3 gap-2 rounded-xl bg-emerald-50 p-2 text-[11px] text-emerald-800">
                <span>In: {formatBytes(picked.size)}</span>
                <span>Out: {formatBytes(resultFile.size)}</span>
                <span>Saved: {reductionPct != null ? `${reductionPct}%` : "—"}</span>
              </div>
            )}
            {resultKind === "video" && (
              <video
                src={resultUrl}
                controls
                playsInline
                className="mt-3 max-h-64 w-full rounded-2xl bg-black"
              />
            )}
            {resultKind === "audio" && <audio src={resultUrl} controls className="mt-3 w-full" />}
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <a
                id="downloadBtn"
                href={resultUrl}
                download={resultFile?.name ?? "output"}
                className={`btn-apple-primary grid min-h-12 place-items-center rounded-[14px] text-[15px] font-semibold no-underline ${shareSupported ? "" : "col-span-2"}`}
              >
                Download
              </a>
              {shareSupported && (
                <button
                  type="button"
                  onClick={handleShare}
                  className="btn-apple-secondary min-h-12 rounded-[14px] text-[15px] font-semibold text-neutral-800"
                >
                  {shareLabel}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={handleReset}
              className="mt-1 w-full py-2 text-[13px] font-medium text-[#0071e3]"
            >
              Process another file
            </button>
          </section>
        )}

        <details className="card-apple rounded-[22px] p-4 text-[13px] leading-relaxed text-neutral-500">
          <summary className="cursor-pointer font-medium text-neutral-700">
            Limits & privacy
          </summary>
          <ul className="mt-2.5 list-disc space-y-1.5 pl-4">
            <li>
              Everything runs locally via ffmpeg.wasm. No uploads, works offline after first
              load.
            </li>
            <li>
              Best for clips &lt; 2 min, ≤1080p, &lt;200 MB desktop / &lt;50 MB mobile. Bigger
              files can crash mobile tabs.
            </li>
            <li>First run downloads a ~30 MB engine once, then it&apos;s cached.</li>
          </ul>
        </details>

        {jobHistory.length > 0 && (
          <section className="card-apple rounded-[22px] p-4">
            <p className="text-[13px] font-semibold text-neutral-800">Recent jobs (local)</p>
            <ul className="mt-2 space-y-2">
              {jobHistory.slice(0, 5).map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/[0.04] px-2.5 py-2">
                  <div className="min-w-0 text-[12px] text-neutral-600">
                    <p className="truncate font-medium text-neutral-800">{j.fileName}</p>
                    <p>{j.tool} · {formatBytes(j.inputBytes)} → {formatBytes(j.outputBytes)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => rerunFromHistory(j)}
                    className="btn-apple-secondary rounded-full px-3 py-1 text-[11px] font-semibold text-neutral-700"
                  >
                    Reuse
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="mt-8 flex flex-col items-center gap-2 border-t border-black/[0.06] pt-5 text-center">
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
        <p className="text-[11px] text-neutral-400">
          Files never leave this device · Built in the open
        </p>
      </footer>
      <PwaStatus />
    </div>
  );
}
