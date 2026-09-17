import { useEffect, useRef, useState } from "react";
import { clamp, fmtTime, fmtTrim, parseTime, peakWaveform } from "../files";
import { Field, TextInput } from "./fields";

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

export type PickedKind = "video" | "audio" | null;

export default function TrimEditor({
  start,
  end,
  onStart,
  onEnd,
  onCommit,
  picked,
  pickedUrl,
  pickedKind,
  duration,
  running,
}: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
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
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
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
        <p className="text-[11px] leading-snug text-neutral-400">
          {picked
            ? "Reading duration… the draggable timeline appears once it's known. You can paste timestamps meanwhile (90, 1:30, 01:30.5)."
            : "Pick a file to unlock the draggable timeline. You can also paste timestamps directly (90, 1:30, 01:30.5)."}
        </p>
      </div>
    );
  }

  return (
    <TrimTimeline
      start={start}
      end={end}
      onStart={onStart}
      onEnd={onEnd}
      onCommit={onCommit}
      picked={picked}
      pickedUrl={pickedUrl}
      pickedKind={pickedKind}
      dur={dur}
      running={running}
    />
  );
}

function TrimTimeline({
  start,
  end,
  onStart,
  onEnd,
  onCommit,
  picked,
  pickedUrl,
  pickedKind,
  dur,
  running,
}: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onCommit: (s: string, e: string) => void;
  picked: File;
  pickedUrl: string | null;
  pickedKind: PickedKind;
  dur: number;
  running: boolean;
}) {
  const MIN_GAP = 0.2;
  const round1 = (v: number): number => Math.round(v * 10) / 10;

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
  const keepPlayingRef = useRef(false);
  const genRef = useRef(0);

  const [thumbs, setThumbs] = useState<string[] | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [stripFailed, setStripFailed] = useState(false);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);

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

  const handleTrackPointerDown = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (running) return;
    const t = timeFromClientX(ev.clientX);
    const { s: cs, e: ce } = trimSecs();
    const el = ev.target as HTMLElement | null;
    let mode: "start" | "end" | "move";
    if (el && hStartRef.current?.contains(el)) mode = "start";
    else if (el && hEndRef.current?.contains(el)) mode = "end";
    else if (t > cs && t < ce) {
      const r = trackRef.current?.getBoundingClientRect();
      const edgePx = 28;
      const x = r ? ev.clientX - r.left : 0;
      const sX = r ? (cs / dur) * r.width : 0;
      const eX = r ? (ce / dur) * r.width : 0;
      mode =
        Math.abs(x - sX) < edgePx ? "start" : Math.abs(x - eX) < edgePx ? "end" : "move";
      if (mode !== "move") {
        const v = round1(t);
        if (mode === "start") commit(Math.min(v, ce - MIN_GAP), ce);
        else commit(cs, Math.max(v, cs + MIN_GAP));
      }
    } else {
      mode = Math.abs(t - cs) <= Math.abs(t - ce) ? "start" : "end";
      const v = round1(t);
      if (mode === "start") commit(Math.min(v, ce - MIN_GAP), ce);
      else commit(cs, Math.max(v, cs + MIN_GAP));
    }
    dragRef.current = { mode, offset: mode === "move" ? t - trimSecs().s : 0 };
    try {
      trackRef.current?.setPointerCapture(ev.pointerId);
    } catch {
      /* noop */
    }
    if (mode === "start") hStartRef.current?.focus({ preventScroll: true });
    else if (mode === "end") hEndRef.current?.focus({ preventScroll: true });
    ev.preventDefault();
  };

  const handleTrackPointerMove = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const t = round1(timeFromClientX(ev.clientX));
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
  };

  const nudge = (which: "start" | "end", delta: number): void => {
    const { s: cs, e: ce } = trimSecs();
    if (which === "start") commit(clamp(round1(cs + delta), 0, ce - MIN_GAP), ce);
    else commit(cs, clamp(round1(ce + delta), cs + MIN_GAP, dur));
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
    if (!Number.isFinite(t) || t < 0 || t > dur) {
      head.classList.add("hidden");
      return;
    }
    head.classList.remove("hidden");
    head.style.left = `${(clamp(t, 0, dur) / dur) * 100}%`;
  };

  const handlePlayKeep = (): void => {
    const media = mediaRef.current;
    if (!media) return;
    const { s: cs, e: ce } = trimSecs();
    if (!(ce > cs)) return;
    keepPlayingRef.current = true;
    try {
      media.currentTime = cs;
    } catch {
      /* noop */
    }
    void media.play().catch(() => {
      keepPlayingRef.current = false;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {pickedUrl && pickedKind === "video" && (
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={pickedUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-48 w-full rounded-xl bg-black object-contain"
          onTimeUpdate={() => {
            showHead();
            const media = mediaRef.current;
            if (media && keepPlayingRef.current && media.currentTime >= trimSecs().e) {
              keepPlayingRef.current = false;
              media.pause();
            }
          }}
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
          onTimeUpdate={() => {
            showHead();
            const media = mediaRef.current;
            if (media && keepPlayingRef.current && media.currentTime >= trimSecs().e) {
              keepPlayingRef.current = false;
              media.pause();
            }
          }}
          onSeeked={showHead}
          onPause={() => {
            keepPlayingRef.current = false;
          }}
        />
      )}

      <div className="flex items-baseline justify-between text-xs text-neutral-500">
        <span className="font-semibold text-neutral-900">{fmtTrim(s)}</span>
        <span className="rounded-full bg-[#0071e3]/10 px-2 py-0.5 font-medium text-[#0071e3]">
          {e > s ? `Keep ${fmtTrim(e - s)}` : "End must be after start"}
        </span>
        <span className="font-medium">{fmtTrim(e)}</span>
      </div>

      <div
        ref={trackRef}
        className="trim-track relative h-16 overflow-hidden rounded-xl border border-black/10 bg-black/[0.07]"
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="absolute inset-0 flex">
          {thumbs ? (
            thumbs.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                draggable={false}
                className="h-full flex-1 object-cover"
              />
            ))
          ) : peaks ? (
            <canvas ref={waveCanvasRef} className="h-full w-full" />
          ) : stripFailed ? (
            <div className="h-full w-full bg-gradient-to-r from-neutral-300 via-neutral-200 to-neutral-300" />
          ) : (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-full flex-1 animate-pulse bg-black/[0.06]" />
            ))
          )}
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/45"
          style={{ width: `${lo}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/45"
          style={{ width: `${100 - hi}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 rounded-[4px] border-2 border-[#0071e3] bg-[#0071e3]/15"
          style={{ left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` }}
        />
        <div
          ref={playheadRef}
          className="pointer-events-none absolute inset-y-0 hidden w-[2px] bg-white shadow-[0_0_4px_rgb(0_0_0/0.6)]"
        />

        <button
          ref={hStartRef}
          type="button"
          className="trim-handle absolute inset-y-0 z-10 grid w-6 place-items-center bg-white shadow-[0_1px_4px_rgb(0_0_0/0.3)] outline-none left-0 rounded-r-lg"
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
          className="trim-handle absolute inset-y-0 z-10 grid w-6 place-items-center bg-white shadow-[0_1px_4px_rgb(0_0_0/0.3)] outline-none right-0 rounded-l-lg"
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
      </div>

      <div className="grid grid-cols-2 gap-3">
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

      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          className="btn-apple-secondary min-h-11 rounded-[12px] text-sm font-semibold text-neutral-800"
          onClick={handlePlayKeep}
        >
          ▶ Play keep
        </button>
        <button
          type="button"
          className="btn-apple-secondary min-h-11 rounded-[12px] text-sm font-semibold text-neutral-800"
          onClick={() => commit(0, dur)}
        >
          Full length
        </button>
      </div>

      <p className="text-[11px] leading-snug text-neutral-400">
        Blue = kept part. Drag handles, drag the middle to move, or paste timestamps like
        90, 1:30, 01:30.5.
      </p>
    </div>
  );
}
