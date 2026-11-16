/** What an export's note says, and how it ended (#344, `useSave.tsx`). */
import type { ReactNode } from "react";
import type { WireError, WrittenFile } from "../wire/types.gen";

/** What the note says once it's written: a sentence, and what the file holds under it. */
export interface Said {
  lead: ReactNode;
  hint: ReactNode;
}

export type Outcome =
  | { kind: "written"; path: string; said: Said }
  | {
      kind: "failed";
      path: string;
      what: string;
      problem: WrittenFile["problem"];
      detail: string | null;
    }
  | { kind: "error"; path: string; what: string; error: Partial<WireError> };
