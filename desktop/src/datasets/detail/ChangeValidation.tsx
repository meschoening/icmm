/**
 * Dataset detail's changing mode (#53; LaptopDatasetDetail view `change`):
 * a cobalt bar across the page counts the validation points and the
 * changes, and holds Redraw (each protocol's split proposed afresh on this
 * computer's engine, gray until it lands), None, Cancel and Save, which
 * saves one new revision. While the change leaves no validation points, it
 * says what that costs (DS20; ADR-0006): runs rank by Train RMSE.
 */
import { useRef } from "react";
import { revisionRunsWords } from "../../runs/words";
import { useBlocker } from "../../ui/blocker";
import { grayProps } from "../../ui/gray";
import type { Working } from "../../ui/working";
import type { RunsDataset } from "../../wire/types.gen";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import { count } from "../format";
import { useRedraw } from "../making";

export function ChangeBar({
  name,
  runs,
  held,
  points,
  changes,
  saving,
  saveBlocked,
  message,
  redraw,
  none,
  cancel,
  save,
}: {
  name: string;
  /** The dataset's runs, which a new revision leaves on the data they were fit to. */
  runs?: RunsDataset;
  /** Validation points, as changed so far. */
  held: number;
  points: number;
  changes: number;
  saving: Working;
  /** Why Save waits, if it does. */
  saveBlocked: string | undefined;
  /** What the last Redraw or Save said, if it failed. */
  message: string | undefined;
  redraw: () => Promise<void>;
  none: () => void;
  cancel: () => void;
  save: () => void;
}) {
  const drawing = useRedraw(redraw);
  const redrawButton = useRef<HTMLButtonElement>(null);
  const b = useBlocker(saveBlocked);
  return (
    <div className="vbar" role="region" aria-label="Changing validation points">
      <div className="vbar-text">
        <span id="vbar-title" className="vbar-title" tabIndex={-1}>
          Changing validation points · <span className="mono">{held}</span> of{" "}
          <span className="mono">{points}</span> ·{" "}
          {changes === 0 ? "no changes yet" : count(changes, "change")}
        </span>
        <span className="vbar-body">
          Click a point to switch it.
          {held === 0 &&
            ` With no validation points, runs on ${name} rank by Train RMSE, below runs with validation points.`}{" "}
          Saving makes a new revision of {name}
          {revisionRunsWords(runs)}.
        </span>
        {message !== undefined && (
          <span className="err" role="alert">
            {message}
          </span>
        )}
      </div>
      <div className="vbar-acts">
        <BesideButton
          type="button"
          className="btn btn-sm"
          working={saving}
          ref={redrawButton}
          {...grayProps(drawing.gray)}
          onClick={() => void drawing.press()}
        >
          Redraw
        </BesideButton>
        {held > 0 && (
          <BesideButton
            type="button"
            className="btn btn-sm"
            working={saving}
            onClick={() => {
              none();
              // None goes as it's pressed: focus goes to Redraw beside it.
              redrawButton.current?.focus();
            }}
          >
            None
          </BesideButton>
        )}
        <BesideButton type="button" className="btn btn-sm" working={saving} onClick={cancel}>
          Cancel
        </BesideButton>
        <WorkingButton
          type="button"
          className="btn btn-sm btn-primary"
          working={saving}
          words="Saving…"
          {...b.props}
          {...grayProps(drawing.gray)}
          onClick={(e) => {
            b.props.onClick(e);
            if (saveBlocked === undefined && !drawing.gray) save();
          }}
        >
          Save
        </WorkingButton>
        {b.bubble}
      </div>
    </div>
  );
}
