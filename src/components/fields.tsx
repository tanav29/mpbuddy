import type { ReactNode } from "react";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const selectCls =
  "min-h-12 w-full appearance-none rounded-xl border border-black/10 bg-[#f5f5f7] px-3 text-[15px] text-neutral-900 outline-none transition-colors focus:border-[#0071e3]";

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={selectCls}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
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
      className="min-h-12 w-full rounded-xl border border-black/10 bg-[#f5f5f7] px-3.5 text-[15px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0071e3]"
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlurNormalize}
    />
  );
}
