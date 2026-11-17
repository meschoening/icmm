import { useReportFromHere } from "./fromHere";
import { useReport } from "./useReport";

/**
 * Report a problem… on a page that's neither a start, a topology nor a run: its panel, for under
 * the page head, which ⌘K opens; the report names the page by `name` (a dataset's or a config's
 * in mono).
 */
export function ReportFromHere({ name, mono = false }: { name: string; mono?: boolean }) {
  const report = useReport({
    key: `page ${name}`,
    look: "page",
    page: {
      kind: "page",
      row: mono ? <span className="mono">{name}</span> : name,
      read: async () => ({ kind: "page", name, job_log: null, run: null }),
    },
  });
  useReportFromHere(["about ", mono ? { mono: name } : name], report.start);
  return report.panel;
}
