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

function ToolTile({
  tool,
  onOpen,
  index,
}: {
  tool: ToolDef;
  onOpen: (id: ToolId) => void;
  index: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(tool.id)}
      style={{ animationDelay: `${Math.min(index, 11) * 50}ms` }}
      className="rise lift group relative flex min-h-[170px] flex-col items-start rounded-xl border border-[#eaeaea] bg-white p-6 text-left"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-[#f1f0ed] text-[#111]">
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
      <span className="mt-3 text-[17px] font-semibold leading-tight tracking-[-0.01em] text-[#111]">
        {tool.label}
      </span>
      <span className="mt-1 text-[14px] leading-snug text-[#787774]">{tool.hint}</span>
      <span className="pointer-events-none absolute right-4 top-5 size-4 text-[#d8d7d2] transition-colors group-hover:text-[#111]">
        <Chevron />
      </span>
    </button>
  );
}

/**
 * The tools index. Nothing runs here — it exists so the tools are browsable
 * by group instead of a wall of tabs above the editor, and so you can search
 * by the job in your head ("vertical", "smaller", "music").
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
  let tileIndex = 0;

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
        <div className="relative max-w-xl">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-[#a3a099]"
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
            placeholder="Search tools — try “smaller”, “vertical”, “silent”"
            aria-label="Search tools"
            aria-describedby="toolCount"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-12 w-full rounded-md border border-[#e0dfdb] bg-white pl-10 pr-10 text-[15px] text-[#111] outline-none transition-colors placeholder:text-[#b4b2aa] focus:border-[#111]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-[#a3a099] transition-colors hover:bg-[#f4f3f0] hover:text-[#111]"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                className="size-3.5"
              >
                <path d="M18 6l-12 12" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </form>

      <p id="toolCount" className="mt-3 font-mono text-[12px] uppercase tracking-[0.06em] text-[#a3a099]">
        {count === TOOLS.length
          ? `${count} tools`
          : `${count} ${count === 1 ? "tool" : "tools"} match “${trimmed}”`}
      </p>

      {count === 0 ? (
        <div className="mt-3 max-w-xl rounded-xl border border-[#eaeaea] bg-white px-6 py-12 text-center">
          <p className="font-serif text-[22px] tracking-[-0.01em] text-[#111]">
            Nothing matches “{trimmed}”
          </p>
          <p className="mx-auto mt-2 max-w-[36ch] text-[14px] leading-snug text-[#787774]">
            Search what you want the file to become: smaller, shorter, vertical, silent.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="btn-primary mt-5 min-h-11 px-5 text-[15px]"
          >
            Show all {TOOLS.length} tools
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-8">
          {groups.map((g) => (
            <div key={g.id}>
              <h3 className="section-label">{g.title}</h3>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.tools.map((t) => (
                  <ToolTile key={t.id} tool={t} onOpen={onOpen} index={tileIndex++} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
