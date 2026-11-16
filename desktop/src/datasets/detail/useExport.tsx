/**
 * Export on Dataset detail (#147, LaptopDatasetDetail's `exporting`,
 * `exported` and `export-failed`): the revision the page shows, saved as one
 * `.zip` of its files byte for byte. The press is gray until the save
 * dialog opens; then the platform's agent reads the stored files
 * (`revision_files`) and this computer's engine writes them
 * (`write_dataset_file`), while the button says "Exporting…". A note under
 * the header says where it went, with Show in Finder, until the page is
 * left; a write that fails says why in the red box, with Export again.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useBlocker } from "../../ui/blocker";
import { grayProps, useSystemDialog } from "../../ui/gray";
import { GrowingButton } from "../../ui/WorkingButton";
import { useWorking } from "../../ui/working";
import { webviewInfo } from "../../ipc";
import { commands } from "../../wire/api.gen";
import type { WireError } from "../../wire/types.gen";
import { ExportFailed, Exported } from "./Export";
import type { Export, Outcome, Shown } from "./exportFile";

/** Export for the dataset `shown`; `blocker` says why it can't export, if it can't. */
export function useExport(shown: Shown | undefined, blocker: string | undefined): Export {
  const b = useBlocker(blocker);
  const blocked = blocker !== undefined || shown === undefined;
  const dialog = useSystemDialog();
  const working = useWorking();
  const [outcome, setOutcome] = useState<Outcome>();
  const os = useQuery({ queryKey: ["webview_info"], queryFn: webviewInfo, staleTime: Infinity })
    .data?.os;

  const press = async () => {
    if (shown === undefined || blocked || working.busy()) return;
    const chosen = await dialog.open(() =>
      commands.choose_export_file({
        title: `Export ${shown.name}`,
        name: `${shown.name}.zip`,
        folder: null,
        formats: ["zip"],
      }),
    );
    const path = chosen.path;
    if (path === null) return;
    setOutcome(undefined);
    try {
      const written = await working.run(async () => {
        const files = await commands.revision_files({ id: shown.id, revision: shown.revision });
        return commands.write_dataset_file({
          path,
          files: files.files,
          files_digest: files.files_digest,
        });
      });
      setOutcome(
        written.problem === null
          ? { kind: "written", path }
          : { kind: "failed", path, problem: written.problem, detail: written.detail },
      );
    } catch (error) {
      setOutcome({ kind: "error", path, error: error as Partial<WireError> });
    }
  };

  const button = (
    <>
      <GrowingButton
        type="button"
        className="btn"
        working={working}
        word="Export"
        ending="ing…"
        {...b.props}
        {...grayProps(dialog.gray)}
        onClick={(e) => {
          b.props.onClick(e);
          void press();
        }}
      />
      {b.bubble}
    </>
  );
  return {
    working,
    button,
    start: () => void press(),
    outcome:
      outcome === undefined || shown === undefined ? null : outcome.kind === "written" ? (
        <Exported shown={shown} path={outcome.path} os={os} />
      ) : (
        <ExportFailed outcome={outcome} again={() => void press()} gray={dialog.gray} />
      ),
  };
}
