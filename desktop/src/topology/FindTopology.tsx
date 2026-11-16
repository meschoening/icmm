/**
 * Find custom topology (#222; LaptopConfigBuilder's dlg-* views and
 * LaptopCommandPalette's frame 4): a dialog where someone types a
 * topology's transitions in state numbers of their own and gets ICMM's id.
 *
 * As they type, their numbers are drawn in ICMM's layout of the same graph,
 * turned so their lowest number reads from the left; once it matches, with
 * an open state chosen, a second drawing of the same shape carries ICMM's
 * numbers and the id. A topology that breaks a rule is drawn as it's typed,
 * the part that breaks it in red, and each check names its rule a moment
 * after typing stops. The host engine answers each change in a few
 * milliseconds (#223), so there's no working state: the last answer stays
 * until the next. Opening the dialog asks about nothing typed, which starts
 * the engine before the first transition is.
 *
 * From Specific IDs, Add puts the id in the ids; from ⌘K, Copy and New config
 * with the id. Whoever opened it returns focus when it closes.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NoteIcon, Sentence } from "../configs/builder/Sections";
import { idWords } from "../configs/words";
import { count } from "../datasets/format";
import { CHECK_AFTER_MS } from "../datasets/queries";
import { COPIED_FOR_MS } from "../connection/ConnectionStrip";
import { useBlocker } from "../ui/blocker";
import { commands } from "../wire/api.gen";
import type {
  FoundTopology,
  SpecificId,
  TopologyIssue,
  TopologyMatch,
  WireError,
} from "../wire/types.gen";
import { TopologyDrawing } from "./Drawing";
import { addPlan, badWords, checkWords, parseTransitions, readBack, type Typed } from "./find";
import { layOutAny, type Spot } from "./layout";
import { FIND_TOPOLOGY } from "./size";
import { useLayouts } from "./useLayouts";

/** Where it was opened from, and so what its id is for. */
export type FindTarget =
  | {
      kind: "ids";
      /** The config's Number of states and Specific IDs, as typed. */
      states: string;
      ids: string;
      /** What its check says the ids fit, as a save keeps them. */
      fitted: SpecificId[];
      onAdd: (change: { ids: string; states?: string }) => void;
    }
  | { kind: "new"; onNewConfig: (found: FoundTopology) => void };

const LEAD =
  "Type the transitions between states, numbered however you like. ICMM finds the topology’s id and numbers its states its own way.";
const HINT =
  "Each transition is two state numbers joined by a dash; separate them with commas. Any whole numbers will do, in any order.";

/** The most transitions one match sends (`MAX_TRANSITIONS`): 16 states have at most 136. */
const MAX_TRANSITIONS = 256;

/** What the engine would say of more transitions than it takes. */
const TOO_MANY = {
  rule: "num_states",
  states: [],
  transitions: [],
  loop: null,
} as const satisfies TopologyIssue;

/** What the engine answered, and for what. */
interface Answered {
  key: string;
  typed: Typed;
  open: number | null;
  match: TopologyMatch;
}

/** The engine's answer for what's typed: the last one until the next comes. */
function useMatch(typed: Typed, open: number | null) {
  const params = { transitions: typed.transitions, open_state: open };
  const key = JSON.stringify(params);
  const q = useQuery({
    queryKey: ["match_topology", key],
    // Past the engine's limit is far past 16 states, which is all it would say.
    queryFn: () =>
      params.transitions.length > MAX_TRANSITIONS
        ? Promise.resolve<TopologyMatch>({ found: null, issues: [TOO_MANY] })
        : commands.match_topology(params),
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const [last, setLast] = useState<Answered>();
  if (q.data !== undefined && !q.isPlaceholderData && last?.key !== key) {
    setLast({ key, typed, open, match: q.data });
  }
  const error = q.isError && !q.isFetching ? (q.error as unknown as WireError) : undefined;
  return { key, last, current: last?.key === key, error };
}

/** `text` once it's stayed the same for a moment, as checks wait for. */
function useSettled(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setSettled(text), CHECK_AFTER_MS);
    return () => clearTimeout(t);
  }, [text]);
  return settled;
}

export function FindTopology({ target, onClose }: { target: FindTarget; onClose: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState("");
  const typed = useMemo(() => parseTransitions(text), [text]);
  // A choice of a number no longer typed is no choice.
  const open = chosen !== "" && typed.states.includes(Number(chosen)) ? Number(chosen) : null;
  const { key, last, current, error } = useMatch(typed, open);
  const settledText = useSettled(text);
  const settled = settledText === text;

  // The checks said once typing stops, and kept while it starts again.
  const [checked, setChecked] = useState<Answered & { bad: string[] }>();
  if (settled && current && last !== undefined && checked?.key !== `${key}|${text}`) {
    setChecked({ ...last, key: `${key}|${text}`, bad: typed.bad });
  }
  const lines =
    checked === undefined || checked.typed.states.length + checked.bad.length === 0
      ? []
      : [
          ...(checked.bad.length > 0 ? [badWords(checked.bad)] : []),
          ...checked.match.issues.map((issue) => checkWords(issue, checked.typed)),
        ];
  const errorLine = error !== undefined && settled ? error.message : undefined;
  const bad = lines.length > 0 || errorLine !== undefined;

  const found = current && typed.bad.length === 0 ? last?.match.found : undefined;
  const plan =
    found != null && found.open_state !== null && target.kind === "ids"
      ? addPlan(found, target.states, target.ids, target.fitted)
      : undefined;
  const ready = found != null && found.open_state !== null;
  const blocker =
    typed.states.length === 0 && typed.bad.length === 0
      ? "Type the transitions first"
      : (last?.match.issues.length ?? 0) > 0 || typed.bad.length > 0 || error !== undefined
        ? "Fix the transitions first"
        : found != null && found.open_state === null
          ? "Choose the open state first"
          : !ready
            ? "Fix the transitions first"
            : plan?.blocked;

  useEffect(() => field.current?.focus(), []);
  // The field grows to show every transition typed.
  useEffect(() => {
    const el = field.current;
    if (el === null) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const stops = [
      ...(box.current?.querySelectorAll<HTMLElement>("button, textarea, select, a[href]") ?? []),
    ];
    const [first, end] = [stops[0], stops[stops.length - 1]];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      end?.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first?.focus();
    }
  };

  const shown =
    typed.states.length > 0 && last !== undefined && last.typed.states.length > 0
      ? last
      : undefined;
  return createPortal(
    <div className="fd-scrim">
      <div
        ref={box}
        className="fd"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-lead`}
        onKeyDown={onKeyDown}
      >
        <div className="fd-head">
          <div className="fd-title">
            <h2 id={`${id}-t`}>Find custom topology</h2>
            <p id={`${id}-lead`} className="hint">
              {LEAD}
            </p>
          </div>
          <button type="button" className="btn-icon fd-close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="fd-body">
          <div className="fd-row">
            <div className="fd-col">
              <label className="flabel" htmlFor={`${id}-tr`}>
                Transitions
              </label>
              <textarea
                ref={field}
                id={`${id}-tr`}
                rows={1}
                className={`input mono fd-area${bad ? " bad" : ""}`}
                value={text}
                placeholder="e.g. 1–2, 2–3, 3–4, 4–5"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={bad || undefined}
                aria-describedby={[
                  typed.states.length > 0 && `${id}-read`,
                  (lines.length > 0 || errorLine !== undefined) && `${id}-checks`,
                  `${id}-hint`,
                ]
                  .filter(Boolean)
                  .join(" ")}
                onChange={(e) => setText(e.target.value)}
                // One list of transitions, which wraps: Enter starts no new line.
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
              {typed.states.length > 0 && (
                <p id={`${id}-read`} className="fd-read" role="status">
                  <Sentence text={readBack(typed)} />
                </p>
              )}
              {(lines.length > 0 || errorLine !== undefined) && (
                <div id={`${id}-checks`} className="fd-checks">
                  {[...lines, ...(errorLine !== undefined ? [errorLine] : [])].map((line) => (
                    <p key={line} className="err" role="alert">
                      <Sentence text={line} />
                    </p>
                  ))}
                </div>
              )}
              <p id={`${id}-hint`} className="hint">
                {HINT}
              </p>
            </div>
            <div className="fd-col">
              <label className="flabel" htmlFor={`${id}-os`}>
                Open state
              </label>
              <select
                id={`${id}-os`}
                className={`input${open === null ? " fd-ph" : " mono"}`}
                value={open === null ? "" : String(open)}
                aria-disabled={typed.states.length === 0 || undefined}
                onChange={(e) => {
                  if (typed.states.length > 0) setChosen(e.target.value);
                }}
              >
                <option value="">Choose…</option>
                {typed.states.map((s) => (
                  <option key={s} value={String(s)}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Drawings
            answered={shown}
            marking={settled && checked?.key === `${key}|${text}` ? key : undefined}
          />
          {plan?.note != null && (
            <p className="fnote">
              <NoteIcon />
              <span>
                <Sentence text={plan.note} />
              </span>
            </p>
          )}
        </div>
        <div className="fd-foot">
          {target.kind === "ids" ? (
            <>
              <button type="button" className="btn-text" onClick={onClose}>
                Cancel
              </button>
              <ActButton
                className="btn btn-primary"
                label={plan?.label ?? "Add to the ids"}
                blocker={blocker}
                onClick={() => {
                  if (plan?.ids === undefined) return;
                  target.onAdd({ ids: plan.ids, states: plan.states });
                  onClose();
                }}
              />
            </>
          ) : (
            <PaletteActions found={ready ? found : undefined} blocker={blocker} target={target} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A button that says why it's gray (old ADR-0026). */
function ActButton({
  className,
  label,
  blocker,
  onClick,
}: {
  className: string;
  label: React.ReactNode;
  blocker: string | undefined;
  onClick: () => void;
}) {
  const b = useBlocker(blocker);
  return (
    <>
      <button
        type="button"
        className={className}
        {...b.props}
        onClick={(e) => {
          b.props.onClick(e);
          if (blocker === undefined) onClick();
        }}
      >
        {label}
      </button>
      {b.bubble}
    </>
  );
}

/** From ⌘K: Copy the id, or start a new config with it. */
function PaletteActions({
  found,
  blocker,
  target,
}: {
  found: FoundTopology | undefined;
  blocker: string | undefined;
  target: Extract<FindTarget, { kind: "new" }>;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const id =
    found === undefined ? "" : idWords({ graph: found.graph, open_state: found.open_state });
  return (
    <>
      <ActButton
        className="btn"
        label={
          <span aria-live="polite">
            {copied ? "Copied" : found === undefined ? "Copy" : `Copy ${id}`}
          </span>
        }
        blocker={blocker}
        onClick={() => {
          // Where the clipboard can't be written, the id stays in the caption to copy by hand.
          void navigator.clipboard?.writeText(id).then(
            () => {
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
            },
            () => {},
          );
        }}
      />
      <ActButton
        className="btn btn-primary"
        label={found === undefined ? "New config" : `New config with ${id}`}
        blocker={blocker}
        onClick={() => {
          if (found !== undefined) target.onNewConfig(found);
        }}
      />
    </>
  );
}

/**
 * The drawings: yours alone, or yours and ICMM's beside once it matches with
 * an open state. A new graph's layout takes a moment off the page's thread;
 * the last drawings stay until it's done.
 */
function Drawings({
  answered,
  marking,
}: {
  answered: Answered | undefined;
  /** The answer whose checks show, so its drawing marks what breaks them. */
  marking: string | undefined;
}) {
  const found = answered?.match.found ?? null;
  const icmm = new Map(found?.states.map((s) => [s.number, s.state]));
  const edges =
    found === null || answered === undefined
      ? []
      : answered.typed.transitions.map(([a, b]) => [icmm.get(a)!, icmm.get(b)!] as const);
  const laid = useLayouts(found === null ? [] : [{ numStates: found.num_states, edges }]);
  const now = answered !== undefined && laid !== undefined ? { answered, laid } : undefined;
  const [kept, setKept] = useState(now);
  if (now !== undefined && kept?.answered !== now.answered) setKept(now);
  const shown = answered === undefined ? undefined : (now ?? kept);
  if (shown === undefined) {
    return (
      <figure className="fd-fig">
        <div className="fd-box fd-empty">
          <span className="fd-ph">The topology draws here as you type.</span>
        </div>
      </figure>
    );
  }
  const { match } = shown.answered;
  return match.found === null ? (
    <Broken answered={shown.answered} marking={shown.answered.key === marking} />
  ) : (
    <Matched typed={shown.answered.typed} found={match.found} spots={shown.laid[0]} />
  );
}

/** "5 states, 4 transitions, numbered as you typed them, open state 4." */
function yoursSentence(typed: Typed, open: number | null) {
  const counts = `${count(typed.states.length, "state")}, ${count(typed.transitions.length, "transition")}`;
  return `${counts}, numbered as you typed them${open === null ? "" : `, open state ${open}`}.`;
}

/** Spots turned so that `lowest` reads from the left, and from the top. */
function turned(spots: Spot[], lowest: number): Spot[] {
  const [xs, ys] = [spots.map((s) => s.x), spots.map((s) => s.y)];
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const flipX = spots[lowest].x > (x0 + x1) / 2;
  const flipY = spots[lowest].y > (y0 + y1) / 2;
  return spots.map((s) => ({ x: flipX ? x1 + x0 - s.x : s.x, y: flipY ? y1 + y0 - s.y : s.y }));
}

/** Your numbers in ICMM's layout of the same graph, turned; ICMM's beside once it has an open state. */
function Matched({ typed, found, spots }: { typed: Typed; found: FoundTopology; spots: Spot[] }) {
  const n = found.num_states;
  const icmm = new Map(found.states.map((s) => [s.number, s.state]));
  const edges = typed.transitions.map(([a, b]) => [icmm.get(a)!, icmm.get(b)!]);
  const at = turned(spots, icmm.get(typed.states[0])!);
  const names: string[] = [];
  for (const s of found.states) names[s.state] = String(s.number);
  const graph = { edges, open_states: [] };
  const open = found.open_state;
  const yours = open === null ? null : found.states.find((s) => s.state === open)!.number;
  const mine = (
    <TopologyDrawing
      graph={graph}
      spots={at}
      open={open}
      label={yoursSentence(typed, yours)}
      size={FIND_TOPOLOGY}
      names={names}
    />
  );
  if (open === null) {
    return (
      <figure className="fd-fig">
        <div className="fd-box">{mine}</div>
      </figure>
    );
  }
  const id = idWords({ graph: found.graph, open_state: open });
  const sentence = `${id}: ${count(n, "state")}, ${count(edges.length, "transition")}, open state ${open}, as ICMM numbers them.`;
  return (
    <div className="fd-pair">
      <figure className="fd-fig">
        <div className="fd-box">{mine}</div>
        <figcaption className="fd-cap">
          Your numbers · open state <span className="n">{yours}</span>
        </figcaption>
      </figure>
      <figure className="fd-fig">
        <div className="fd-box">
          <TopologyDrawing
            graph={graph}
            spots={at}
            open={open}
            label={sentence}
            size={FIND_TOPOLOGY}
          />
        </div>
        <figcaption className="fd-cap">
          <span className="mono">{id}</span> · open state {open}
        </figcaption>
      </figure>
    </div>
  );
}

/** How far apart pieces not joined to each other sit, in units of the distance between states. */
const PIECE_GAP = 1.6;

/**
 * A typed topology that breaks a rule, as typed: each piece laid out, side by
 * side; once its checks show, the part that breaks one in red, the rest dimmed.
 */
function Broken({
  answered: { typed, open, match },
  marking,
}: {
  answered: Answered;
  marking: boolean;
}) {
  const drawing = useMemo(() => brokenDrawing(typed), [typed]);
  const shown = marking
    ? match.issues.filter(
        (i) => i.rule === "loop" || i.rule === "neighbors" || i.rule === "connected",
      )
    : [];
  const marked =
    shown.length === 0
      ? undefined
      : {
          states: new Set(shown.flatMap((i) => i.states.map((s) => typed.states.indexOf(s)))),
          edges: new Set(shown.flatMap((i) => i.transitions.map((k) => drawing.edgeOf[k]))),
        };
  return (
    <figure className="fd-fig">
      <div className="fd-box">
        <TopologyDrawing
          graph={{ edges: drawing.edges, open_states: [] }}
          spots={drawing.spots}
          open={open === null ? null : typed.states.indexOf(open)}
          label={yoursSentence(typed, open)}
          size={FIND_TOPOLOGY}
          names={typed.states.map(String)}
          marked={marked}
        />
      </div>
    </figure>
  );
}

/**
 * A typed topology drawn as its own graph, its states by typed number, lowest
 * first: each piece laid out (`layOutAny`), side by side, then turned.
 */
function brokenDrawing(typed: Typed) {
  const index = new Map(typed.states.map((s, i) => [s, i]));
  const edges: [number, number][] = [];
  /** Each typed transition's edge in the drawing; a state joined to itself has none. */
  const edgeOf: number[] = [];
  typed.transitions.forEach(([a, b]) => {
    edgeOf.push(a === b ? -1 : edges.length);
    if (a !== b) edges.push([index.get(a)!, index.get(b)!]);
  });
  const n = typed.states.length;
  const adj = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const spots: Spot[] = Array(n);
  const seen = new Set<number>();
  let left = 0;
  const pieces: { states: number[]; at: Spot[] }[] = [];
  for (let s = 0; s < n; s++) {
    if (seen.has(s)) continue;
    const piece = [s];
    seen.add(s);
    for (let i = 0; i < piece.length; i++) {
      for (const t of adj[piece[i]]) {
        if (!seen.has(t)) {
          seen.add(t);
          piece.push(t);
        }
      }
    }
    piece.sort((a, b) => a - b);
    const local = new Map(piece.map((v, i) => [v, i]));
    const within = edges.filter(([a, b]) => local.has(a) && local.has(b));
    const at = layOutAny(
      piece.length,
      within.map(([a, b]) => [local.get(a)!, local.get(b)!]),
    );
    pieces.push({ states: piece, at: turned(at, 0) });
  }
  const tallest = Math.max(...pieces.map((p) => Math.max(...p.at.map((s) => s.y))));
  for (const { states, at } of pieces) {
    const width = Math.max(...at.map((s) => s.x));
    const down = (tallest - Math.max(...at.map((s) => s.y))) / 2;
    states.forEach((v, i) => (spots[v] = { x: at[i].x + left, y: at[i].y + down }));
    left += width + PIECE_GAP;
  }
  return { edges, edgeOf, spots };
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
