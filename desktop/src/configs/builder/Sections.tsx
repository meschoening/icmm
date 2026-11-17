/**
 * The Config builder's three sections (LaptopConfigBuilder): 01 Name &
 * data, 02 Topology and 03 Optimization with its one Advanced bar. Each
 * field shows its checks under it: a red line for one that stops a save, a
 * gray ⓘ line for a note that doesn't (#180), and, once another computer
 * saved, what it was (#164).
 */
import { useId, useRef, useState } from "react";
import { MarkWords } from "../../datasets/builder/Field";
import { modifiedWords } from "../../datasets/detail/words";
import { count } from "../../datasets/format";
import { Chevron } from "../../settings/SshFormCard";
import { KeptHint } from "../../ui/KeptHint";
import { PAGE_HEADING_ATTR } from "../../ui/pageChangeFocus";
import type { FieldMark } from "../../setup/form";
import type { DatasetSummary, SpecificId, TopologyCounts } from "../../wire/types.gen";
import { TopologyDrawing } from "../../topology/Drawing";
import { FindTopology } from "../../topology/FindTopology";
import { drawingBox, SPECIFIC_IDS } from "../../topology/size";
import { drawingCaption, drawingSentence } from "../../topology/words";
import { VoltageLine } from "../VoltageLine";
import { exampleIds, generationsOf, generationWords, idWords, voltageWords, whole } from "../words";
import { MOST_DRAWN, type IdDrawings } from "./drawings";
import {
  numberOf,
  wholeOf,
  type ConfigDraft,
  type Field,
  type FieldIssue,
  type Numeric,
  type Which,
} from "./draft";

/** Sample's words after its field: drawn from the search seed when one is set (it keeps the room of both). */
const SAMPLE_HINTS = {
  seeded: "topologies, drawn from the search seed: the same seed draws the same ones",
  random: "topologies, drawn at random each time you submit",
};

/** What every section is given: the fields, their checks and marks, and how to change them. */
export interface FieldsProps {
  draft: ConfigDraft;
  set: (change: Partial<ConfigDraft>) => void;
  /** A number field is left: it shows as a saved one does (CF18). */
  done: (field: Numeric) => void;
  /** Each field's checks and notes, in the order they show. */
  issues: Map<Field, FieldIssue[]>;
  /** What each changed field was, once another computer saved. */
  marks: Partial<Record<Field, FieldMark>>;
  /** The fields you changed, outlined (LaptopConfigBuilder's `edited`). */
  edited: Set<Field>;
  /** A save waits for the connection: nothing changes until it's done. */
  locked: boolean;
}

/** The ⓘ of a note that doesn't stop a save (`.fnote`). */
export function NoteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 5.6v3.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="3.8" r=".85" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.3 4.8 9 10 3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Topology ids, and ranges of them ("T0–T7511"), then numbers, in an engine's sentence. */
const IDS_AND_NUMBERS = /(T\d+(?:\.\d+)?(?:–T\d+)?)|(\d[\d,]*(?:\.\d+)?)/g;

/** A check's sentence as the boards set it: its ids in mono, kept whole, and its numbers in mono. */
export function Sentence({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(IDS_AND_NUMBERS)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(
      <span key={m.index} className={m[1] !== undefined ? "mono nw" : "n"}>
        {m[0]}
      </span>,
    );
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A field's checks, then its notes, under it; `id` is what its `aria-describedby` names. */
function Issues({ id, issues }: { id: string; issues: FieldIssue[] | undefined }) {
  if (issues === undefined || issues.length === 0) return null;
  const errors = issues.filter((i) => i.severity === "error");
  const notes = issues.filter((i) => i.severity === "note");
  return (
    <span id={id} className="cb-issues">
      {errors.map((i, n) => (
        <span key={`e${n}`} className="err">
          <Sentence text={i.message} />
        </span>
      ))}
      {notes.map((i, n) => (
        <span key={`n${n}`} className="fnote">
          <NoteIcon />
          <span>
            <Sentence text={i.message} />
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * A number field's blur handler: it shows as a saved one does once it's
 * left (CF18), not when its window loses focus, which keeps it focused.
 */
const leaving = (p: FieldsProps, field: Numeric) => (e: React.FocusEvent<HTMLInputElement>) => {
  if (e.currentTarget !== document.activeElement) p.done(field);
};

const hasError = (issues: FieldIssue[] | undefined) =>
  issues?.some((i) => i.severity === "error") ?? false;

/** A field's input classes: outlined red with a check, ink once you changed it. */
function inputClass(base: string, bad: boolean, edited: boolean) {
  return `${base}${bad ? " bad" : edited ? " edited" : ""}`;
}

/** What an input's `aria-describedby` names: its checks, its mark and its hint, as there. */
const described = (...ids: (string | false | undefined)[]) =>
  ids.filter((x): x is string => typeof x === "string").join(" ") || undefined;

function Section({
  n,
  title,
  hint,
  grid = "",
  children,
}: {
  n: string;
  title: string;
  hint: string;
  /** A class its grid adds to `.cb-grid`'s three columns. */
  grid?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="cb-section">
      <span className="mono cb-n" aria-hidden="true">
        {n}
      </span>
      <div className="cb-section-body">
        <div className="cb-section-head">
          <h2 id={id}>{title}</h2>
          <p className="hint">{hint}</p>
        </div>
        <div className={`cb-grid${grid === "" ? "" : ` ${grid}`}`}>{children}</div>
      </div>
    </section>
  );
}

export interface NameDataProps extends FieldsProps {
  platform: string;
  /** The free name the field holds, once it can say so. */
  free: boolean;
  /** Another config's name, ignoring case, when the field holds it. */
  taken: string | undefined;
  /** The platform's datasets, newest first; `undefined` while they're read. */
  datasets: DatasetSummary[] | undefined;
  /** The chosen dataset by name, when it was deleted. */
  gone: string | undefined;
  /** Duplicate's copy opens with its name selected; this marks the field the page lands on. */
  nameRef: React.Ref<HTMLInputElement>;
  landing: boolean;
  now: number;
}

/** 01 Name & data: the Name with its live check, and the Dataset. */
export function NameData({ nameRef, ...p }: NameDataProps) {
  const id = useId();
  const nameIssues = p.issues.get("name");
  const nameBad = hasError(nameIssues) || p.taken !== undefined;
  const chosen = p.datasets?.find((d) => d.id === p.draft.dataset);
  const dsIssues = p.issues.get("dataset");
  return (
    <Section
      n="01"
      title="Name & data"
      hint="What this config is called, and which measurements it fits."
      grid="cb-name-data"
    >
      <div className="cb-field cb-span2">
        <div className="cb-label-row">
          <label className="flabel" htmlFor={`${id}-name`}>
            Name
          </label>
          <span className="mono cb-len" aria-hidden="true">
            {p.draft.name.length} / 64
          </span>
        </div>
        <input
          id={`${id}-name`}
          ref={nameRef}
          className={inputClass("input mono", nameBad, p.edited.has("name"))}
          value={p.draft.name}
          placeholder="e.g. herg-wt-11state"
          spellCheck={false}
          autoComplete="off"
          disabled={p.locked}
          aria-invalid={nameBad || undefined}
          aria-describedby={described(
            p.taken !== undefined && `${id}-taken`,
            nameIssues !== undefined && `${id}-name-i`,
            p.marks.name !== undefined && `${id}-name-was`,
            `${id}-name-h`,
          )}
          {...(p.landing ? { [PAGE_HEADING_ATTR]: "" } : {})}
          onChange={(e) => p.set({ name: e.target.value })}
        />
        {p.free && (
          <span className="ok" role="status">
            <CheckIcon />
            <span>
              <span className="mono ink">{p.draft.name}</span> is free.
            </span>
          </span>
        )}
        {p.taken !== undefined && (
          <p id={`${id}-taken`} className="err" role="alert">
            {p.platform} already has a config named <span className="mono">{p.taken}</span>. Names
            are unique ignoring case.
          </p>
        )}
        <Issues id={`${id}-name-i`} issues={nameIssues} />
        <MarkWords id={`${id}-name`} mark={p.marks.name} />
        <p id={`${id}-name-h`} className="hint">
          Letters, digits, <span className="mono">.</span>, <span className="mono">-</span> and{" "}
          <span className="mono">_</span>. Runs from this config show its name.
        </p>
      </div>
      <div className="cb-field">
        <label className="flabel" htmlFor={`${id}-ds`}>
          Dataset
        </label>
        <select
          id={`${id}-ds`}
          className={inputClass(
            // "Choose a dataset" in the UI's sans, gray, as a placeholder (CF13).
            p.draft.dataset === "" ? "input placeholder" : "input mono",
            p.gone !== undefined || hasError(dsIssues),
            p.edited.has("dataset"),
          )}
          value={p.draft.dataset}
          disabled={p.locked}
          aria-invalid={p.gone !== undefined || hasError(dsIssues) || undefined}
          aria-describedby={described(
            (p.gone !== undefined || chosen !== undefined) && `${id}-ds-h`,
            dsIssues !== undefined && `${id}-ds-i`,
            p.marks.dataset !== undefined && `${id}-ds-was`,
          )}
          onChange={(e) => p.set({ dataset: e.target.value })}
        >
          {p.gone !== undefined && <option value={p.draft.dataset}>{p.gone} (deleted)</option>}
          {p.draft.dataset === "" && (
            <option value="" disabled>
              {p.datasets?.length === 0 ? "No datasets yet" : "Choose a dataset"}
            </option>
          )}
          {p.datasets?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {p.gone !== undefined ? (
          <p id={`${id}-ds-h`} className="err" role="alert">
            <span className="mono">{p.gone}</span> was deleted. Choose another dataset.
          </p>
        ) : chosen !== undefined ? (
          <p id={`${id}-ds-h`} className="hint">
            {count(chosen.protocols.length, "protocol")} · edited{" "}
            {modifiedWords(chosen.modified_at, p.now)}
          </p>
        ) : null}
        <Issues id={`${id}-ds-i`} issues={dsIssues} />
        <MarkWords id={`${id}-ds`} mark={p.marks.dataset} />
      </div>
    </Section>
  );
}

export interface TopologyProps extends FieldsProps {
  /** The engine's counts for the number of states as typed; `null` while it has none. */
  counts: TopologyCounts | null;
  /**
   * What Specific IDs will fit, as a save keeps them: each id, and how many
   * topologies it fits; `null` until they can be counted.
   */
  fits: { ids: SpecificId[]; perId: number[]; topologies: number } | null;
  /** Notes about Specific IDs that their field no longer shows, since it shows them as saved. */
  heldNotes: FieldIssue[];
  /** Specific IDs lose focus: the field shows them as a save keeps them. */
  onIdsDone: () => void;
  /** Each id fit, drawn (#212); `null` until their state graphs are read. */
  drawn: IdDrawings | null;
  drawingsLimited: boolean;
  /** Find custom topology's Add (#222): the ids, and the number of states when it changes. */
  onFound: (change: { ids: string; states?: string }) => void;
}

/** One fewer, or one more, state: from blank, either is 3. */
function stepStates(text: string, by: 1 | -1): string {
  const n = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  if (n === null) return "3";
  return String(Math.min(16, Math.max(3, n + by)));
}

const WHICH: { kind: Which; label: string }[] = [
  { kind: "sample", label: "Random sample" },
  { kind: "ids", label: "Specific IDs" },
  { kind: "all", label: "All" },
];

/** "10 topologies: T1991 at each of its 8 open states, T1408.0 and T5022.3." */
function FitsWords({ fits }: { fits: NonNullable<TopologyProps["fits"]> }) {
  const bare = fits.ids.filter((id) => id.open_state === null);
  const one = fits.ids.filter((id) => id.open_state !== null);
  // Bare ids first, each at its open states, as the board says them.
  const parts: React.ReactNode[] = [];
  if (bare.length > 0) {
    const names = bare.map((id) => (
      <span key={idWords(id)} className="mono nw">
        {idWords(id)}
      </span>
    ));
    const at =
      bare.length === 1
        ? (() => {
            const n = fits.perId[fits.ids.indexOf(bare[0])];
            return n === 1 ? " at its one open state" : ` at each of its ${n} open states`;
          })()
        : " at each of their open states";
    parts.push(
      <span key="bare">
        {joinNodes(names)}
        {at}
      </span>,
    );
  }
  for (const id of one) {
    parts.push(
      <span key={idWords(id)} className="mono nw">
        {idWords(id)}
      </span>,
    );
  }
  return (
    <>
      <span className="n">{whole(fits.topologies)}</span>{" "}
      {fits.topologies === 1 ? "topology" : "topologies"}: {joinNodes(parts, ", ")}.
    </>
  );
}

/**
 * Specific IDs' drawings (#212), in the order written: each in a box the size
 * of the largest drawing, as many a row as fit, a smaller one centered.
 */
function Drawings({ drawn: { numStates, drawings } }: { drawn: IdDrawings }) {
  const boxes = drawings.map(({ spots }) => drawingBox(spots, SPECIFIC_IDS));
  // The largest drawing and 8 px around it.
  const width = Math.max(...boxes.map((b) => b.width)) + 16;
  const height = Math.max(...boxes.map((b) => b.height)) + 16;
  return (
    <div
      className="tiles"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${width}px, 100%), 1fr))` }}
    >
      {drawings.map(({ id, graph, spots }) => (
        <figure key={idWords(id)} className="tile">
          <div className="tbox" style={{ height }}>
            <TopologyDrawing
              graph={graph}
              spots={spots}
              open={id.open_state}
              label={drawingSentence(id, numStates, graph)}
            />
          </div>
          <figcaption className="tcap">
            <span className="mono">{idWords(id)}</span> · {drawingCaption(id, graph)}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** `a`, `a and b`, `a, b and c` of nodes; `last` before the last of three or more, as ", ". */
function joinNodes(nodes: React.ReactNode[], comma = ", "): React.ReactNode[] {
  return nodes.flatMap((node, i) => [
    i === 0 ? null : i === nodes.length - 1 ? " and " : comma,
    <span key={i}>{node}</span>,
  ]);
}

/** 02 Topology: the number of states and its count, and which of its topologies to fit. */
export function Topology(p: TopologyProps) {
  const id = useId();
  const { draft } = p;
  // A range in its check, "3 to 16", stays on one line (CF10).
  const states = p.issues
    .get("states")
    ?.map((i) => ({ ...i, message: i.message.replace(/(\d+) to (\d+)/, "$1\u00a0to\u00a0$2") }));
  const statesBad = hasError(states);
  const n = /^\d+$/.test(draft.states.trim()) ? Number(draft.states.trim()) : null;
  // Specific IDs' examples, from the number of states' own list (CF10).
  const example = exampleIds(n);
  // A uint32 search seed draws the sample (CF07), even while checks wait for the connection.
  const seed = wholeOf(draft.seed);
  const seeded = typeof seed === "number" && seed >= 0 && seed <= 2 ** 32 - 1;
  const sample = p.issues.get("sample");
  const ids = p.issues.get("ids");
  const which = p.issues.get("which");
  const idErrors = ids?.filter((i) => i.severity === "error") ?? [];
  const [finding, setFinding] = useState(false);
  const finder = useRef<HTMLButtonElement>(null);
  const idNotes = [...(ids?.filter((i) => i.severity === "note") ?? []), ...p.heldNotes];
  return (
    <Section n="02" title="Topology" hint="How many kinetic states, and which topologies to fit.">
      <div className="cb-field">
        <label className="flabel" htmlFor={`${id}-states`}>
          Number of states
        </label>
        <div className="cb-states">
          <button
            type="button"
            className="btn-icon"
            aria-label="One fewer state"
            aria-disabled={n !== null && n <= 3 ? true : undefined}
            disabled={p.locked}
            onClick={() => {
              if (n === null || n > 3) p.set({ states: stepStates(draft.states, -1) });
            }}
          >
            <MinusIcon />
          </button>
          <input
            id={`${id}-states`}
            className={inputClass("input mono cb-states-input", statesBad, p.edited.has("states"))}
            role="spinbutton"
            inputMode="numeric"
            value={draft.states}
            spellCheck={false}
            autoComplete="off"
            disabled={p.locked}
            aria-valuemin={3}
            aria-valuemax={16}
            aria-valuenow={n !== null && n >= 3 && n <= 16 ? n : undefined}
            aria-invalid={statesBad || undefined}
            aria-describedby={described(
              (p.counts !== null || !statesBad) && `${id}-states-h`,
              states !== undefined && `${id}-states-i`,
              p.marks.states !== undefined && `${id}-states-was`,
            )}
            onChange={(e) => p.set({ states: e.target.value })}
            onBlur={leaving(p, "states")}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                p.set({ states: stepStates(draft.states, e.key === "ArrowUp" ? 1 : -1) });
              }
            }}
          />
          <button
            type="button"
            className="btn-icon"
            aria-label="One more state"
            aria-disabled={n !== null && n >= 16 ? true : undefined}
            disabled={p.locked}
            onClick={() => {
              if (n === null || n < 16) p.set({ states: stepStates(draft.states, 1) });
            }}
          >
            <PlusIcon />
          </button>
        </div>
        {p.counts === null ? (
          // A check says the range in its place.
          !statesBad && (
            <p id={`${id}-states-h`} className="hint">
              From 3 to 16.
            </p>
          )
        ) : (
          <div id={`${id}-states-h`} role="status" className="cb-count">
            <p className="hint">
              <span className="n">{whole(p.counts.state_graphs)}</span>
              {"\u00a0"}graphs with <span className="n">{n}</span>
              {"\u00a0"}states,
            </p>
            <p className="hint">
              <span className="n">{whole(p.counts.topologies)}</span>
              {"\u00a0"}topologies total
            </p>
          </div>
        )}
        <Issues id={`${id}-states-i`} issues={states} />
        <MarkWords id={`${id}-states`} mark={p.marks.states} />
      </div>
      <fieldset className="cb-which cb-span2" disabled={p.locked}>
        <legend className="flabel">Which topologies</legend>
        <div className="seg" role="radiogroup" aria-label="Which topologies">
          {WHICH.map((w) => (
            <label key={w.kind} className={draft.which === w.kind ? "on" : undefined}>
              <input
                type="radio"
                name={`${id}-which`}
                checked={draft.which === w.kind}
                onChange={() => p.set({ which: w.kind })}
              />
              {w.label}
            </label>
          ))}
        </div>
        <MarkWords id={`${id}-which`} mark={p.marks.which} />
        {draft.which === "sample" && (
          <div className="cb-sub cb-held">
            <div className="cb-sample">
              <label className="flabel cb-sublabel" htmlFor={`${id}-sample`}>
                Sample
              </label>
              <input
                id={`${id}-sample`}
                className={inputClass(
                  "input mono cb-sample-input",
                  hasError(sample),
                  p.edited.has("sample"),
                )}
                value={draft.sample}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={hasError(sample) || undefined}
                aria-describedby={described(
                  `${id}-sample-h`,
                  sample !== undefined && `${id}-sample-i`,
                  p.marks.sample !== undefined && `${id}-sample-was`,
                )}
                onChange={(e) => p.set({ sample: e.target.value })}
                onBlur={leaving(p, "sample")}
              />
              <KeptHint
                id={`${id}-sample-h`}
                says={seeded ? SAMPLE_HINTS.seeded : SAMPLE_HINTS.random}
                may={[SAMPLE_HINTS.seeded, SAMPLE_HINTS.random]}
              />
            </div>
            <Issues id={`${id}-sample-i`} issues={sample} />
            <MarkWords id={`${id}-sample`} mark={p.marks.sample} />
          </div>
        )}
        {draft.which === "ids" && (
          <div className="cb-sub">
            <div className="cb-idsrow">
              <label className="flabel cb-sublabel" htmlFor={`${id}-ids`}>
                IDs
              </label>
              <button
                ref={finder}
                type="button"
                className="btn btn-sm"
                aria-haspopup="dialog"
                onClick={() => setFinding(true)}
              >
                Find custom topology…
              </button>
            </div>
            {finding && (
              <FindTopology
                target={{
                  kind: "ids",
                  states: draft.states,
                  ids: draft.ids,
                  fitted: p.fits?.ids ?? [],
                  onAdd: p.onFound,
                }}
                onClose={() => {
                  setFinding(false);
                  finder.current?.focus();
                }}
              />
            )}
            <input
              id={`${id}-ids`}
              className={inputClass("input mono", idErrors.length > 0, p.edited.has("ids"))}
              value={draft.ids}
              placeholder={`e.g. ${example.graph}, ${example.one}`}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={idErrors.length > 0 || undefined}
              aria-describedby={described(
                p.fits !== null && `${id}-ids-fit`,
                ids !== undefined && `${id}-ids-i`,
                p.marks.ids !== undefined && `${id}-ids-was`,
                p.drawingsLimited && `${id}-ids-limit`,
                `${id}-ids-h`,
              )}
              onChange={(e) => p.set({ ids: e.target.value })}
              onBlur={p.onIdsDone}
            />
            {p.fits !== null && idErrors.length === 0 && (
              <p id={`${id}-ids-fit`} className="cb-fits" role="status">
                <FitsWords fits={p.fits} />
              </p>
            )}
            <Issues id={`${id}-ids-i`} issues={[...idErrors, ...idNotes]} />
            <MarkWords id={`${id}-ids`} mark={p.marks.ids} />
            {p.drawn !== null && p.drawn.drawings.length > 0 && <Drawings drawn={p.drawn} />}
            {p.drawingsLimited && (
              <p id={`${id}-ids-limit`} className="hint">
                Drawings are shown for {MOST_DRAWN} or fewer topologies. Reduce the list to see
                drawings.
              </p>
            )}
            <p id={`${id}-ids-h`} className="hint">
              Separated by commas or spaces.{" "}
              {p.counts !== null && (
                <>
                  <span className="n">{n}</span>
                  {"\u00a0"}states have{" "}
                  <span className="mono nw">T0–T{p.counts.state_graphs - 1}</span>.{" "}
                </>
              )}
              <span className="mono nw">{example.bare}</span> fits each of its open states;{" "}
              <span className="mono nw">{example.one}</span> fits open state {example.open}. The ids
              are ICMM’s own.
            </p>
          </div>
        )}
        {draft.which === "all" && (which !== undefined || p.counts !== null) && (
          <div className="cb-sub cb-held">
            {hasError(which) ? (
              <Issues id={`${id}-all-i`} issues={which} />
            ) : (
              p.counts !== null && (
                <p className="hint cb-all">
                  Fits all <span className="n">{whole(p.counts.topologies)}</span>
                  {"\u00a0"}topologies.
                </p>
              )
            )}
          </div>
        )}
      </fieldset>
      <div className="cb-fixed cb-span3">
        <LockIcon />
        <p className="hint">Max cycle length and max degree are fixed at 4 by the engine.</p>
      </div>
    </Section>
  );
}

export interface OptimizationProps extends FieldsProps {
  advanced: boolean;
  onAdvanced: (open: boolean) => void;
}

/** A plain field of 03 Optimization: its label, input, checks, mark and hint. */
function NumberField({
  p,
  field,
  label,
  hint,
  affix,
}: {
  p: FieldsProps;
  field: Numeric;
  label: string;
  hint: React.ReactNode;
  affix?: string;
}) {
  const id = useId();
  const issues = p.issues.get(field);
  const bad = hasError(issues);
  const input = (
    <input
      id={id}
      className={inputClass("input mono", bad, p.edited.has(field))}
      value={p.draft[field]}
      placeholder={field === "seed" ? "Drawn at submit" : undefined}
      spellCheck={false}
      autoComplete="off"
      disabled={p.locked}
      aria-invalid={bad || undefined}
      aria-describedby={described(
        issues !== undefined && `${id}-i`,
        p.marks[field] !== undefined && `${id}-was`,
        `${id}-h`,
      )}
      onChange={(e) => p.set({ [field]: e.target.value })}
      onBlur={leaving(p, field)}
    />
  );
  return (
    <div className="cb-field">
      <label className="flabel" htmlFor={id}>
        {label}
      </label>
      {affix === undefined ? (
        input
      ) : (
        <div className="cb-affix">
          {input}
          <span aria-hidden="true">{affix}</span>
        </div>
      )}
      <Issues id={`${id}-i`} issues={issues} />
      <MarkWords id={id} mark={p.marks[field]} />
      <p id={`${id}-h`} className="hint">
        {hint}
      </p>
    </div>
  );
}

/** A pair of bounds: lower to upper, in `unit`, with what they make and the pair's checks under them. */
function BoundsField({
  p,
  label,
  lower,
  upper,
  unit,
  worked,
  hint,
}: {
  p: FieldsProps;
  label: string;
  lower: Numeric;
  upper: Numeric;
  unit: React.ReactNode;
  /** A line worked out from the two numbers, as they're typed. */
  worked?: React.ReactNode;
  hint: string;
}) {
  const id = useId();
  const issues = [...(p.issues.get(lower) ?? []), ...(p.issues.get(upper) ?? [])];
  // The lower bound at or above its upper is said under the lower, about both.
  const both = issues.some((i) => i.field === lower && i.message.startsWith("The lower bound"));
  const bad = (f: Field) => hasError(p.issues.get(f)) || (both && f === upper);
  const box = (f: Numeric, name: string) => (
    <input
      className={inputClass("input mono cb-bound", bad(f), p.edited.has(f))}
      value={p.draft[f]}
      spellCheck={false}
      autoComplete="off"
      disabled={p.locked}
      aria-label={name}
      aria-invalid={bad(f) || undefined}
      aria-describedby={described(
        worked != null && `${id}-r`,
        issues.length > 0 && `${id}-i`,
        p.marks[f] !== undefined && `${id}-${f}-was`,
        `${id}-h`,
      )}
      onChange={(e) => p.set({ [f]: e.target.value })}
      onBlur={leaving(p, f)}
    />
  );
  // One sentence each, though both bounds can say the same.
  const said = issues.filter((x, i) => issues.findIndex((y) => y.message === x.message) === i);
  return (
    <div className="cb-field">
      <span id={`${id}-l`} className="flabel">
        {label}
      </span>
      <div role="group" aria-labelledby={`${id}-l`} className="cb-bounds">
        {box(lower, "Lower bound")}
        <span className="cb-to">to</span>
        {box(upper, "Upper bound")}
        <span className="unit">{unit}</span>
      </div>
      {worked != null && (
        <p id={`${id}-r`} className="cb-worked" role="status">
          {worked}
        </p>
      )}
      <Issues id={`${id}-i`} issues={said} />
      <MarkWords id={`${id}-${lower}`} mark={p.marks[lower]} />
      <MarkWords id={`${id}-${upper}`} mark={p.marks[upper]} />
      <p id={`${id}-h`} className="hint">
        {hint}
      </p>
    </div>
  );
}

/** Advanced's closed bar: "seed drawn at submit · random start points · log every 200 generations · default bounds". */
function AdvancedSummary({ draft }: { draft: ConfigDraft }) {
  const seed = draft.seed.trim();
  const defaults =
    [draft.rateMin, draft.rateMax, draft.sigmoidMin, draft.sigmoidMax]
      .map((x) => x.trim().replace("−", "-"))
      .join(" ") === "-10 10 -80 60";
  return (
    <span className="cb-adv-sum">
      {seed === "" ? (
        "seed drawn at submit"
      ) : (
        <>
          seed <span className="mono">{seed}</span>
        </>
      )}
      {` · ${draft.sobol ? "Sobol start points" : "random start points"} · log every `}
      <span className="mono">{draft.log.trim()}</span>
      {draft.log.trim() === "1" ? " generation" : " generations"}
      {defaults ? (
        " · default bounds"
      ) : (
        <>
          {" · parameters "}
          <span className="mono">
            {draft.rateMin.trim()} … {draft.rateMax.trim()}
          </span>{" "}
          <span className="mono">ln</span>
          {" units · voltage dependence "}
          <span className="mono">
            {draft.sigmoidMin.trim()} … {draft.sigmoidMax.trim()}
          </span>
          {" mV"}
        </>
      )}
    </span>
  );
}

/** 03 Optimization: starts, population and evaluations, then Advanced's search settings and bounds. */
export function Optimization(p: OptimizationProps) {
  const id = useId();
  const { draft } = p;
  const sobol = p.issues.get("sobol");
  const population = /^\d[\d,]*$/.test(draft.population.trim())
    ? Number(draft.population.replace(/,/g, ""))
    : null;
  const log = /^\d[\d,]*$/.test(draft.log.trim()) ? Number(draft.log.replace(/,/g, "")) : null;
  const budget = /^\d[\d,]*$/.test(draft.evaluations.trim())
    ? Number(draft.evaluations.replace(/,/g, ""))
    : null;
  // Under one generation, the engine's note says what runs.
  const generations =
    population !== null && budget !== null && budget >= population
      ? generationsOf(budget, population)
      : null;
  const voltage = voltageWords(numberOf(draft.sigmoidMin), numberOf(draft.sigmoidMax));
  return (
    <Section
      n="03"
      title="Optimization"
      hint="How hard CMA-ES, the fitting method, searches each topology."
    >
      <NumberField
        p={p}
        field="starts"
        label="Starts per topology"
        hint={
          <>
            About 100 is typical; more starts raise the odds of finding the best fit. Each
            topology’s <span className="ink-2">Near best</span> shows how many came within 1%.
          </>
        }
      />
      <NumberField
        p={p}
        field="population"
        label="Population size"
        hint="Objective function evaluations per generation."
      />
      <NumberField
        p={p}
        field="evaluations"
        label="Evaluations per start"
        hint={
          <>
            Every start runs all of them
            {generations !== null && (
              <>
                : at population <span className="n">{whole(population!)}</span>,{" "}
                <span className="n">{whole(budget!)}</span> is{" "}
                <span className="n">{whole(generations)}</span>
                {"\u00a0"}
                {generationWords(generations)}
              </>
            )}
            .
          </>
        }
      />
      <div className={`cb-adv cb-span3${p.advanced ? " open" : ""}`}>
        <button
          type="button"
          className="cb-adv-bar"
          aria-expanded={p.advanced}
          aria-controls={`${id}-adv`}
          onClick={() => p.onAdvanced(!p.advanced)}
        >
          <Chevron open={p.advanced} />
          <span className="cb-adv-words">
            <span className="cb-adv-name">Advanced</span>
            {!p.advanced && <AdvancedSummary draft={draft} />}
          </span>
        </button>
        {p.advanced && (
          <div id={`${id}-adv`} className="cb-adv-body">
            <NumberField
              p={p}
              field="seed"
              label="Search seed"
              hint="Blank draws a new one for each run. It also draws the Random sample. To repeat a run’s search, copy its seed from the run’s page."
            />
            <NumberField
              p={p}
              field="log"
              label="Log every"
              affix="generations"
              hint={
                <>
                  How often each start records its progress and its live page updates.
                  {population !== null && log !== null && (
                    <>
                      {" "}
                      At population <span className="n">{whole(population)}</span>,{" "}
                      <span className="n">{whole(log)}</span> is{" "}
                      <span className="n">{whole(population * log)}</span> evaluations.
                    </>
                  )}
                </>
              }
            />
            <div className="cb-field cb-span2">
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.sobol}
                  disabled={p.locked}
                  aria-describedby={described(
                    sobol !== undefined && `${id}-sobol-i`,
                    `${id}-sobol-h`,
                  )}
                  onChange={(e) => p.set({ sobol: e.target.checked })}
                />
                <span className="flabel">Sobol start points</span>
              </label>
              <span className="cb-indent">
                <Issues id={`${id}-sobol-i`} issues={sobol} />
                <MarkWords id={`${id}-sobol`} mark={p.marks.sobol} />
              </span>
              <p id={`${id}-sobol-h`} className="hint cb-indent">
                Spreads start points evenly across the bounds instead of drawing each at random.
                Helps with few starts; with many, random points already cover the bounds.
              </p>
            </div>
            <div className="cb-rule cb-span2" aria-hidden="true" />
            <BoundsField
              p={p}
              label="Parameter bounds"
              lower="rateMin"
              upper="rateMax"
              unit={
                <>
                  <span className="mono">ln</span> units
                </>
              }
              hint="Each state and edge parameter is a natural log. The bounds limit it, not the rate it makes."
            />
            <BoundsField
              p={p}
              label="Voltage dependence bounds"
              lower="sigmoidMin"
              upper="sigmoidMax"
              unit="mV"
              worked={voltage !== null && <VoltageLine {...voltage} />}
              hint="For a and b in tanh((V + a)/b), one curve that each transition’s voltage part scales."
            />
          </div>
        )}
      </div>
    </Section>
  );
}

function MinusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2.5" y="6" width="9" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6V4.3a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
