import type { ToolId } from "./tools";

/** One finished job, kept so the same settings can be run again. */
export interface JobHistory {
  id: string;
  fileName: string;
  tool: ToolId;
  opts: Record<string, string>;
  inputBytes: number;
  outputBytes: number;
  at: number;
}

const KEY = "mpb-history";
const KEEP = 10;

export function loadHistory(): JobHistory[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as JobHistory[];
    return Array.isArray(parsed) ? parsed.slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function saveHistory(jobs: JobHistory[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs.slice(0, KEEP)));
  } catch {
    /* private mode */
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

export function newJobId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}