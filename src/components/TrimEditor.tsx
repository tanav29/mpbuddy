import { useEffect, useMemo, useRef, useState } from "react";
import {
  MIN_CUT,
  clamp,
  clampRanges,
  fmtRanges,
  fmtTime,
  fmtTrim,
  mergeRanges,
  parseRanges,
  parseTime,
  peakWaveform,
  type Range,
} from "../files";
import { Field, TextInput } from "./fields";

/** Keep-range handles never cross closer than this. */
const MIN_GAP = 0.2;

/** Timeline values round to tenths, matching fmtTrim's precision. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** True when t falls inside any cut (padded so the exact edge counts as kept). */
function inCuts(t: number, rs: Range[]): boolean {
  return rs.some((r) => t > r.a + 0.02 && t < r.b - 0.02);
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("seek timeout")), 4000);
    const onSeek = (): void => {
      clearTimeout(timer);
      v.removeEventListener("seeked", onSeek);
      resolve();
    };
    v.addEventListener("seeked", onSeek);
    v.currentTime = t;
  });
}

function captureFilmstrip(
  url: string,
  dur: number,
  count: number,
  isCurrent: () => boolean,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    const done = (val: string[] | null): void => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(val);
    };
    const timer = setTimeout(() => done(null), 12000);
    v.onerror = () => done(null);
    v.onloadeddata = () => {
      void (async () => {
        try {
          const thumbs: string[] = [];
          for (let i = 0; i < count; i++) {
            if (!isCurrent()) {
              done(null);
              return;
            }
            const t =
              dur <= 0.2
                ? 0.05
                : clamp((dur * (i + 0.5)) / count, 0.05, Math.max(0.05, dur - 0.05));
            await seekVideo(v, t);
            if (!isCurrent()) {
              done(null);
              return;
            }
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            thumbs.push(canvas.toDataURL("image/jpeg", 0.6));
          }
          done(thumbs);
        } catch {
          done(null);
        }
      })();
    };
    v.src = url;
  });
}

function paintWaveform(canvas: HTMLCanvasElement, peaks: number[]): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const n = peaks.length;
  const gap = w / n;
  const barW = Math.max(1, gap * 0.55);
  ctx.fillStyle = "rgb(0 0 0 / 0.45)";
  for (let i = 0; i < n; i++) {
    const p = clamp(peaks[i] ?? 0, 0.04, 1);
    const bh = Math.max(2, p * h * 0.9);
    const x = i * gap + (gap - barW) / 2;
    const y = (h - bh) / 2;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, barW, bh, barW / 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barW, bh);
    }
  }
}

export type PickedKind = "video" | "audio" | "image" | null;
export type TrimMode = "keep" | "remove";

export default function TrimEditor({
  mode,
  start,
  end,
  cuts,
  onStart,
  onEnd,
  onCuts,
  onCommit,
  picked,
  pickedUrl,
  pickedKind,
  duration,
  running,
}: {
  mode: TrimMode;
  start: string;
  end: string;
  cuts: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onCuts: (v: string) => void;
  onCommit: (s: string, e: string) => void;
  picked: File | null;
  pickedUrl: string | null;
  pickedKind: PickedKind;
  duration: number | null;
  running: boolean;
}) {
  const dur = duration;
  const hasTimeline =
    picked != null && dur != null && Number.isFinite(dur) && dur > 0;

  if (!hasTimeline || !picked) {
    const ranges = clampRanges(mergeRanges(parseRanges(cuts)), dur);
    if (mode === "remove") {
      return (
        <div className="flex flex-col gap-2">
          <CutList ranges={ranges} dur={dur} onChange={(rs) => onCuts(fmtRanges(rs))} />
          <p className="text-[12px] leading-snug text-neutral-400">
            {picked
              ? "Reading duration… the timeline appears once it's known. Sections can be typed meanwhile (0:12-0:18, 90-95)."
              : "Pick a file to unlock the draggable timeline. You can also type sections (0:12-0:18, 90-95)."}
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start">
            <TextInput value={start} placeholder="0:00" onChange={onStart} />
          </Field>
          <Field label="End (blank = to end)">
            <TextInput
              value={end}
              placeholder={dur != null ? fmtTime(dur) : "1:30"}
              onChange={onEnd}
            />
          </Field>
        </div>
        <p className="text-[12px] leading-snug text-neutral-400">
          {picked
            ? "Reading duration… the draggable timeline appears once it's known. You can paste timestamps meanwhile (90, 1:30, 01:30.5)."
            : "Pick a file to unlock the draggable timeline. You can also paste timestamps directly (90, 1:30, 01:30.5)."}
        </p>
      </div>
    );
  }

  return (
    <TrimTimeline
      mode={mode}
      start={start}
      end={end}
      cuts={cuts}
      onStart={onStart}
      onEnd={onEnd}
      onCuts={onCuts}
      onCommit={onCommit}
      picked={picked}
      pickedUrl={pickedUrl}
      pickedKind={pickedKind}
      dur={dur}
      running={running}
    />
  );
}

/** One row per removed section, with exact timestamps for frame-level edits. */
function CutList({
  ranges,
  dur,
  onChange,
}: {
  ranges: Range[];
  dur: number | null;
  onChange: (rs: Range[]) => void;
}) {
  // Keep half-typed text ("1:", "0:12.") alive while the value round-trips.
  const [raw, setRaw] = useState<Record<string, string>>({});

  const hi = dur != null && Number.isFinite(dur) ? dur : Number.POSITIVE_INFINITY;
  const shown = (i: number, edge: 0 | 1, v: number): string =>
    raw[`${i}:${edge}`] ?? fmtTrim(v);

  const apply = (i: number, edge: 0 | 1, t: number): void => {
    onChange(
      ranges.map((r, j) =>
        j === i
          ? edge === 0
            ? { a: clamp(round1(t), 0, r.b - MIN_CUT), b: r.b }
            : { a: r.a, b: clamp(round1(t), r.a + MIN_CUT, hi) }
          : r,
      ),
    );
  };

  const edit = (i: number, edge: 0 | 1, text: string): void => {
    setRaw((p) => ({ ...p, [`${i}:${edge}`]: text }));
    const t = parseTime(text);
    if (t == null) return;
    apply(i, edge, t);
  };

  const settle = (i: number, edge: 0 | 1): void => {
    setRaw((p) => {
      const q = { ...p };
      delete q[`${i}:${edge}`];
      return q;
    });
  };

  if (ranges.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[#e0dfdb] bg-[#fafaf8] px-3 py-2.5 text-[12px] leading-snug text-[#a3a099]">
        No sections marked — the whole file is kept. Drag across the timeline to mark one, or
        type exact times above.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {ranges.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-lg border border-[#f0d3d4] bg-[#fdebec] px-2 py-2"
        >
          <Field label={`Section ${i + 1} from`}>
            <TextInput
              value={shown(i, 0, r.a)}
              placeholder="0:12"
              inputMode="text"
              // "time", not "start": the overlay handle above is already
              // labelled "Section N start", and two controls with one name are
              // indistinguishable when you tab between them.
              ariaLabel={`Section ${i + 1} start time`}
              onChange={(v) => edit(i, 0, v)}
              onBlurNormalize={() => settle(i, 0)}
            />
          </Field>
          <Field label="to">
            <TextInput
              value={shown(i, 1, r.b)}
              placeholder="0:18"
              inputMode="text"
              ariaLabel={`Section ${i + 1} end time`}
              onChange={(v) => edit(i, 1, v)}
              onBlurNormalize={() => settle(i, 1)}
            />
          </Field>
          <button
            type="button"
            aria-label={`Remove section ${i + 1}`}
            onClick={() => onChange(ranges.filter((_, j) => j !== i))}
            className="mb-0.5 grid size-11 shrink-0 place-items-center rounded-md border border-[#e5e4e0] bg-white text-[16px] font-medium text-[#9f2f2d]"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

type CutDrag =
  | { kind: "new"; base: Range[]; anchor: number; moved: boolean }
  | { kind: "edge"; base: Range[]; index: number; edge: 0 | 1; moved: boolean }
  | { kind: "move"; base: Range[]; index: number; grab: number; moved: boolean };

function TrimTimeline({
  mode,
  start,
  end,
  cuts,
  onStart,
  onEnd,
  onCuts,
  onCommit,
  picked,
  pickedUrl,
  pickedKind,
  dur,
  running,
}: {
  mode: TrimMode;
  start: string;
  end: string;
  cuts: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onCuts: (v: string) => void;
  onCommit: (s: string, e: string) => void;
  picked: File;
  pickedUrl: string | null;
  pickedKind: PickedKind;
  dur: number;
  running: boolean;
}) {
  const removeMode = mode === "remove";

  const trimSecs = (): { s: number; e: number } => {
    const ps = parseTime(startRef.current);
    const pe = parseTime(endRef.current);
    const s = ps == null ? 0 : clamp(ps, 0, dur);
    const e = pe == null ? dur : clamp(pe, 0, dur);
    return { s, e };
  };

  const startRef = useRef(start);
  const endRef = useRef(end);
  startRef.current = start;
  endRef.current = end;

  const { s, e } = (() => {
    const ps = parseTime(start);
    const pe = parseTime(end);
    return {
      s: ps == null ? 0 : clamp(ps, 0, dur),
      e: pe == null ? dur : clamp(pe, 0, dur),
    };
  })();

  const sPct = (clamp(s, 0, dur) / dur) * 100;
  const ePct = (clamp(e, 0, dur) / dur) * 100;
  const lo = Math.min(sPct, ePct);
  const hi = Math.max(sPct, ePct);

  const trackRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const hStartRef = useRef<HTMLButtonElement>(null);
  const hEndRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ mode: "start" | "end" | "move"; offset: number } | null>(null);
  const cutDragRef = useRef<CutDrag | null>(null);
  const keepPlayingRef = useRef(false);
  const playTRef = useRef(0);
  const genRef = useRef(0);

  const [thumbs, setThumbs] = useState<string[] | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [stripFailed, setStripFailed] = useState(false);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);

  // Cuts live as a packed string in opts, so mirror the parsed list in a draft
  // while dragging: options only change when the gesture ends.
  const cutsRef = useRef(cuts);
  cutsRef.current = cuts;
  const committed = useMemo(
    () => clampRanges(mergeRanges(parseRanges(cuts)), dur),
    [cuts, dur],
  );
  const [draft, setDraftState] = useState<Range[] | null>(null);
  const draftRef = useRef<Range[] | null>(null);
  const shownCuts = draft ?? committed;
  const setDraft = (v: Range[] | null): void => {
    draftRef.current = v;
    setDraftState(v);
  };

  const commit = (ns: number, ne: number): void => {
    const cs = fmtTrim(clamp(ns, 0, dur));
    const ce = fmtTrim(clamp(ne, 0, dur));
    onCommit(cs, ce);
  };

  const timeFromClientX = (clientX: number): number => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return clamp(((clientX - r.left) / r.width) * dur, 0, dur);
  };

  // Async visuals: filmstrip for video, waveform otherwise (or as fallback).
  useEffect(() => {
    const gen = ++genRef.current;
    const isCurrent = (): boolean => gen === genRef.current;
    setThumbs(null);
    setPeaks(null);
    setStripFailed(false);
    const isVideo = pickedKind === "video" && pickedUrl && picked.size < 120 * 1024 * 1024;
    void (async () => {
      if (isVideo && pickedUrl) {
        const t = await captureFilmstrip(pickedUrl, dur, 8, isCurrent);
        if (!isCurrent()) return;
        if (t && t.length > 0) {
          setThumbs(t);
          return;
        }
      }
      if (!isCurrent()) return;
      const p = await peakWaveform(picked);
      if (!isCurrent()) return;
      if (p) setPeaks(p);
      else setStripFailed(true);
    })();
    return () => {
      genRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedUrl, dur, pickedKind, picked]);

  useEffect(() => {
    if (peaks && waveCanvasRef.current) {
      const canvas = waveCanvasRef.current;
      const raf = requestAnimationFrame(() => {
        paintWaveform(canvas, peaks);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [peaks]);

  const applyCutDrag = (t: number): void => {
    const live = cutDragRef.current;
    if (!live) return;
    if (live.kind === "new") {
      if (Math.abs(t - live.anchor) < MIN_CUT) return;
      live.moved = true;
      setDraft(
        mergeRanges([
          ...live.base,
          { a: Math.min(live.anchor, t), b: Math.max(live.anchor, t) },
        ]),
      );
      return;
    }
    live.moved = true;
    const next = live.base.map((r) => ({ ...r }));
    const r = next[live.index];
    if (!r) return;
    if (live.kind === "edge") {
      if (live.edge === 0) r.a = clamp(round1(t), 0, r.b - MIN_CUT);
      else r.b = clamp(round1(t), r.a + MIN_CUT, dur);
    } else {
      const len = r.b - r.a;
      const a = clamp(round1(t - live.grab), 0, Math.max(0, dur - len));
      r.a = a;
      r.b = a + len;
    }
    setDraft(mergeRanges(next));
  };

  const handleTrackPointerDown = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (running) return;
    const t = round1(timeFromClientX(ev.clientX));
    if (removeMode) {
      const el = ev.target as HTMLElement | null;
      const host = el?.closest?.("[data-cut]") as HTMLElement | null;
      const base = shownCuts.map((r) => ({ ...r }));
      if (host) {
        const index = Number(host.getAttribute("data-i"));
        const role = host.getAttribute("data-role");
        if (role === "del") {
          onCuts(fmtRanges(base.filter((_, j) => j !== index)));
          return;
        }
        const r = base[index];
        if (!r) return;
        cutDragRef.current =
          role === "0" || role === "1"
            ? { kind: "edge", base, index, edge: role === "1" ? 1 : 0, moved: false }
            : { kind: "move", base, index, grab: t - r.a, moved: false };
      } else {
        cutDragRef.current = { kind: "new", base, anchor: t, moved: false };
        // Seed a sliver so the gesture is visible from the first pixel.
        setDraft(mergeRanges([...base, { a: t, b: Math.min(t + MIN_CUT, dur) }]));
        seekTo(t);
      }
    } else {
      const { s: cs, e: ce } = trimSecs();
      const el = ev.target as HTMLElement | null;
      let m: "start" | "end" | "move";
      if (el && hStartRef.current?.contains(el)) m = "start";
      else if (el && hEndRef.current?.contains(el)) m = "end";
      else if (t > cs && t < ce) {
        const r = trackRef.current?.getBoundingClientRect();
        const edgePx = 28;
        const x = r ? ev.clientX - r.left : 0;
        const sX = r ? (cs / dur) * r.width : 0;
        const eX = r ? (ce / dur) * r.width : 0;
        m = Math.abs(x - sX) < edgePx ? "start" : Math.abs(x - eX) < edgePx ? "end" : "move";
        if (m !== "move") {
          const v = round1(t);
          if (m === "start") commit(Math.min(v, ce - MIN_GAP), ce);
          else commit(cs, Math.max(v, cs + MIN_GAP));
        }
      } else {
        m = Math.abs(t - cs) <= Math.abs(t - ce) ? "start" : "end";
        const v = round1(t);
        if (m === "start") commit(Math.min(v, ce - MIN_GAP), ce);
        else commit(cs, Math.max(v, cs + MIN_GAP));
      }
      dragRef.current = { mode: m, offset: m === "move" ? t - trimSecs().s : 0 };
      if (m === "start") hStartRef.current?.focus({ preventScroll: true });
      else if (m === "end") hEndRef.current?.focus({ preventScroll: true });
    }
    try {
      trackRef.current?.setPointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
    ev.preventDefault();
  };

  const handleTrackPointerMove = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const t = round1(timeFromClientX(ev.clientX));
    if (removeMode) {
      applyCutDrag(t);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const { s: cs, e: ce } = trimSecs();
    if (drag.mode === "start") commit(Math.min(t, ce - MIN_GAP), ce);
    else if (drag.mode === "end") commit(cs, Math.max(t, cs + MIN_GAP));
    else {
      const len = ce - cs;
      const ns = clamp(t - drag.offset, 0, Math.max(0, dur - len));
      commit(ns, ns + len);
    }
  };

  const endDrag = (): void => {
    dragRef.current = null;
    const live = cutDragRef.current;
    cutDragRef.current = null;
    if (!live) return;
    const list = draftRef.current;
    setDraft(null);
    // A tap that never grew past a sliver was not meant as a cut.
    if (live.kind === "new" && !live.moved) return;
    onCuts(fmtRanges(list ?? mergeRanges(parseRanges(cutsRef.current))));
  };

  const nudge = (which: "start" | "end", delta: number): void => {
    const { s: cs, e: ce } = trimSecs();
    if (which === "start") commit(clamp(round1(cs + delta), 0, ce - MIN_GAP), ce);
    else commit(cs, clamp(round1(ce + delta), cs + MIN_GAP, dur));
  };

  const adjustCut = (index: number, edge: 0 | 1, delta: number): void => {
    const next = shownCuts.map((r) => ({ ...r }));
    const r = next[index];
    if (!r) return;
    if (edge === 0) r.a = clamp(round1(r.a + delta), 0, r.b - MIN_CUT);
    else r.b = clamp(round1(r.b + delta), r.a + MIN_CUT, dur);
    onCuts(fmtRanges(mergeRanges(next)));
  };

  const normalize = (which: "start" | "end"): void => {
    const raw = which === "start" ? startRef.current : endRef.current;
    const v = parseTime(raw);
    if (v != null) {
      const nv = fmtTrim(clamp(v, 0, dur));
      if (which === "start") onStart(nv);
      else onEnd(nv);
    }
  };

  const showHead = (): void => {
    const media = mediaRef.current;
    const head = playheadRef.current;
    if (!media || !head) return;
    const t = media.currentTime;
    playTRef.current = Number.isFinite(t) ? clamp(t, 0, dur) : 0;
    if (!Number.isFinite(t) || t < 0 || t > dur) {
      head.classList.add("hidden");
      return;
    }
    head.classList.remove("hidden");
    head.style.left = `${(clamp(t, 0, dur) / dur) * 100}%`;
  };

  const seekTo = (t: number): void => {
    const media = mediaRef.current;
    if (!media) return;
    try {
      media.currentTime = t;
    } catch {
      /* noop */
    }
  };

  /** Stop the preview where the kept region ends — the end handle, or a cut. */
  const handleTimeUpdate = (): void => {
    showHead();
    const media = mediaRef.current;
    if (!media || !keepPlayingRef.current) return;
    const past = removeMode ? inCuts(media.currentTime, shownCuts) : media.currentTime >= trimSecs().e;
    if (past) {
      keepPlayingRef.current = false;
      media.pause();
    }
  };

  const handlePlayKeep = (): void => {
    const media = mediaRef.current;
    if (!media) return;
    let from = removeMode ? playTRef.current : trimSecs().s;
    if (removeMode && inCuts(from, shownCuts)) {
      // Landed inside a cut — resume from its far side instead of stalling.
      const after = shownCuts.find((r) => r.b > from);
      from = after ? after.b : dur;
    }
    if (from >= dur) return;
    keepPlayingRef.current = true;
    seekTo(from);
    void media.play().catch(() => {
      keepPlayingRef.current = false;
    });
  };

  const addCutAtPlayhead = (): void => {
    const t = clamp(round1(playTRef.current), 0, Math.max(0, dur - MIN_CUT));
    const next = mergeRanges([...shownCuts, { a: t, b: Math.min(round1(t + 2), dur) }]);
    if (next.length === shownCuts.length) return;
    onCuts(fmtRanges(next));
  };

  const backdrop = thumbs ? (
    thumbs.map((src, i) => (
      <img key={i} src={src} alt="" draggable={false} className="h-full flex-1 object-cover" />
    ))
  ) : peaks ? (
    <canvas ref={waveCanvasRef} className="h-full w-full" />
  ) : stripFailed ? (
    <div className="h-full w-full bg-[#ecebe8]" />
  ) : (
    Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="h-full flex-1 animate-pulse bg-black/[0.04]" />
    ))
  );

  const removedSecs = shownCuts.reduce((acc, r) => acc + (r.b - r.a), 0);

  return (
    <div className="flex flex-col gap-2">
      {pickedUrl && pickedKind === "video" && (
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={pickedUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-56 w-full rounded-lg border border-[#eaeaea] bg-black object-contain"
          onTimeUpdate={handleTimeUpdate}
          onSeeked={showHead}
          onPause={() => {
            keepPlayingRef.current = false;
          }}
        />
      )}
      {pickedUrl && pickedKind === "audio" && (
        <audio
          ref={mediaRef as React.RefObject<HTMLAudioElement>}
          src={pickedUrl}
          controls
          preload="metadata"
          className="w-full"
          onTimeUpdate={handleTimeUpdate}
          onSeeked={showHead}
          onPause={() => {
            keepPlayingRef.current = false;
          }}
        />
      )}

      {removeMode ? (
        <div className="flex items-baseline justify-between text-xs text-neutral-500">
          <span className="font-semibold text-neutral-900">
            {shownCuts.length === 0
              ? "Nothing cut"
              : `Cut ${shownCuts.length} section${shownCuts.length > 1 ? "s" : ""}`}
          </span>
          <span className="tag tag-red">
            {removedSecs > 0 ? `Keep ${fmtTrim(dur - removedSecs)}` : "Keep everything"}
          </span>
          <span className="font-medium">{fmtTrim(dur)}</span>
        </div>
      ) : (
        <div className="flex items-baseline justify-between text-xs text-neutral-500">
          <span className="font-semibold text-neutral-900">{fmtTrim(s)}</span>
          <span className="tag tag-green">
            {e > s ? `Keep ${fmtTrim(e - s)}` : "End must be after start"}
          </span>
          <span className="font-medium">{fmtTrim(e)}</span>
        </div>
      )}

      <div
        ref={trackRef}
        className="trim-track relative h-20 overflow-hidden rounded-lg border border-[#e0dfdb] bg-[#f1f0ed]"
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="absolute inset-0 flex">{backdrop}</div>

        {removeMode ? (
          shownCuts.map((r, i) => {
            const a = (clamp(r.a, 0, dur) / dur) * 100;
            const b = (clamp(r.b, 0, dur) / dur) * 100;
            return (
              <div
                key={i}
                data-cut=""
                data-i={i}
                data-role="move"
                className="absolute inset-y-0 cursor-grab bg-[#e8a3a4]/60"
                style={{ left: `${a}%`, width: `${Math.max(0.5, b - a)}%` }}
              >
                <span
                  className="pointer-events-none absolute inset-0 border-y-2 border-[#b94e4f]/70"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  data-cut=""
                  data-i={i}
                  data-role="0"
                  role="slider"
                  aria-label={`Section ${i + 1} start`}
                  aria-valuemin={0}
                  aria-valuemax={dur}
                  aria-valuenow={r.a}
                  aria-valuetext={fmtTrim(r.a)}
                  className="trim-handle absolute inset-y-0 left-0 w-3 rounded-r-md border border-[#d8d7d2] bg-white"
                  onKeyDown={(ev) => {
                    const step = ev.shiftKey ? 1 : 0.1;
                    if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
                      ev.preventDefault();
                      adjustCut(i, 0, -step);
                    } else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
                      ev.preventDefault();
                      adjustCut(i, 0, step);
                    } else if (ev.key === "Delete" || ev.key === "Backspace") {
                      ev.preventDefault();
                      onCuts(fmtRanges(shownCuts.filter((_, j) => j !== i)));
                    }
                  }}
                />
                <button
                  type="button"
                  data-cut=""
                  data-i={i}
                  data-role="1"
                  role="slider"
                  aria-label={`Section ${i + 1} end`}
                  aria-valuemin={0}
                  aria-valuemax={dur}
                  aria-valuenow={r.b}
                  aria-valuetext={fmtTrim(r.b)}
                  className="trim-handle absolute inset-y-0 right-0 w-3 rounded-l-md border border-[#d8d7d2] bg-white"
                  onKeyDown={(ev) => {
                    const step = ev.shiftKey ? 1 : 0.1;
                    if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
                      ev.preventDefault();
                      adjustCut(i, 1, -step);
                    } else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
                      ev.preventDefault();
                      adjustCut(i, 1, step);
                    } else if (ev.key === "Delete" || ev.key === "Backspace") {
                      ev.preventDefault();
                      onCuts(fmtRanges(shownCuts.filter((_, j) => j !== i)));
                    }
                  }}
                />
                <button
                  type="button"
                  data-cut=""
                  data-i={i}
                  data-role="del"
                  aria-label={`Remove section ${i + 1}`}
                  className="absolute left-1/2 top-1 grid size-6 -translate-x-1/2 place-items-center rounded-md border border-[#e5e4e0] bg-white text-[12px] font-bold leading-none text-[#9f2f2d]"
                >
                  ×
                </button>
              </div>
            );
          })
        ) : (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-black/45"
              style={{ width: `${lo}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-black/45"
              style={{ width: `${100 - hi}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 rounded-[4px] border-2 border-[#111] bg-[#111]/[0.06]"
              style={{ left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` }}
            />
            <button
              ref={hStartRef}
              type="button"
              className="trim-handle absolute inset-y-0 z-10 grid w-6 place-items-center border border-[#d8d7d2] bg-white outline-none left-0 rounded-r-md"
              style={{ left: `calc(${lo}% - ${(lo * 24) / 100}px)` }}
              role="slider"
              aria-label="Trim start"
              aria-valuemin={0}
              aria-valuemax={dur}
              aria-valuenow={s}
              aria-valuetext={fmtTrim(s)}
              onKeyDown={(ev) => {
                const step = ev.shiftKey ? 5 : 1;
                if (ev.key === "ArrowLeft") {
                  ev.preventDefault();
                  nudge("start", -step);
                } else if (ev.key === "ArrowRight") {
                  ev.preventDefault();
                  nudge("start", step);
                } else if (ev.key === "Home") {
                  ev.preventDefault();
                  commit(0, trimSecs().e);
                }
              }}
            >
              <span className="flex gap-[3px]" aria-hidden="true">
                <span className="h-6 w-[2px] rounded-full bg-neutral-300" />
                <span className="h-6 w-[2px] rounded-full bg-neutral-300" />
              </span>
            </button>
            <button
              ref={hEndRef}
              type="button"
              className="trim-handle absolute inset-y-0 z-10 grid w-6 place-items-center border border-[#d8d7d2] bg-white outline-none right-0 rounded-l-md"
              style={{ left: `calc(${hi}% - ${(hi * 24) / 100}px)` }}
              role="slider"
              aria-label="Trim end"
              aria-valuemin={0}
              aria-valuemax={dur}
              aria-valuenow={e}
              aria-valuetext={fmtTrim(e)}
              onKeyDown={(ev) => {
                const step = ev.shiftKey ? 5 : 1;
                if (ev.key === "ArrowLeft") {
                  ev.preventDefault();
                  nudge("end", -step);
                } else if (ev.key === "ArrowRight") {
                  ev.preventDefault();
                  nudge("end", step);
                } else if (ev.key === "End") {
                  ev.preventDefault();
                  commit(trimSecs().s, dur);
                }
              }}
            >
              <span className="flex gap-[3px]" aria-hidden="true">
                <span className="h-6 w-[2px] rounded-full bg-neutral-300" />
                <span className="h-6 w-[2px] rounded-full bg-neutral-300" />
              </span>
            </button>
          </>
        )}

        <div
          ref={playheadRef}
          className="pointer-events-none absolute inset-y-0 hidden w-[2px] bg-white outline outline-1 outline-black/25"
        />
      </div>

      {removeMode ? (
        <>
          <CutList
            ranges={shownCuts}
            dur={dur}
            onChange={(rs) => onCuts(fmtRanges(mergeRanges(rs)))}
          />
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-secondary min-h-11 text-[14px] font-semibold"
              onClick={handlePlayKeep}
            >
              Preview keep
            </button>
            <button
              type="button"
              className="btn-secondary min-h-11 text-[14px] font-semibold"
              onClick={addCutAtPlayhead}
            >
              Add cut here
            </button>
          </div>
          {shownCuts.length > 0 && (
            <button
              type="button"
              className="w-full py-1 text-[14px] font-medium text-[#9f2f2d]"
              onClick={() => onCuts("")}
            >
              Clear all sections
            </button>
          )}
          <p className="text-[12px] leading-snug text-neutral-400">
            Red = removed. Drag across the timeline to cut a middle section, drag a section to
            move it, or type exact times. Cutting always re-encodes, so it is not a keyframe
            copy.
          </p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start — drag or paste">
              <TextInput
                value={start}
                placeholder="0:00"
                ariaLabel="Start timestamp"
                onChange={onStart}
                onBlurNormalize={() => normalize("start")}
              />
            </Field>
            <Field label="End — drag or paste">
              <TextInput
                value={end}
                placeholder={fmtTrim(dur)}
                ariaLabel="End timestamp"
                onChange={onEnd}
                onBlurNormalize={() => normalize("end")}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-secondary min-h-11 text-[14px] font-semibold"
              onClick={handlePlayKeep}
            >
              Play keep
            </button>
            <button
              type="button"
              className="btn-secondary min-h-11 text-[14px] font-semibold"
              onClick={() => commit(0, dur)}
            >
              Full length
            </button>
          </div>

          <p className="text-[12px] leading-snug text-neutral-400">
            Blue = kept part. Drag handles, drag the middle to move, or paste timestamps like
            90, 1:30, 01:30.5.
          </p>
        </>
      )}
    </div>
  );
}
