/**
 * How the connection card reads a connection at a moment (LaptopConnection,
 * and "Connection card decisions", 2026-10-01): the status line, the strip
 * across the card's foot, and the card's one action. Pure, so every state can
 * be tested at any time.
 *
 * The desktop publishes each step of a connect as it happens. The card shows
 * four fixed steps (This computer runs two of them):
 *
 * - **Installing engine** isn't known until the first exec finds the engine
 *   or doesn't, so until then it's a gray ring that says "checking…". When
 *   the engine was there it's done, "installed". When it wasn't, the first
 *   exec's time counts toward it, so the durations add up to the connect.
 * - **Starting ICMM** is the exec that runs the engine; after an install,
 *   the one that follows it.
 * - **Checking scheduler** is hello, where the agent finds the scheduler and
 *   checks the Data folder. This computer counts hello as Starting ICMM.
 *
 * While a new engine takes the runs in flight over (the **Hand-over**,
 * ADR-0020; #284), hello asks to be asked again: Starting ICMM stays under
 * way, "moving runs", its time counting on, and a line under the steps says
 * what's happening, and from a minute on why it's slow.
 *
 * A host key known_hosts hasn't seen stops the connect to ask the user
 * (`host-unknown`), who trusts it or cancels; one that changed fails it
 * (`host-changed`), and forgetting the old key connects again to ask about
 * the new one.
 *
 * A first connect that no key gets through asks for one (`needs-key`):
 * ICMM's key, added with the password, or a key the user has. Once it's
 * added, Signing in counts from the press and says "key added". Later, a
 * refused key fails, and its fix opens the same question.
 *
 * A reconnect keeps one shape whether it waits or tries ("The reconnecting
 * strip", 2026-10-04): the latest reason as its sentence, over one line of
 * facts, the countdown or the try's step and its time so far.
 *
 * A failure reads in three lines ("The connection's failures and sentences in
 * plain words", #116): what happened, the next step, worded for whose move it
 * is, and the raw line in small mono. The desktop writes all three, with the
 * ways forward and whether Retry now can help at all.
 */
import { STATUS_LOOK, type Connection, type ConnectionState } from "../shell/connection";
import { clock } from "../ui/clock";
import type {
  ConnectFix,
  ConnectStep,
  KeyOffer,
  KeyQuestion,
  RecordedKey,
  StepTime,
} from "../wire/types.gen";

export type PlatformKind = "ssh" | "local";

export interface StatusLine {
  glyph: string;
  /** The pill's words, in ink. */
  words: string;
  /** What follows them and changes only with the state: announced with it. */
  fact: string;
  /** What follows that and changes every second: never announced. */
  ticking: string;
}

export interface StepView {
  name: string;
  state: "done" | "current" | "todo";
  /** A finished step's duration; the current one's time so far. */
  figure: string;
  /** How much of the engine has gone up, from 0 to 1. */
  meter?: number;
}

/** A host key as the strip shows it. */
export interface KeyView {
  algorithm: string;
  fingerprint: string;
}

/** A key question as the strip asks it (LaptopConnection's `needs-key` … `add-again`). */
export interface KeyAskView {
  title: string;
  body: string;
  /** The first card's: making or adding ICMM's key. */
  offer: { title: string; body: string; button: string };
  host: string;
  /** Whose password adds the key. */
  user: string;
  /** The keys the host refused, as the question names them. */
  tried: string[];
  /** Whether the host takes a password; without one, the card shows `publicKey` to add by hand. */
  password: boolean;
  publicKey: string | null;
}

export type StripView =
  | {
      kind: "steps";
      steps: StepView[];
      /** Whether the engine is uploading: then ICMM can be closed, and picks it up later. */
      uploading: boolean;
      /** While a new engine takes the runs over, the line that says so. */
      handingOver: string | undefined;
    }
  | { kind: "key_question"; ask: KeyAskView }
  | {
      kind: "host_unknown";
      host: string;
      key: KeyView;
      /** Whether the user just forgot the host's old key: this is its new one. */
      forgot: boolean;
    }
  | { kind: "host_changed"; host: string; key: KeyView; recorded: RecordedKey }
  | {
      kind: "failure";
      /** What happened. */
      sentence: string;
      /** The next step. */
      next: string | undefined;
      /** The raw line, in small mono. */
      details: string | undefined;
      fixes: ConnectFix[];
      /** Whether Retry now shows: only where retrying can help. */
      retry: boolean;
    }
  | {
      kind: "reconnecting";
      /** Why: how the connection ended, then what the latest try hit. */
      sentence: string;
      /** Under it, for a try that didn't reach the host. */
      hint: string | undefined;
      /** Seconds to the next attempt; `null` while one runs. */
      next: number | null;
      /** While a try runs, its step under way in the stepper's words, and its time so far. */
      step: { name: string; soFar: string } | null;
      attempt: number;
    };

export type Action = "Connect" | "Cancel" | "Stop reconnecting" | "Disconnect";

export interface CardView {
  status: StatusLine;
  strip: StripView | null;
  /**
   * The card's action beside Edit. A failure has none, since its strip has
   * Retry now, and nor has a host key, whose strip has its own buttons.
   */
  action: Action | null;
  /** Whether "Its runs keep going." goes under the action: Disconnect and Stop reconnecting. */
  keepGoing: boolean;
}

/** `c` is the platform's connection, or `undefined` when it isn't the Active platform. */
export function cardView(c: Connection | undefined, kind: PlatformKind, now: number): CardView {
  const view = card(c, kind, now);
  return {
    ...view,
    keepGoing: view.action === "Disconnect" || view.action === "Stop reconnecting",
  };
}

function card(
  c: Connection | undefined,
  kind: PlatformKind,
  now: number,
): Omit<CardView, "keepGoing"> {
  const status = c?.status ?? "not_connected";
  const { glyph, words } = STATUS_LOOK[status];
  const line = (fact = "", ticking = ""): StatusLine => ({ glyph, words, fact, ticking });
  if (c === undefined || c.status === "not_connected") {
    return { status: line(), strip: null, action: "Connect" };
  }
  switch (c.status) {
    case "connecting":
      if (c.key_question !== null) {
        return {
          status: line(" · waiting for you"),
          strip: { kind: "key_question", ask: keyAsk(c.key_question, c.platform) },
          // The strip has its own Cancel, beside its two ways forward.
          action: null,
        };
      }
      if (c.host_key !== null) {
        const { host, algorithm, fingerprint, forgot } = c.host_key;
        return {
          status: line(" · waiting for you"),
          strip: { kind: "host_unknown", host, key: { algorithm, fingerprint }, forgot },
          // The strip has its own Cancel, beside Trust and connect.
          action: null,
        };
      }
      return {
        status: line("", c.since === null ? "" : ` · ${duration(now - c.since)} so far`),
        strip: {
          kind: "steps",
          steps: stepsOf(c, kind, now),
          uploading: c.upload !== null && c.upload.sent < c.upload.total,
          handingOver: handingOver(c, kind, now),
        },
        action: "Cancel",
      };
    case "connected":
      return { status: line(connectedFact(c, kind, now)), strip: null, action: "Disconnect" };
    case "failed": {
      const failure = c.failure ?? "other";
      const key = c.host_key;
      if (failure === "host_key_changed" && key !== null && key.recorded !== null) {
        return {
          status: line(failedFact(c, kind)),
          strip: {
            kind: "host_changed",
            host: key.host,
            key: { algorithm: key.algorithm, fingerprint: key.fingerprint },
            recorded: key.recorded,
          },
          action: null,
        };
      }
      return {
        status: line(failedFact(c, kind)),
        strip: {
          kind: "failure",
          sentence: c.reason ?? "",
          next: c.next_step ?? undefined,
          details: c.details ?? undefined,
          fixes: c.fixes,
          retry: c.can_retry,
        },
        action: null,
      };
    }
    case "reconnecting": {
      const at = c.retry?.at ?? null;
      return {
        status: line(c.since === null ? "" : ` · since ${clock(c.since, now)}`),
        strip: {
          kind: "reconnecting",
          sentence: c.reason ?? "",
          hint: c.failure === "unreachable" ? OFFLINE : undefined,
          next: at === null ? null : Math.max(0, Math.ceil((at - now) / 1000)),
          step: at === null ? tryStep(c, kind, now) : null,
          attempt: c.retry?.attempt ?? 1,
        },
        action: "Stop reconnecting",
      };
    }
  }
}

/**
 * When the card's ticking figures began, for `useNow` to count whole seconds
 * from: the connect, each step and the next try. Only a connect or a
 * reconnect ticks, so otherwise none.
 */
export function countsFrom(c: Connection | undefined): number[] {
  if (c?.status !== "connecting" && c?.status !== "reconnecting") return [];
  const from = c.steps.map((t) => t.started_at);
  if (c.since !== null) from.push(c.since);
  if (c.retry?.at != null) from.push(c.retry.at);
  return from;
}

/**
 * A reconnect's try that didn't reach the host. The host and port worked
 * before, so it doesn't ask the user to check them.
 */
const OFFLINE = "Check that this computer is online. Some clusters need a VPN from off campus.";

/** What a try is doing, as the stepper names it, lowercased. */
const DOING: Record<ConnectStep, string> = {
  signing_in: "signing in",
  adding_key: "signing in",
  installing_engine: "installing engine",
  starting: "starting ICMM",
  checking: "checking scheduler",
  handing_over: "starting ICMM",
};

/** A reconnect's try: its step under way, and its time from its first step. */
function tryStep(c: Connection, kind: PlatformKind, now: number) {
  const last = c.steps[c.steps.length - 1];
  if (last === undefined || last.ended_at !== null) return null;
  // Hello is part of starting on This computer.
  const step = last.step === "checking" && kind === "local" ? "starting" : last.step;
  return { name: DOING[step], soFar: duration(now - c.steps[0].started_at) };
}

const ONCE = "It needs your password once, and doesn’t keep it.";

/** What the first card offers to do with ICMM's key. */
const OFFERS: Record<KeyOffer, KeyAskView["offer"]> = {
  make: {
    title: "Make one for me",
    body: `ICMM makes a key here and adds it to the cluster. ${ONCE}`,
    button: "Make key and connect",
  },
  add: {
    title: "Add ICMM’s key",
    body: `ICMM adds the key it made on this computer to the cluster. ${ONCE}`,
    button: "Add key and connect",
  },
  add_again: {
    title: "Add it again",
    body: `ICMM adds its key to the cluster again. ${ONCE}`,
    button: "Add key and connect",
  },
};

function keyAsk(q: KeyQuestion, platform: string): KeyAskView {
  const again = q.offer === "add_again";
  const signs = "ICMM signs in on its own, with no password.";
  let body: string;
  if (again) {
    body = `${q.host} no longer accepts the key ICMM made for it. It may have been removed from the cluster.`;
  } else if (q.tried.length === 0) {
    body = `This computer has no SSH key yet. With one the cluster accepts, ${signs}`;
  } else {
    const keys = q.tried.length === 1 ? "the key" : "the keys";
    body = `${q.host} didn’t accept ${keys} on this computer (${and(q.tried)}). With one it accepts, ${signs}`;
  }
  return {
    title: again ? `Add ICMM’s key to ${platform} again` : `${platform} needs an SSH key`,
    body,
    offer: OFFERS[q.offer],
    host: q.host,
    user: q.user,
    tried: q.tried,
    password: q.password,
    publicKey: q.public_key,
  };
}

/** "a", "a and b", "a, b and c". */
function and(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function connectedFact(c: Connection, kind: PlatformKind, now: number): string {
  if (c.since === null) return "";
  const facts = [` since ${clock(c.since, now)}`];
  if (kind === "ssh") facts.push("SSH");
  const first = c.steps[0];
  if (first !== undefined) facts.push(`last connect ${duration(c.since - first.started_at)}`);
  return facts.join(" · ");
}

/** What a failed connect was doing, as its status line says it. */
const AT: Record<ConnectStep, string> = {
  signing_in: "at signing in",
  adding_key: "at signing in",
  installing_engine: "at installing the engine",
  starting: "at starting ICMM",
  checking: "at checking scheduler",
  handing_over: "at starting ICMM",
};

function failedFact(c: Connection, kind: PlatformKind): string {
  if (c.failure === "host_key_changed") return " · the host key changed";
  const last = c.steps[c.steps.length - 1]?.step;
  if (last === undefined) return "";
  return ` · ${AT[last === "checking" && kind === "local" ? "starting" : last]}`;
}

/** The start that counts: after an install, the one that follows it. */
function counted(steps: StepTime[]): StepTime | undefined {
  const install = steps.findIndex((t) => t.step === "installing_engine");
  return steps.slice(install + 1).find((t) => t.step === "starting");
}

const MOVES = "This version of ICMM moves your runs in flight to its new engine.";

/** A hand-over's line under the steps: what's happening, then from a minute of Starting ICMM on, why it's slow. */
function handingOver(c: Connection, kind: PlatformKind, now: number): string | undefined {
  const last = c.steps[c.steps.length - 1];
  if (last?.step !== "handing_over" || last.ended_at !== null) return undefined;
  const from = counted(c.steps)?.started_at ?? last.started_at;
  if (now - from < 60_000) {
    return `${MOVES} Each finishes the check it’s in first, usually in seconds, and goes on without losing a start.`;
  }
  const slurm = kind === "ssh" ? ", which takes longer when SLURM is slow to answer" : "";
  return `${MOVES} Some are still finishing their check${slurm}. ICMM waits for them, and no start is lost.`;
}

function stepsOf(c: Connection, kind: PlatformKind, now: number): StepView[] {
  const steps = c.steps;
  const one = (name: ConnectStep) => steps.find((t) => t.step === name);
  const install = steps.findIndex((t) => t.step === "installing_engine");
  const checking = one("checking");
  // A hello that named a hand-over, and the ones after it: part of Starting ICMM.
  const handing = one("handing_over");
  const start = counted(steps);
  const shown = (name: string, from: number | undefined, to: number | null | undefined) =>
    span(name, from, to, now);
  const starting = (to: number | null | undefined) => {
    const view = shown("Starting ICMM", start?.started_at, to);
    if (handing === undefined || view.state !== "current") return view;
    return { ...view, figure: `moving runs ·\u00a0${view.figure}` };
  };

  let engine: StepView;
  if (install >= 0) {
    const looked = steps[install - 1]?.step === "starting" ? steps[install - 1] : steps[install];
    const t = steps[install];
    engine = shown("Installing engine", looked.started_at, t.ended_at);
    if (engine.state === "current") {
      const so = duration(now - looked.started_at);
      const up = c.upload;
      if (up === null) {
        engine.figure = `${kind === "local" ? "unpacking" : "preparing"} · ${so}`;
      } else if (up.sent >= up.total) {
        engine = { ...engine, figure: `unpacking · ${so}`, meter: 1 };
      } else {
        engine = {
          ...engine,
          figure: `${Math.floor(up.sent / MB)} of ${Math.round(up.total / MB)} MB · ${so}`,
          meter: up.total > 0 ? up.sent / up.total : 0,
        };
      }
    }
  } else if (checking !== undefined || handing !== undefined) {
    engine = { name: "Installing engine", state: "done", figure: "installed" };
  } else if (start !== undefined) {
    engine = { name: "Installing engine", state: "todo", figure: "checking…" };
  } else {
    engine = { name: "Installing engine", state: "todo", figure: "" };
  }

  if (kind === "local") {
    // Hello is part of starting here: from the start to hello's answer.
    const hello = checking ?? handing;
    return [engine, starting(hello === undefined ? start?.ended_at : hello.ended_at)];
  }
  const signing = one("signing_in");
  const adding = one("adding_key");
  // A key added counts from the press, and says so.
  const signedIn = shown(
    "Signing in",
    adding?.started_at ?? signing?.started_at,
    signing?.ended_at,
  );
  if (adding !== undefined) signedIn.figure = `key added · ${signedIn.figure}`;
  return [
    signedIn,
    engine,
    starting(handing === undefined ? start?.ended_at : handing.ended_at),
    shown("Checking scheduler", checking?.started_at, checking?.ended_at),
  ];
}

/** A step from `from` to `to`: not reached without a start, under way without an end. */
function span(
  name: string,
  from: number | undefined,
  to: number | null | undefined,
  now: number,
): StepView {
  if (from === undefined) return { name, state: "todo", figure: "" };
  // A step's time never breaks inside "2 min 42 s" (#449's SF05, SF06).
  const whole = (ms: number) => duration(ms).replace(/ /g, "\u00a0");
  if (to == null) return { name, state: "current", figure: whole(now - from) };
  return { name, state: "done", figure: whole(to - from) };
}

const MB = 1_000_000;

/** "4 s", "1 min 4 s", "2 h 5 min". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${total % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The Settings header's facts line: "McKelvey HPC · connected since 9:12 AM". */
export function settingsFacts(c: ConnectionState, now = Date.now()): string | undefined {
  if (c.status === "none") return undefined;
  const { words } = STATUS_LOOK[c.status];
  if (c.status === "connected" && c.since !== null) {
    return `${c.platform} · ${words} since ${clock(c.since, now)}`;
  }
  return `${c.platform} · ${words}`;
}

/** Home's facts line when it isn't connected, connecting or failed. */
export function homeFacts(c: Connection): string {
  switch (c.status) {
    case "connecting":
      return `Connecting to ${c.platform} · your runs show once it’s connected`;
    case "failed":
      return `Couldn’t connect to ${c.platform} · runs there keep going without the app`;
    default:
      return `Not connected to ${c.platform} · runs there keep going without the app`;
  }
}
