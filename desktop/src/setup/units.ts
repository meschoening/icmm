/**
 * The Job defaults' units as people write them: memory and time limits in
 * SLURM's own notation (`4G`, `24:00:00`), which the wire carries as whole
 * MB and minutes, and free space in decimal units, as the engine upload's MB.
 * Memory also takes the units people write (`8 GB`), shown back as SLURM's.
 */

const MEMORY = /^(\d+)(?:\s*([KMGT])B?)?$/i;
const SCALE: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

/**
 * `4G`, `500M` or `4096` (MB, SLURM's default unit), or `8 GB` and `8192 MB`
 * as people write them, in whole MB; `undefined` if it isn't one. A GB is
 * SLURM's G, 1024 MB.
 */
export function parseMemory(text: string): number | undefined {
  const m = text.trim().match(MEMORY);
  if (m === null) return undefined;
  const mb = Number(m[1]) * SCALE[(m[2] ?? "M").toUpperCase()];
  return Number.isInteger(mb) && mb > 0 ? mb : undefined;
}

/** Whole MB as SLURM writes it: `4G`, or `1536M` when it isn't whole GB. */
export function memory(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`;
}

/**
 * SLURM's time forms: `minutes`, `minutes:seconds`, `hours:minutes:seconds`,
 * `days-hours`, `days-hours:minutes` and `days-hours:minutes:seconds`.
 */
const TIME = /^(?:(\d+)-(\d+)(?::(\d+)(?::(\d+))?)?|(\d+)(?::(\d+)(?::(\d+))?)?)$/;

/**
 * A time limit in whole minutes; `"seconds"` when it leaves seconds over,
 * since the wire keeps minutes, and `"format"` when it isn't one at all.
 */
export function parseTime(text: string): { minutes: number } | "seconds" | "format" {
  const m = text.trim().match(TIME);
  if (m === null) return "format";
  const n = (i: number) => Number(m[i] ?? 0);
  let seconds: number;
  if (m[1] !== undefined) {
    seconds = ((n(1) * 24 + n(2)) * 60 + n(3)) * 60 + n(4);
  } else if (m[7] !== undefined) {
    seconds = (n(5) * 60 + n(6)) * 60 + n(7);
  } else {
    seconds = n(5) * 60 + n(6);
  }
  if (seconds === 0) return "format";
  return seconds % 60 === 0 ? { minutes: seconds / 60 } : "seconds";
}

const two = (n: number) => String(n).padStart(2, "0");

/** `24:00:00` up to a day, then `2-00:00:00`, as SLURM writes them. */
export function timeLimit(minutes: number): string {
  if (minutes <= 1440) return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}:00`;
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  return `${days}-${two(Math.floor(rest / 60))}:${two(rest % 60)}:00`;
}

/** A time limit in words: "24 h", "1 h 30 min", "7 days". */
export function upTo(minutes: number): string {
  if (minutes > 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const DECIMAL: [number, string][] = [
  [1e12, "TB"],
  [1e9, "GB"],
  [1e6, "MB"],
];

/** Free space: "4.9 GB", "212 GB", "120 MB", with one decimal below 10 of a unit. */
export function bytes(n: number): string {
  for (const [size, unit] of DECIMAL) {
    if (n >= size) {
      const v = n / size;
      return `${v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v)} ${unit}`;
    }
  }
  return `${Math.floor(n / 1e6)} MB`;
}
