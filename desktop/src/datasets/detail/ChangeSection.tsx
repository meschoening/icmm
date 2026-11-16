/**
 * Dataset detail's last section, Change this dataset (#146;
 * LaptopDatasetDetail views page, delete and deleted): New protocol…, which
 * opens the Protocol builder on this dataset, and Delete dataset…, which
 * says it's for good (DS17) and asks in place, naming the dataset, then
 * commits its tombstone
 * (`delete_dataset`, ADR-0009) and goes to Datasets. Its runs keep the data
 * they were fit to; until there are runs, the lines don't mention them. The
 * question counts the configs that name it, which can't submit until they
 * name another, and the count lists them on hover or focus (#213, CF11).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useDatasetRuns } from "../../runs/queries";
import { deleteRunsWords } from "../../runs/words";
import { useBlocker } from "../../ui/blocker";
import { PAGE_HEADING_ATTR } from "../../ui/pageChangeFocus";
import { TipWord } from "../../ui/TipWord";
import { BesideButton, WorkingButton } from "../../ui/WorkingButton";
import { commands } from "../../wire/api.gen";
import { useDatasetWrite } from "./write";

/** The most protocols a dataset holds (ADR-0003). */
export const MAX_PROTOCOLS = 32;

export function ChangeSection({
  id,
  name,
  platform,
  protocols,
  configs,
  blocked,
  addBlocked,
  landing = false,
  onPending,
  onLeave,
}: {
  id: string;
  name: string;
  platform: string;
  /** How many protocols it has; at `MAX_PROTOCOLS`, New protocol… says so. */
  protocols: number;
  /** The names of the configs that name it, once they're read: Delete's question lists them. */
  configs: readonly string[] | undefined;
  /** Why neither action can be used, if they can't: deleted on another computer. */
  blocked?: string;
  /** Why New protocol… can't open, if only it can't: a revision ICMM can't read. */
  addBlocked?: string;
  /** The page lands on New protocol…, back from the builder it opened. */
  landing?: boolean;
  /** Whether the delete is under way, for the leave question. */
  onPending?: (pending: boolean) => void;
  /** Lets the page go, once the dataset is deleted. */
  onLeave: () => void;
}) {
  const navigate = useNavigate();
  const runs = useDatasetRuns(id);
  const write = useDatasetWrite(platform);
  const [asking, setAsking] = useState(false);
  const askTitle = useRef<HTMLSpanElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const full =
    protocols >= MAX_PROTOCOLS
      ? `${name} has ${MAX_PROTOCOLS} protocols, the most a dataset holds.`
      : undefined;
  const pending = write.working.pending;
  useEffect(() => onPending?.(pending), [pending, onPending]);
  const add = useBlocker(blocked ?? addBlocked ?? full);
  const del = useBlocker(blocked);

  const ask = () => {
    setAsking(true);
    setTimeout(() => askTitle.current?.focus());
  };
  const keep = () => {
    setAsking(false);
    write.setMessage(undefined);
    setTimeout(() => deleteButton.current?.focus());
  };
  const remove = async () => {
    const done = await write.run(
      { id },
      (key) => commands.delete_dataset({ request_key: key, id }),
      { words: { happened: `${name} deleted`, again: "Deleting" } },
    );
    // Deleted here or elsewhere first, it's gone either way.
    if (done.ok || done.code === "not_found") {
      onLeave();
      await navigate({ to: "/datasets" });
    }
  };

  return (
    <section aria-labelledby="change-h" className="dd-change">
      <h2 id="change-h" className="label">
        Change this dataset
      </h2>
      <div className="dd-change-row">
        <Link
          to="/datasets/$id/new-protocol"
          params={{ id }}
          className="btn btn-sm"
          id="new-protocol"
          {...(landing ? { [PAGE_HEADING_ATTR]: "" } : {})}
          {...add.props}
        >
          New protocol…
        </Link>
        {add.bubble}
        <span className="dd-change-says">Adds a protocol from a template or from scratch.</span>
      </div>
      {asking && blocked === undefined ? (
        <div
          className="dd-ask"
          role="alertdialog"
          aria-labelledby="delete-t"
          aria-describedby="delete-b"
        >
          <div className="dd-ask-text">
            <span id="delete-t" className="dd-ask-title" tabIndex={-1} ref={askTitle}>
              Delete {name}?
            </span>
            <span id="delete-b">
              It can’t be brought back.
              {deleteRunsWords(runs, name, runs?.runs_in_flight ?? 0)}
              {configs !== undefined && configs.length > 0 && (
                <>
                  {" "}
                  The{" "}
                  <TipWord tip={configs}>
                    <span className="n">{configs.length}</span>{" "}
                    {configs.length === 1 ? "config" : "configs"}
                  </TipWord>{" "}
                  {configs.length === 1 ? "that uses it can’t submit" : "that use it can’t submit"}{" "}
                  until you choose another dataset.
                </>
              )}
            </span>
            {write.message !== undefined && (
              <span className="dd-ask-message" role="alert">
                {write.message}
              </span>
            )}
          </div>
          <div className="dd-ask-actions">
            <BesideButton
              type="button"
              className="btn btn-sm"
              working={write.working}
              onClick={keep}
            >
              Keep it
            </BesideButton>
            <WorkingButton
              type="button"
              className="btn btn-sm btn-danger"
              working={write.working}
              words="Deleting…"
              onClick={() => void remove()}
            >
              Delete {name}
            </WorkingButton>
          </div>
        </div>
      ) : (
        <div className="dd-change-row">
          <button
            type="button"
            className="btn btn-sm"
            ref={deleteButton}
            {...del.props}
            onClick={(e) => {
              del.props.onClick(e);
              if (blocked === undefined) ask();
            }}
          >
            Delete dataset…
          </button>
          {del.bubble}
          <span className="dd-change-says">Deletes {name} for good.</span>
        </div>
      )}
    </section>
  );
}
