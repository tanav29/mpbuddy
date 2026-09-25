import { useRef, type KeyboardEvent, type ReactNode } from "react";

const labelCls = "text-[12px] font-medium leading-tight text-neutral-600";
const hintCls = "text-[11px] leading-snug text-neutral-400";

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
    : "flex flex-col gap-1";
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
  "min-h-10 w-full rounded-[12px] border border-black/10 bg-[#f5f5f7] px-3 text-[14px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-accent";

/** [value, label] — or [value, label, sub-label] for a two-line chip. */
export type SegOption = readonly [string, string] | readonly [string, string, string];

/**
 * Segmented picker. Every option is on screen, so choosing one is a single
 * tap instead of opening a menu and reading it.
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
      className={`grid ${grid} gap-0.5 rounded-[13px] bg-black/[0.05] p-0.5`}
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
                ? "bg-white text-neutral-900 shadow-[0_1px_3px_rgb(0_0_0/0.14)]"
                : "text-neutral-500 hover:text-neutral-800") +
              " flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-[11px] px-1 py-1 text-center transition-colors"
            }
          >
            <span className="text-[12.5px] font-semibold leading-tight tracking-tight">
              {label}
            </span>
            {sub ? (
              <span className="text-[10px] font-medium leading-none tabular-nums opacity-60">
                {sub}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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
      className="flex min-h-10 w-full items-center justify-between gap-3 rounded-[12px] bg-black/[0.04] px-3 text-left transition-colors hover:bg-black/[0.06]"
    >
      <span className="text-[13px] font-semibold text-neutral-800">{label}</span>
      <span
        className={
          (checked ? "bg-accent" : "bg-black/15") +
          " flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors"
        }
      >
        <span
          className={
            (checked ? "translate-x-5" : "translate-x-0") +
            " size-5 rounded-full bg-white shadow transition-transform"
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
