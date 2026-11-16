/**
 * One export where the user chooses (#344, #336 decision 7): the save
 * dialog, then this computer's engine writes the file, while the button that
 * asked says what it's doing. A note says where it went, with Show in
 * Finder, until the page is left or another export replaces it; a write that
 * fails says why in the red box, with Export again. A start's parameters, fit
 * and figures, the leaderboard's CSV and a run's config each come through
 * here, as Dataset detail's Export and Compare's figures do on their own.
 */
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { webviewInfo } from "../ipc";
import { useSystemDialog } from "../ui/gray";
import { useWorking, type Working } from "../ui/working";
import type { Chosen, WireError, WrittenFile } from "../wire/types.gen";
import { ExportFailed, Exported } from "./Exported";
import type { Outcome, Said } from "./outcome";

/** One export: where to ask, what to write there, and what to say of it. */
export interface Save<W extends WrittenFile> {
  /** The save dialog: `choose_export_file`, or `choose_export_folder` for a folder of figures. */
  ask: () => Promise<Chosen>;
  /** The write to the path it answered; `undefined` when the page no longer has it to write. */
  write: (path: string) => Promise<W> | undefined;
  said: (path: string, written: W) => Said;
  /** What it saves, in "ICMM couldn’t save the parameters to …": "the parameters". */
  what: string;
}

export interface Saving {
  /** Runs an export; nothing while one is writing. */
  save: <W extends WrittenFile>(s: Save<W>) => Promise<void>;
  working: Working;
  /** Whether the dialog is opening: the buttons that ask are gray until it shows. */
  gray: boolean;
  /** The note or the red box; `null` before an export. */
  outcome: ReactNode;
}

export function useSave(): Saving {
  const dialog = useSystemDialog();
  const working = useWorking();
  const [outcome, setOutcome] = useState<Outcome>();
  const last = useRef<Save<WrittenFile>>(undefined);
  const os = useQuery({ queryKey: ["webview_info"], queryFn: webviewInfo, staleTime: Infinity })
    .data?.os;

  const save = async <W extends WrittenFile>(s: Save<W>) => {
    if (working.busy()) return;
    const chosen = await dialog.open(s.ask);
    const path = chosen.path;
    if (path === null) return;
    const writing = s.write(path);
    if (writing === undefined) return;
    // Export again repeats this one, not one canceled since.
    last.current = s as unknown as Save<WrittenFile>;
    setOutcome(undefined);
    try {
      const written = await working.run(() => writing);
      setOutcome(
        written.problem === null
          ? { kind: "written", path, said: s.said(path, written) }
          : {
              kind: "failed",
              path,
              what: s.what,
              problem: written.problem,
              detail: written.detail,
            },
      );
    } catch (error) {
      setOutcome({ kind: "error", path, what: s.what, error: error as Partial<WireError> });
    }
  };

  return {
    save,
    working,
    gray: dialog.gray,
    outcome:
      outcome === undefined ? null : outcome.kind === "written" ? (
        <Exported path={outcome.path} said={outcome.said} os={os} />
      ) : (
        <ExportFailed
          outcome={outcome}
          gray={dialog.gray}
          again={() => last.current !== undefined && void save(last.current)}
        />
      ),
  };
}
