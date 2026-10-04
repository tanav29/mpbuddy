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
    <section className="card card-tint rounded-[22px] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold tracking-tight text-neutral-800">Recent jobs</p>
        <button
          type="button"
          onClick={onClear}
          className="text-[12px] font-medium text-neutral-400 transition-colors hover:text-neutral-700"
        >
          Clear
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {jobs.slice(0, 5).map((j) => (
          <li
            key={j.id}
            className="flex items-center justify-between gap-2 rounded-[10px] bg-black/[0.04] px-2.5 py-2"
          >
            <div className="min-w-0 text-[12px] text-neutral-600">
              <p className="truncate font-medium text-neutral-800">{j.fileName}</p>
              <p className="tabular-nums">
                {toolById(j.tool).label} · {formatBytes(j.inputBytes)} →{" "}
                {formatBytes(j.outputBytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onReuse(j)}
              className="btn-apple-secondary shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold text-neutral-700"
            >
              Reuse
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}