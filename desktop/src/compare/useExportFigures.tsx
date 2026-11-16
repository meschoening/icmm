/**
 * Export figures… on Compare (#54, #336 decision 7c): the save dialog names
 * a folder, `herg-wt-compare` at first, and this computer's engine writes one
 * SVG per protocol into it (`write_figures`), each overlay with its legend
 * and RMSE table in light colors. It draws what the page shows, so it works
 * while not connected. A note under the head says where they went, with
 * Show in Finder; a write that fails says why, with Export again.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { webviewInfo } from "../ipc";
import { useBlocker } from "../ui/blocker";
import { grayProps, useSystemDialog } from "../ui/gray";
import { WorkingButton } from "../ui/WorkingButton";
import { useWorking } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { WireError } from "../wire/types.gen";
import { figuresOf } from "./figure";
import { ExportFailed, Exported, type Outcome } from "./Exported";
import type { ShownProtocol } from "./words";

/** What Export figures… draws: the overlays as the page shows them, and what their rows read. */
export interface Shown {
  protocols: readonly ShownProtocol[] | undefined;
  names: readonly string[];
  says: string;
}

/**
 * Export figures… for what the page `shown`; `folder` is the name the
 * dialog proposes, and `blocker` why it can't export yet, if it can't. The
 * figures are drawn from the page as it is once the dialog answers.
 */
export function useExportFigures(
  shown: Shown,
  folder: string,
  blocker: string | undefined,
): { button: ReactNode; outcome: ReactNode } {
  const latest = useRef({ shown, blocker });
  useEffect(() => {
    latest.current = { shown, blocker };
  });
  const b = useBlocker(blocker);
  const dialog = useSystemDialog();
  const working = useWorking();
  const [outcome, setOutcome] = useState<Outcome>();
  const os = useQuery({ queryKey: ["webview_info"], queryFn: webviewInfo, staleTime: Infinity })
    .data?.os;

  const press = async () => {
    if (shown.protocols === undefined || blocker !== undefined || working.busy()) return;
    const chosen = await dialog.open(() =>
      commands.choose_export_folder({ title: "Export figures", name: folder, folder: null }),
    );
    const path = chosen.path;
    if (path === null) return;
    // The page may have changed while the dialog was open: a fit drawn again, a start removed.
    const now = latest.current;
    if (now.shown.protocols === undefined || now.blocker !== undefined) return;
    setOutcome(undefined);
    const figures = figuresOf(now.shown.protocols, now.shown.names, now.shown.says);
    try {
      const written = await working.run(() => commands.write_figures({ folder: path, figures }));
      setOutcome(
        written.problem === null
          ? { kind: "written", path, count: figures.length }
          : { kind: "failed", path, problem: written.problem, detail: written.detail },
      );
    } catch (error) {
      setOutcome({ kind: "error", path, error: error as Partial<WireError> });
    }
  };

  const button = (
    <span className="cmp-blk">
      <WorkingButton
        type="button"
        className="btn"
        working={working}
        words="Exporting…"
        {...b.props}
        {...grayProps(dialog.gray)}
        onClick={(e) => {
          b.props.onClick(e);
          void press();
        }}
      >
        Export figures…
      </WorkingButton>
      {b.bubble}
    </span>
  );
  return {
    button,
    outcome:
      outcome === undefined ? null : outcome.kind === "written" ? (
        <Exported path={outcome.path} count={outcome.count} os={os} />
      ) : (
        <ExportFailed outcome={outcome} again={() => void press()} gray={dialog.gray} />
      ),
  };
}
