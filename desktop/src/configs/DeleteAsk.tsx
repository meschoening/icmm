import { useEffect, useRef } from "react";
import { useRunsList } from "../runs/queries";
import { deleteConfigRunsWords } from "../runs/words";
import type { Working } from "../ui/working";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";

/** Delete…'s question, in place under the head (LaptopConfigs' `delete`). */
export function DeleteAsk({
  id,
  name,
  working,
  message,
  onKeep,
  onDelete,
}: {
  id: string;
  name: string;
  working: Working;
  message: string | undefined;
  onKeep: () => void;
  onDelete: () => void;
}) {
  const runs = useRunsList("", null, id).data?.pages.flatMap((p) => p.runs) ?? [];
  const title = useRef<HTMLSpanElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <div
      className="dd-ask"
      role="alertdialog"
      aria-labelledby="cfg-del-t"
      aria-describedby="cfg-del-b"
    >
      <div className="dd-ask-text">
        <span id="cfg-del-t" className="dd-ask-title" tabIndex={-1} ref={title}>
          Delete {name}?
        </span>
        <span id="cfg-del-b">It can’t be brought back.{deleteConfigRunsWords(runs)}</span>
        {message !== undefined && (
          <span className="dd-ask-message" role="alert">
            {message}
          </span>
        )}
      </div>
      <div className="dd-ask-actions">
        <BesideButton type="button" className="btn btn-sm" working={working} onClick={onKeep}>
          Keep it
        </BesideButton>
        <WorkingButton
          type="button"
          className="btn btn-sm btn-danger"
          working={working}
          words="Deleting…"
          onClick={onDelete}
        >
          Delete {name}
        </WorkingButton>
      </div>
    </div>
  );
}
