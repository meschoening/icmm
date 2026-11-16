/**
 * Import's button on Datasets, and the box or red box it opens (#147,
 * `Import.tsx`): the file is read on this computer, and nothing saves until
 * the box's Import <file> is pressed.
 */
import { useRef, useState } from "react";
import { grayProps, useSystemDialog } from "../ui/gray";
import { commands } from "../wire/api.gen";
import type { DatasetSummary, WireError } from "../wire/types.gen";
import { ImportBox, ImportFailed } from "./Import";
import { fileName, type Imported, type Read, type State } from "./importFile";

export interface ImportProps {
  /** The platform's name, as sentences write it. */
  platform: string;
  datasets: DatasetSummary[] | undefined;
  /** The import that saved, whose row the list tints and focuses. */
  onImported: (imported: Imported) => void;
}

/** Import's button, and the box or red box it opens. */
export function useImport({ platform, datasets, onImported }: ImportProps) {
  const dialog = useSystemDialog();
  const [reading, setReading] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const opener = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);

  const choose = async () => {
    if (reading) return;
    const chosen = await dialog.open(() =>
      commands.choose_dataset_file({ title: "Choose a dataset file", folder: null }),
    );
    const path = chosen.path;
    if (path === null) return;
    const mine = ++generation.current;
    setReading(true);
    try {
      const file = await commands.read_dataset_file({ path });
      if (mine !== generation.current) return;
      setState(
        file.problem === null && file.content !== null && file.scoring_digest !== null
          ? { kind: "read", read: { path, file: file as Read["file"] } }
          : { kind: "failed", failed: { path, file, name: file.file } },
      );
    } catch (error) {
      if (mine !== generation.current) return;
      setState({
        kind: "failed",
        failed: { path, file: null, error: error as Partial<WireError>, name: fileName(path) },
      });
    } finally {
      if (mine === generation.current) setReading(false);
    }
  };

  const close = () => {
    setState({ kind: "idle" });
    opener.current?.focus();
  };

  const button = (
    <button
      ref={opener}
      type="button"
      className="btn"
      {...grayProps(dialog.gray || reading)}
      onClick={() => void choose()}
    >
      Import
    </button>
  );
  const box =
    state.kind === "read" ? (
      <ImportBox
        key={state.read.path + state.read.file.scoring_digest}
        read={state.read}
        platform={platform}
        datasets={datasets}
        cancel={close}
        imported={(imported) => {
          setState({ kind: "idle" });
          onImported(imported);
        }}
      />
    ) : state.kind === "failed" ? (
      <ImportFailed
        failed={state.failed}
        close={close}
        again={() => void choose()}
        gray={dialog.gray || reading}
      />
    ) : null;
  return {
    button,
    box,
    open: state.kind !== "idle",
    /** Presses Import: ⌘K's Import dataset… (#412). */
    start: () => void choose(),
  };
}
