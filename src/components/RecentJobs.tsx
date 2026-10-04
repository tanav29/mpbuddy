import { formatBytes } from "../files";
import type { JobHistory } from "../history";
import { toolById } from "../tools";

/**
 * The last few jobs, so a setting that worked can be run again without
 * rebuilding it. Reuse reopens that tool with the same options loaded.
 */
export default function RecentJobs({
  jobs,
  onReuse,
  onClear,
}: {
  jobs: JobHistory[];
  onReuse: (job: JobHistory) => void;
  onClear: () => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <section className="panel p-6" aria-label="Recent jobs">
      <div className="flex items-center justify-between gap-2">
        <p className="section-label">Recent</p>
        <button
          type="button"
          onClick={onClear}
          className="text-[13px] font-medium text-[#a3a099] transition-colors hover:text-[#111]"
        >
          Clear
        </button>
      </div>
      <ul className="mt-1 divide-y divide-[#eaeaea]">
        {jobs.slice(0, 5).map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0 text-[13px] text-[#787774]">
              <p className="truncate font-medium text-[#111]">{j.fileName}</p>
              <p className="mt-0.5 font-mono text-[12px] tabular-nums">
                {toolById(j.tool).label} · {formatBytes(j.inputBytes)} →{" "}
                {formatBytes(j.outputBytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onReuse(j)}
              className="btn-secondary shrink-0 px-3 py-2 text-[13px] font-semibold"
            >
              Reuse
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
