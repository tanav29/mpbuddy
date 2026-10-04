import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

const labelCls = "text-[13px] font-medium leading-tight text-[#55534e]";
const hintCls = "text-[13px] leading-snug text-[#a3a099]";

/**
 * A labelled group of controls.
 * `group` is for non-input children (segmented pickers, switches): it names the
 * group instead of labelling a single form control.
 * `inline` seats a short label beside its control instead of above it, so a row
 * of options costs one line rather than two.
 */
export function Field({
  label,
  children,
  hint,
  group,
  inline,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  group?: boolean;
  inline?: boolean;
}) {
  const cls = inline
    ? "grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1"
    : "flex flex-col gap-1.5";
  const body = (
    <>
      <span className={inline ? `${labelCls} whitespace-nowrap` : labelCls}>{label}</span>
      {children}
      {hint ? <span className={inline ? `col-span-2 ${hintCls}` : hintCls}>{hint}</span> : null}
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-label={label}>
      {body}
    </div>
  ) : (
    <label className={cls}>{body}</label>
  );
}

export const inputCls =
  "min-h-11 w-full rounded-md border border-[#e0dfdb] bg-white px-3 text-[15px] text-[#111] outline-none transition-colors placeholder:text-[#b4b2aa] focus:border-[#111]";

/** [value, label] — or [value, label, sub-label] for a two-line chip. */
export type SegOption = readonly [string, string] | readonly [string, string, string];

/**
 * Segmented picker. Every option is on screen, so choosing one is a single
 * click instead of opening a menu and reading it.
 */
export function Segmented({
  value,
  options,
  onChange,
  cols = 3,
  ariaLabel,
}: {
  value: string;
  options: readonly SegOption[];
  onChange: (v: string) => void;
  cols?: 2 | 3 | 4;
  ariaLabel?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const grid = cols === 4 ? "grid-cols-4" : cols === 3 ? "grid-cols-3" : "grid-cols-2";
  const active = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );

  /** Radio semantics: one stop in the tab order, arrows move and choose. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = active >= last ? 0 : active + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = active <= 0 ? last : active - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next == null) return;
    e.preventDefault();
    const [v] = options[next]!;
    onChange(v);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`grid ${grid} gap-1 rounded-lg border border-[#e5e4e0] bg-[#f4f3f0] p-1`}
    >
      {options.map(([v, label, sub], i) => {
        const on = v === value;
        return (
          <button
            key={v}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === active ? 0 : -1}
            onClick={() => onChange(v)}
            className={
              (on
                ? "border-[#e0dfdb] bg-white text-[#111] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                : "border-transparent text-[#787774] hover:text-[#111]") +
              " flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md border px-1 py-1 text-center transition-colors"
            }
          >
            <span className="text-[13.5px] font-semibold leading-tight tracking-tight">
              {label}
            </span>
            {sub ? (
              <span className="text-[11px] font-medium leading-none tabular-nums opacity-60">
                {sub}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Number without a trailing ".0" — 2 reads better on a control than 2.00. */
export function trimNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * The furniture around a slider: name on the left, current choice in a small
 * mono chip on the right, stop marks under the track, hint underneath.
 */
function SliderFrame({
  label,
  valueText,
  hint,
  ticks,
  children,
}: {
  label: string;
  valueText: string;
  hint?: ReactNode;
  /** Stop positions (0..1) dotted under the track. */
  ticks?: number[];
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="rounded-lg border border-[#eaeaea] bg-white px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={labelCls}>{label}</span>
        <span className="shrink-0 rounded-full border border-[#e5e4e0] bg-[#f4f3f0] px-2 py-0.5 font-mono text-[12.5px] font-semibold tabular-nums text-[#111]">
          {valueText}
        </span>
      </div>
      <div className="mt-1">{children}</div>
      {ticks && ticks.length > 1 && (
        // Inset by half a thumb so the end dots sit under the thumb centres.
        <div aria-hidden="true" className="relative mx-[11px] h-1.5">
          {ticks.map((p, i) => (
            <span
              key={i}
              className="absolute top-0 size-1 -translate-x-1/2 rounded-full bg-[#d8d7d2]"
              style={{ left: `${p * 100}%` }}
            />
          ))}
        </div>
      )}
      {hint ? <p className={`mt-0.5 ${hintCls}`}>{hint}</p> : null}
    </div>
  );
}

const rangeCls =
  "slider block w-full appearance-none bg-transparent focus:outline-none focus-visible:outline-none";

/**
 * Slider over a fixed set of choices. Every stop is reachable by dragging and
 * the track shows where they are, which a text field can't do.
 */
export function Slider({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: readonly SegOption[];
  onChange: (v: string) => void;
  hint?: ReactNode;
}) {
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  const [v, text] = options[idx]!;
  const fill = options.length > 1 ? (idx / (options.length - 1)) * 100 : 0;
  return (
    <SliderFrame
      label={label}
      valueText={text ?? v}
      hint={hint}
      ticks={options.map((_, i) => (options.length > 1 ? i / (options.length - 1) : 0))}
    >
      <input
        type="range"
        className={rangeCls}
        min={0}
        max={Math.max(1, options.length - 1)}
        step={1}
        value={idx}
        aria-label={label}
        aria-valuetext={text ?? v}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(e) => {
          const next = options[Number(e.target.value)];
          if (next) onChange(next[0]);
        }}
      />
    </SliderFrame>
  );
}

/** Slider over a continuous number, for anything with a sensible middle. */
export function RangeSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  format = trimNum,
  ticks,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: ReactNode;
  format?: (v: number) => string;
  /** Values to dot under the track, e.g. the "1× is normal" landmarks. */
  ticks?: number[];
}) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  // A stored value can sit outside the range (a typed time, a duration that
  // shrank) — clamp for the control so the thumb never renders off the track.
  const v = Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));
  const span = hi - lo || 1;
  return (
    <SliderFrame
      label={label}
      valueText={format(v)}
      hint={hint}
      ticks={ticks?.map((t) => (t - lo) / span)}
    >
      <input
        type="range"
        className={rangeCls}
        min={lo}
        max={hi}
        step={step}
        value={v}
        aria-label={label}
        aria-valuetext={format(v)}
        style={{ "--fill": `${((v - lo) / span) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </SliderFrame>
  );
}

/** On/off switch for a single boolean. */
export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-[#eaeaea] bg-white px-3 text-left transition-colors hover:border-[#d8d7d2]"
    >
      <span className="text-[14px] font-medium text-[#111]">{label}</span>
      <span
        className={
          (checked ? "bg-[#111]" : "bg-[#e0dfdb]") +
          " flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors"
        }
      >
        <span
          className={
            (checked ? "translate-x-5" : "translate-x-0") +
            " size-5 rounded-full bg-white transition-transform"
          }
        />
      </span>
    </button>
  );
}

export function TextInput({
  value,
  placeholder,
  onChange,
  onBlurNormalize,
  ariaLabel,
  inputMode = "text",
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlurNormalize?: () => void;
  ariaLabel?: string;
  inputMode?: "text" | "decimal" | "numeric";
}) {
  return (
    <input
      aria-label={ariaLabel}
      className={inputCls}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlurNormalize}
    />
  );
}
