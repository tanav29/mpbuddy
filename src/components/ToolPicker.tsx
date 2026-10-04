import { useMemo, useState } from "react";
import { TOOL_GROUPS, TOOLS, searchTools, type ToolId, type ToolDef } from "../tools";

function Chevron() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  );
}

function ToolTile({ tool, onOpen }: { tool: ToolDef; onOpen: (id: ToolId) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      className="card card-tint group relative flex min-h-[138px] flex-col items-start rounded-[20px] p-3.5 text-left transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-accent/30 focus-visible:-translate-y-0.5 active:translate-y-0"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-accent/10 text-accent">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-[21px]"
          dangerouslySetInnerHTML={{ __html: tool.icon }}
        />
      </span>
      <span className="mt-2.5 text-[16px] font-semibold leading-tight tracking-tight text-neutral-900">
        {tool.label}
      </span>
      <span className="mt-1 text-[12px] leading-snug text-neutral-500">{tool.hint}</span>
      <span className="pointer-events-none absolute right-3 top-3.5 size-4 text-neutral-300 transition-colors group-hover:text-accent">
        <Chevron />
      </span>
    </button>
  );
}

/**
 * The tools index. Nothing runs here — it exists so the 17 tools are browsable
 * one screen at a time instead of a wall of tabs above the editor, and so you
 * can search by the job in your head ("vertical", "smaller", "music").
 */
export default function ToolPicker({ onOpen }: { onOpen: (id: ToolId) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchTools(query), [query]);
  const groups = useMemo(
    () =>
      TOOL_GROUPS.map((g) => ({
        ...g,
        tools: results.filter((t) => t.group === g.id),
      })).filter((g) => g.tools.length > 0),
    [results],
  );

  const trimmed = query.trim();
  const count = results.length;

  return (
    <section aria-label="Tools">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const first = groups[0]?.tools[0];
          if (first) onOpen(first.id);
        }}
      >
        <div className="relative">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-neutral-400"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search tools"
            aria-label="Search tools"
            aria-describedby="toolCount"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-12 w-full rounded-[16px] border border-black/[0.07] bg-white/85 pl-11 pr-11 text-[15px] text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-accent focus:bg-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-black/[0.06] hover:text-neutral-700"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                className="size-4"
              >
                <path d="M18 6l-12 12" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </form>

      <p id="toolCount" className="mt-2.5 px-1 text-[12.5px] text-neutral-500">
        {count === TOOLS.length
          ? `${count} tools`
          : `${count} ${count === 1 ? "tool" : "tools"} match “${trimmed}”`}
      </p>

      {count === 0 ? (
        <div className="card card-tint mt-3 rounded-[20px] px-4 py-7 text-center">
          <p className="text-[15px] font-semibold tracking-tight text-neutral-900">
            Nothing matches “{trimmed}”
          </p>
          <p className="mx-auto mt-1.5 max-w-[30ch] text-[13px] leading-snug text-neutral-500">
            Search what you want the file to become: smaller, shorter, vertical, silent.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="btn-apple-primary mt-4 min-h-11 rounded-[14px] px-5 text-[14px] font-semibold"
          >
            Show all {TOOLS.length} tools
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.id}>
              <h3 className="px-1 text-[13px] font-semibold tracking-tight text-neutral-500">
                {g.title}
              </h3>
              <div className="mt-2 grid grid-cols-2 gap-2.5">
                {g.tools.map((t) => (
                  <ToolTile key={t.id} tool={t} onOpen={onOpen} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}