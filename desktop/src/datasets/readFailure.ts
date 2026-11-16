/**
 * A workbook the Dataset wizard or the Protocol builder can't use, in the
 * wizard's words (LaptopDatasetWizard): what went wrong, what to do, and
 * what was found.
 */
import type { Workbook } from "../wire/types.gen";
import { count, size } from "./format";

/** A workbook that can't be used: the reader's problem, or no sheet with numbers. */
export interface ReadFailure {
  workbook: Workbook;
  noNumbers?: boolean;
}

/** What went wrong with a workbook, what to do, and what was found (LaptopDatasetWizard). */
export function failureWords(f: ReadFailure): { what: string; next: string; raw: string } {
  const w = f.workbook;
  if (f.noNumbers) {
    return {
      what: `${w.name} has no sheet with numbers in it.`,
      next: "Each protocol needs a sheet of its own: a header row, then a column for the swept voltage or time and one for the values you measured.",
      raw: `${count(w.sheets.length, "sheet")} · ${w.sheets.map((s) => s.name).join(", ")} · no column of numbers`,
    };
  }
  switch (w.problem) {
    case "not_xlsx":
      return {
        what: `${w.name} isn’t an .xlsx workbook.`,
        next: "ICMM reads Excel’s .xlsx format only. In Excel, choose File › Save As › Excel Workbook (.xlsx), then choose the new file.",
        raw: [w.name, w.detail].filter(Boolean).join(" · "),
      };
    case "password":
      return {
        what: `${w.name} is protected by a password.`,
        next: "Open it in Excel, save a copy without a password, then choose the copy.",
        raw: w.detail ?? "",
      };
    case "too_large":
      return {
        what: `${w.name} is ${size(w.bytes ?? 0)}, more than ICMM reads (50 MB).`,
        next: "Save a copy with only the summary sheets, without raw traces or charts, then choose the copy.",
        raw: `${((w.bytes ?? 0) / 1_000_000).toFixed(1)} MB · limit 50 MB`,
      };
    default:
      return {
        what: `ICMM couldn’t open ${w.name}.`,
        next: "It may be damaged, or protected by a password. Open it in Excel, save a copy without a password, then choose the copy.",
        raw: w.detail ?? "",
      };
  }
}
