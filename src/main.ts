import "./style.css";
import { IN, OUT, TOOLS, toolById, type ToolId } from "./tools";
import {
  baseName,
  downloadUrl,
  extOf,
  fmtTime,
  formatBytes,
  probeDuration,
  shareFile,
  sizeWarning,
} from "./files";
import { cancelEngine, ensureEngine, engineState, fileBytes, onProgress, runFFmpeg } from "./ffmpeg";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

type Opts = Record<ToolId, Record<string, string>>;

const opts: Opts = {
  compress: { quality: "med", maxH: "720" },
  trim: { start: "", end: "" },
  mp3: { bitrate: "128k" },
  convert: { format: "mp4", shorts: "off" },
};

let activeTool: ToolId = "compress";
let picked: File | null = null;
let pickedDuration: number | null = null;
let running = false;
let resultUrl: string | null = null;

const tabsEl = $("toolTabs");
const optionsEl = $("options");
const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("fileInput");
const dropLabel = $("dropLabel");
const fileMeta = $("fileMeta");
const sizeWarn = $("sizeWarn");
const runBtn = $<HTMLButtonElement>("runBtn");
const progressWrap = $("progressWrap");
const statusLine = $("statusLine");
const progressBar = $("progressBar");
const cancelBtn = $("cancelBtn");
const resultWrap = $("resultWrap");
const resultMeta = $("resultMeta");
const previewVideo = $<HTMLVideoElement>("previewVideo");
const previewAudio = $<HTMLAudioElement>("previewAudio");
const previewImg = $<HTMLImageElement>("previewImg");
const downloadBtn = $<HTMLAnchorElement>("downloadBtn");
const shareBtn = $<HTMLButtonElement>("shareBtn");
const resetBtn = $("resetBtn");
const badge = $("engineBadge");
const modeTitle = $("modeTitle");
const modeDesc = $("modeDesc");

function setBadge(text: string): void {
  badge.textContent = `engine: ${text}`;
}

function syncBadge(): void {
  const { state, variant } = engineState();
  setBadge(state === "ready" ? (variant === "mt" ? "mt · fast" : "st · slow") : state);
}

function syncAccept(): void {
  fileInput.accept = toolById(activeTool).accept;
}

const MEDIA_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "3gp", "avi", "mpg", "mpeg",
  "mp3", "m4a", "wav", "ogg", "oga", "opus", "aac", "flac",
]);

function isMediaFile(f: File): boolean {
  if (f.type.startsWith("video/") || f.type.startsWith("audio/")) return true;
  // Some browsers leave type empty (e.g. .mkv) — fall back to extension.
  if (!f.type) return MEDIA_EXTS.has(extOf(f.name));
  return MEDIA_EXTS.has(extOf(f.name));
}
function selectCls(on: boolean): string {
  return on
    ? "rounded-[15px] bg-white px-1 py-2 text-center text-neutral-900 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
    : "rounded-[15px] px-1 py-2 text-center text-neutral-500 transition-colors hover:text-neutral-800";
}

function tablerIcon(paths: string, cls = "size-5"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${paths}</svg>`;
}

function renderModeHeader(): void {
  const tool = toolById(activeTool);
  modeTitle.textContent = tool.label;
  modeDesc.textContent = tool.hint;
}

function renderTabs(): void {
  tabsEl.innerHTML = "";
  for (const t of TOOLS) {
    const b = document.createElement("button");
    const active = t.id === activeTool;
    b.className = selectCls(active) + " flex min-h-[60px] flex-col items-center justify-center gap-1";
    b.setAttribute("aria-pressed", String(active));
    const ic = document.createElement("span");
    ic.className = "grid place-items-center " + (active ? "text-neutral-900" : "text-neutral-500");
    ic.innerHTML = tablerIcon(t.icon);
    const lb = document.createElement("span");
    lb.className = "text-[11px] font-medium tracking-tight";
    lb.textContent = t.label;
    b.append(ic, lb);
    b.addEventListener("click", () => {
      activeTool = t.id;
      hideResult();
      renderTabs();
      renderModeHeader();
      renderOptions();
      syncAccept();
      syncRun();
    });
    tabsEl.appendChild(b);
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "flex flex-col gap-1.5";
  const s = document.createElement("span");
  s.className = "text-[11px] font-semibold uppercase tracking-wider text-neutral-400";
  s.textContent = label;
  wrap.append(s, control);
  return wrap;
}

function makeSelect(value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "min-h-12 w-full appearance-none rounded-xl border border-black/10 bg-[#f5f5f7] px-3 text-[15px] text-neutral-900 outline-none transition-colors focus:border-[#0071e3]";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function makeInput(value: string, placeholder: string, onChange: (v: string) => void, inputMode = "text"): HTMLInputElement {
  const inp = document.createElement("input");
  inp.className = "min-h-12 w-full rounded-xl border border-black/10 bg-[#f5f5f7] px-3.5 text-[15px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0071e3]";
  inp.value = value;
  inp.placeholder = placeholder;
  inp.inputMode = inputMode as HTMLInputElement["inputMode"];
  inp.addEventListener("input", () => onChange(inp.value));
  return inp;
}

function renderOptions(): void {
  optionsEl.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-2 gap-3";

  if (activeTool === "compress") {
    const o = opts.compress!;
    grid.append(
      field("Quality", makeSelect(o.quality!, [["high", "High"], ["med", "Medium"], ["low", "Low"]], (v) => { o.quality = v; })),
      field("Max height", makeSelect(o.maxH!, [["orig", "Original"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]], (v) => { o.maxH = v; })),
    );
  } else if (activeTool === "trim") {
    const o = opts.trim!;
    grid.classList.replace("grid-cols-2", "grid-cols-2");
    grid.append(
      field(`Start (0:00${pickedDuration != null ? ` – ${fmtTime(pickedDuration)}` : ""})`,
        makeInput(o.start!, "0:00", (v) => { o.start = v; syncRun(); })),
      field("End (blank = to end)",
        makeInput(o.end!, pickedDuration != null ? fmtTime(pickedDuration) : "1:30", (v) => { o.end = v; syncRun(); })),
    );
  } else if (activeTool === "mp3") {
    const o = opts.mp3!;
    grid.className = "grid grid-cols-1 gap-3";
    grid.append(
      field("Bitrate", makeSelect(o.bitrate!, [["128k", "128 kbps"], ["192k", "192 kbps"], ["256k", "256 kbps"]], (v) => { o.bitrate = v; })),
    );
  } else {
    const o = opts.convert!;
    grid.append(
      field("Output", makeSelect(o.format!, [["mp4", "MP4"], ["webm", "WebM"], ["mp3", "MP3"], ["gif", "GIF (≤10s)"]], (v) => { o.format = v; renderOptions(); syncRun(); })),
      field("Vertical", makeSelect(o.shorts!, [["off", "Off"], ["pad", "9:16 pad"], ["crop", "9:16 crop"]], (v) => { o.shorts = v; })),
    );
  }
  optionsEl.append(grid);
}

function syncRun(): void {
  if (running) {
    runBtn.disabled = true;
    return;
  }
  if (!picked) {
    runBtn.disabled = true;
    runBtn.textContent = "Pick a file first";
    return;
  }
  const tool = toolById(activeTool);
  const err = tool.validate?.(opts[activeTool]!) ?? null;
  runBtn.disabled = err != null;
  runBtn.textContent = err ?? `Run ${tool.label}`;
}

function hideResult(): void {
  resultWrap.classList.add("hidden");
  previewVideo.classList.add("hidden");
  previewAudio.classList.add("hidden");
  previewImg.classList.add("hidden");
  previewVideo.removeAttribute("src");
  previewAudio.removeAttribute("src");
  previewImg.removeAttribute("src");
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
}

function showProgress(show: boolean): void {
  progressWrap.classList.toggle("hidden", !show);
  if (show) {
    progressBar.style.width = "0%";
    hideResult();
  }
}

async function setFile(f: File): Promise<void> {
  if (!isMediaFile(f)) {
    picked = null;
    pickedDuration = null;
    hideResult();
    dropLabel.textContent = "Tap to pick video / audio";
    fileMeta.textContent = f.name;
    sizeWarn.classList.remove("hidden");
    sizeWarn.textContent = "That file type isn't supported — pick an audio or video file.";
    syncRun();
    return;
  }
  picked = f;
  hideResult();
  dropLabel.textContent = f.name;
  fileMeta.textContent = `${formatBytes(f.size)} · reading…`;
  const warn = sizeWarning(f.size);
  sizeWarn.classList.toggle("hidden", warn == null);
  sizeWarn.textContent = warn ?? "";
  pickedDuration = await probeDuration(f);
  if (picked && picked.name === f.name) {
    fileMeta.textContent =
      `${formatBytes(f.size)}` + (pickedDuration != null ? ` · ${fmtTime(pickedDuration)}` : "");
    if (activeTool === "trim" && pickedDuration != null && !opts.trim!.end) {
      opts.trim!.end = fmtTime(pickedDuration);
      renderOptions();
    }
    if (activeTool === "trim") renderOptions();
  }
  syncRun();
}

async function run(): Promise<void> {
  if (!picked || running) return;
  const tool = toolById(activeTool);
  const o = opts[activeTool]!;
  const err = tool.validate?.(o) ?? null;
  if (err) return;

  running = true;
  syncRun();
  showProgress(true);
  syncBadge();
  runBtn.textContent = "Working…";

  try {
    statusLine.textContent = "Loading engine (once, ~30 MB)…";
    setBadge("loading");
    const v = await ensureEngine();
    syncBadge();
    onProgress((p) => {
      progressBar.style.width = `${Math.round(p * 100)}%`;
      statusLine.textContent = `Working… ${Math.round(p * 100)}% (${v === "mt" ? "fast" : "slow"} engine)`;
    });

    const ext = extOf(picked.name) || "mp4";
    const inName = `${IN}.${ext}`;
    const wantExt = extOf(tool.outName(picked.name, o)) || "mp4";
    const outName = `${OUT}.${wantExt}`;
    statusLine.textContent = "Processing…";
    const data = await runFFmpeg(tool.buildArgs(inName, outName, o), [
      { name: inName, data: await fileBytes(picked) },
    ]);
    const mime = tool.outMime(o);
    resultUrl = downloadUrl(data, mime);
    const outFileName = tool.outName(picked.name, o);

    const kind = mime.startsWith("audio/") ? "audio" : mime === "image/gif" ? "gif" : "video";
    if (kind === "audio") {
      previewAudio.src = resultUrl;
      previewAudio.classList.remove("hidden");
    } else if (kind === "gif") {
      previewImg.src = resultUrl;
      previewImg.classList.remove("hidden");
    } else {
      previewVideo.src = resultUrl;
      previewVideo.classList.remove("hidden");
    }
    downloadBtn.href = resultUrl;
    downloadBtn.download = outFileName;
    resultMeta.textContent = `· ${formatBytes(picked.size)} → ${formatBytes(data.byteLength)}`;
    shareBtn.textContent = "Share";
    resultWrap.classList.remove("hidden");
    statusLine.textContent = "Done.";
    progressBar.style.width = "100%";
    resultWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    statusLine.textContent = e instanceof Error ? `Failed: ${e.message}` : "Failed.";
  } finally {
    running = false;
    syncRun();
    syncBadge();
  }
}

function wire(): void {
  renderTabs();
  renderModeHeader();
  renderOptions();
  syncAccept();
  syncRun();
  syncBadge();

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void setFile(f);
    fileInput.value = "";
  });
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void setFile(f);
  });

  runBtn.addEventListener("click", () => void run());
  cancelBtn.addEventListener("click", () => {
    void cancelEngine().then(() => {
      running = false;
      showProgress(false);
      syncRun();
      syncBadge();
      statusLine.textContent = "Cancelled.";
      showProgress(true);
    });
  });
  shareBtn.addEventListener("click", async () => {
    if (!resultUrl || !picked) return;
    const tool = toolById(activeTool);
    const res = await fetch(resultUrl);
    const buf = new Uint8Array(await res.arrayBuffer());
    const name = tool.outName(picked.name, opts[activeTool]!);
    const f = new File([buf.buffer as ArrayBuffer], baseName(name) ? name : "output", {
      type: tool.outMime(opts[activeTool]!),
    });
    const r = await shareFile(f);
    shareBtn.textContent = r === "shared" ? "Shared" : r === "dismissed" ? "Share" : "Share N/A";
  });
  resetBtn.addEventListener("click", () => {
    picked = null;
    pickedDuration = null;
    dropLabel.textContent = "Tap to pick video / audio";
    fileMeta.textContent = "";
    sizeWarn.classList.add("hidden");
    hideResult();
    showProgress(false);
    syncRun();
  });
}

wire();
