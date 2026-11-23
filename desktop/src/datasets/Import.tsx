/**
 * Import on Datasets (#147, LaptopDatasets' `read` … `newer`): a `.zip`
 * that Export saved, read and checked on this computer
 * (`read_dataset_file`), then shown in a box above the list before
 * anything saves. The box holds the name, proposed from the file and
 * checked free as the wizard's is, beside what the file holds; a line says
 * when a revision on the platform already has the same scoring digest
 * (`find_scoring_digest`), without stopping the import. Import <file>
 * saves it through `save_dataset` as a new dataset, and the box closes
 * into a line naming it, its row tinted at the top of the list until the
 * page is left. A file that can't be imported says why in the red box.
 *
 * Not connected, the file is still read; the name check waits, and so does
 * the save, as the wizard's do.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState } from "react";
import { keyFor, unconfirmedWords } from "../requestKey";
import { agentKey, canAsk } from "../setup/queries";
import { getConnection, useConnection } from "../shell/connection";
import { grayProps } from "../ui/gray";
import { BesideButton, WorkingButton } from "../ui/WorkingButton";
import { useWorking } from "../ui/working";
import { commands } from "../wire/api.gen";
import type { DatasetSummary, Issue, WireError } from "../wire/types.gen";
import { templateWords } from "./detail/words";
import {
  NAME_RULE,
  NAME_TAKEN,
  baseName,
  failureWords,
  issueWords,
  type Failed,
  type Imported,
  type Read,
} from "./importFile";
import { allDatasets, named, useDatasetIssues } from "./queries";
import { unique } from "./sheets";

/** "Import herg-wt.zip to McKelvey HPC?": the name beside what the file holds. */
export function ImportBox({
  read,
  platform,
  datasets,
  cancel,
  imported,
}: {
  read: Read;
  platform: string;
  datasets: DatasetSummary[] | undefined;
  cancel: () => void;
  imported: (imported: Imported) => void;
}) {
  const id = useId();
  const c = useConnection();
  const queries = useQueryClient();
  const { file } = read;
  const base = baseName(file);
  const names = useMemo(
    () => new Set((datasets ?? []).map((d) => d.name.toLowerCase())),
    [datasets],
  );
  const [typed, setTyped] = useState<string | null>(null);
  // The proposal is checked once, when the list first comes, so it doesn't
  // move while the user reads it.
  const [proposed, setProposed] = useState<string | undefined>(
    datasets === undefined ? undefined : unique(base, 64, names),
  );
  if (proposed === undefined && datasets !== undefined) setProposed(unique(base, 64, names));
  const name = typed ?? proposed ?? base;
  const taken = datasets !== undefined && named(datasets, name) !== undefined;
  const content = useMemo(() => ({ ...file.content, name }), [file.content, name]);
  const checked = useDatasetIssues(content);
  const ruleIssue = checked.issues?.find(
    (i) => i.path.length === 1 && i.path[0] === "name" && i.message !== NAME_TAKEN,
  );
  const free = datasets === undefined ? null : unique(name, 64, names);

  const same = useQuery({
    queryKey: agentKey(
      c.status === "none" ? "" : c.platformId,
      "datasets",
      "digest",
      file.scoring_digest,
    ),
    queryFn: () => commands.find_scoring_digest({ scoring_digest: file.scoring_digest }),
    enabled: canAsk(c),
  });
  const twin = same.data?.datasets[0];

  const saving = useWorking();
  const request = useRef<{ key: string; body: string } | null>(null);
  const [message, setMessage] = useState<string>();
  const save = async () => {
    if (saving.busy()) return;
    setMessage(undefined);
    request.current = keyFor(request.current, content);
    const key = request.current.key;
    try {
      const saved = await saving.run(() =>
        commands.save_dataset({ request_key: key, id: null, expected_revision: null, content }),
      );
      void queries.invalidateQueries({ queryKey: agentKey(platformId(), "datasets") });
      imported({ id: saved.id, name, file: file.file });
    } catch (error) {
      const e = error as Partial<WireError> & { data?: unknown };
      const code = e.code as string | undefined;
      if (code === "invalid") {
        const found = (e.data as { issues?: Issue[] } | undefined)?.issues ?? [];
        const nameIssue = found.find((i) => i.path.length === 1 && i.path[0] === "name");
        if (nameIssue !== undefined) {
          // Another computer may have taken the name meanwhile: read the list
          // again, and propose a free one if so.
          const fresh = await allDatasets().catch(() => datasets ?? []);
          queries.setQueryData(agentKey(platformId(), "datasets", "all"), fresh);
          // Taken, the list now says so beside the name, with a free one to use.
          if (named(fresh, name) === undefined) setMessage(`Name: ${nameIssue.message}`);
          return;
        }
        setMessage(found.map((i) => issueWords(i, file.protocol_names)).join(" "));
        return;
      }
      if (code === "not_connected" || code === "timeout") {
        // The retry reuses its key, so it can't make a second dataset (#168).
        const offline = getConnection().status === "connected" ? undefined : platform;
        const words = {
          happened: `${name} imported`,
          again: "Importing",
          safe: "it won’t make a second copy",
        };
        setMessage(unconfirmedWords(words, offline));
        return;
      }
      setMessage(e.message ?? "Couldn’t save. Try again.");
    }
  };

  const all = file.content.protocols.flatMap((p) => p.points);
  const counts = {
    points: all.length,
    interpolated: all.filter((p) => p.interpolated).length,
    validation: all.filter((p) => p.validation).length,
  };
  const waiting = saving.pending && c.status !== "connected";
  const bad = taken || ruleIssue !== undefined;
  const nameCheck =
    datasets !== undefined
      ? "ready"
      : c.status === "connected" || c.status === "reconnecting"
        ? "checking"
        : "offline";

  return (
    <section className="imp" aria-labelledby={`${id}-t`}>
      <div className="imp-h">
        <div className="imp-say">
          <h2 id={`${id}-t`} className="imp-t">
            Import <span className="mono">{file.file}</span> to {platform}?
          </h2>
          <span className="imp-b">
            It becomes a new dataset, with the file’s protocols, validation points, interpolation
            and weights. Runs stay on the platform they ran on.
          </span>
        </div>
        <div className="imp-acts">
          <BesideButton type="button" className="btn btn-sm" working={saving} onClick={cancel}>
            Cancel
          </BesideButton>
          <WorkingButton
            type="button"
            className="btn btn-sm btn-primary"
            working={saving}
            words="Importing…"
            aria-disabled={bad || undefined}
            onClick={() => {
              if (!bad) void save();
            }}
          >
            Import {file.file}
          </WorkingButton>
        </div>
      </div>
      <div className="imp-g">
        <div className="imp-n">
          <label htmlFor={`${id}-name`} className="flabel">
            Name
          </label>
          <input
            id={`${id}-name`}
            className={`input mono${bad ? " bad" : ""}`}
            value={name}
            spellCheck={false}
            autoComplete="off"
            disabled={saving.shown}
            aria-invalid={bad || undefined}
            // A bad name's error takes the hint's place (#561 D9).
            aria-describedby={bad ? `${id}-name-e` : `${id}-name-h`}
            onChange={(e) => setTyped(e.target.value)}
          />
          <NameCheck state={nameCheck} bad={bad} name={name} platform={platform} />
          {taken && free !== null && (
            <div className="taken">
              <p id={`${id}-name-e`} className="err">
                {platform} already has a dataset named <span className="mono">{name}</span>. Names
                are unique ignoring case.
              </p>
              <div className="taken-free">
                <span>
                  <span className="mono">{free}</span> is free.
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setTyped(free)}>
                  Use {free}
                </button>
              </div>
            </div>
          )}
          {ruleIssue !== undefined && !taken && (
            <p id={`${id}-name-e`} className="err" role="alert">
              {ruleIssue.message}
            </p>
          )}
          {!bad && (
            <span id={`${id}-name-h`} className="hint">
              {typed !== null
                ? NAME_RULE
                : name !== base
                  ? `From the file; ${base} is taken, so ICMM added ${name.slice(base.length)}. ${NAME_RULE}`
                  : `From the file. ${NAME_RULE}`}
            </span>
          )}
          {twin !== undefined && (
            <p className="same">
              <InfoIcon />
              <span>
                <span className="mono ink">{twin.name}</span> on {platform} already holds the same
                data: the same protocols, points, validation points and weights. Import only if you
                want a second copy.
              </span>
            </p>
          )}
        </div>
        <div className="imp-p">
          <span className="flabel">What it holds</span>
          <span className="imp-facts">
            <span className="n">{file.content.protocols.length}</span>{" "}
            {file.content.protocols.length === 1 ? "protocol" : "protocols"} ·{" "}
            <span className="n">{counts.points}</span> {counts.points === 1 ? "point" : "points"}
            {counts.interpolated > 0 && (
              <>
                , <span className="n">{counts.interpolated}</span> interpolated
              </>
            )}{" "}
            ·{" "}
            {counts.validation > 0 ? (
              <>
                <span className="n">{counts.validation}</span> validation
              </>
            ) : (
              "no validation"
            )}
          </span>
          <dl className="ds-plist imp-plist" aria-label={`Protocols in ${file.file}`}>
            {file.content.protocols.map((p, i) => (
              <div key={p.name} className="ds-plist-row">
                <dt>{p.name}</dt>
                <dd>
                  {templateWords(file.templates[i], p.steps.length)} ·{" "}
                  <span className="n">{p.points.length}</span>{" "}
                  {p.points.length === 1 ? "point" : "points"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {(waiting || message !== undefined) && (
        <p className={waiting ? "imp-wait" : "err"} role={waiting ? "status" : "alert"}>
          {waiting && <span className="g g-queued" aria-hidden="true" />}
          {waiting ? `Waiting for ${platform} to reconnect, then this imports.` : message}
        </p>
      )}
    </section>
  );
}

/** Under the name: free, checking, or checked once connected. */
function NameCheck({
  state,
  bad,
  name,
  platform,
}: {
  state: "offline" | "checking" | "ready";
  bad: boolean;
  name: string;
  platform: string;
}) {
  if (state === "ready" && bad) return null;
  return (
    <span className="ok" role="status">
      {state === "offline" ? (
        <>
          <span className="g g-off" aria-hidden="true" />
          Checked once {platform} is connected
        </>
      ) : state === "checking" ? (
        <>
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Checking {platform}…
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1.5 5.2 4 7.5l4.5-5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span>
            <span className="mono ink">{name}</span> is free on {platform}.
          </span>
        </>
      )}
    </span>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 6.2v3.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7" cy="4.3" r=".8" fill="currentColor" />
    </svg>
  );
}

export function ImportFailed({
  failed,
  close,
  again,
  gray,
}: {
  failed: Failed;
  close: () => void;
  again: () => void;
  gray: boolean;
}) {
  const w = failureWords(failed);
  return (
    <div className="ebox" role="alert">
      <div className="fsay">
        <p className="fwhat">{w.what}</p>
        {w.items.length > 0 && (
          <ul className="flist">
            {w.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        )}
        <p className="fnext">{w.next}</p>
        <span className="term fraw">{w.raw}</span>
      </div>
      <div className="ebox-acts">
        <button type="button" className="btn btn-sm" onClick={close}>
          Close
        </button>
        <button type="button" className="btn btn-sm" {...grayProps(gray)} onClick={again}>
          Choose another…
        </button>
      </div>
    </div>
  );
}

function platformId(): string {
  const c = getConnection();
  return c.status === "none" ? "" : c.platformId;
}
