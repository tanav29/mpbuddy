import { useRef, useState } from "react";

/**
 * Squoosh-style before/after slider: the "after" layer is clipped to the
 * right of the divider; dragging the handle reveals more of it.
 * For videos, clicking toggles both clips together so the frame stays in sync.
 */
export default function ComparePreview({
  before,
  after,
  kind,
}: {
  before: string;
  after: string;
  kind: "video" | "image";
}) {
  const [pos, setPos] = useState(50);
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);

  const togglePlay = (): void => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b) return;
    if (a.paused || b.paused) {
      void a.play().catch(() => {});
      void b.play().catch(() => {});
    } else {
      a.pause();
      b.pause();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative overflow-hidden rounded-lg border border-[#eaeaea] bg-black"
        onClick={kind === "video" ? togglePlay : undefined}
      >
        {kind === "video" ? (
          <>
            <video
              ref={aRef}
              src={before}
              muted
              playsInline
              preload="metadata"
              className="max-h-80 w-full"
            />
            <video
              ref={bRef}
              src={after}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 max-h-80 w-full"
              style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
            />
          </>
        ) : (
          <>
            <img src={before} alt="Original" className="max-h-80 w-full object-contain" />
            <img
              src={after}
              alt="Compressed"
              className="absolute inset-0 max-h-80 w-full object-contain"
              style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
            />
          </>
        )}
        {/* Divider line */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80"
          style={{ left: `${pos}%` }}
        />
        <span className="absolute left-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-semibold text-white">
          Original
        </span>
        <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-semibold text-white">
          Result
        </span>
      </div>
      <input
        type="range"
        aria-label="Comparison position"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="slider w-full"
      />
      <p className="text-[12px] leading-snug text-[#a3a099]">
        Drag to compare before and after.{kind === "video" ? " Click the preview to play both." : ""}
      </p>
    </div>
  );
}
