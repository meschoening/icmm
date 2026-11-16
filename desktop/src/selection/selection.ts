/**
 * The session's selection (#336, decision 9): the starts Results' ticks and
 * a start's page's Compare with… choose, for Compare and New config from
 * these…. There's one for the app's session on each platform, since starts
 * are a platform's: it survives a change of page or dataset (P9), and goes
 * when the app quits. Results, a start's page and Compare all show it, in
 * `SelectionBar`.
 *
 * A pick is a start, `#211/T12.0 · start 37`: Results adds a topology's
 * Best start, and a start's page itself, so two of one topology's starts
 * can both be picked (decision 5). The selection has no cap; Compare holds
 * 3, and a config fits one dataset and one number of states (decision 6).
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useConnection } from "../shell/connection";

export interface SelectedStart {
  run: number;
  graph: number;
  open_state: number;
  start: number;
  /** Its run's dataset: a chip names it where the page shows another. */
  dataset: { id: string; name: string | null };
  /** Its run's number of states: a config fits one. */
  num_states: number;
}

/** How many starts Compare holds (decision 5). */
export const COMPARE_HOLDS = 3;

/** `T12.0`: the topology's id in its run. */
export const topologyOf = (p: SelectedStart) => `T${p.graph}.${p.open_state}`;

/** `211/T12.0/37`: a pick's key, as its start's page's path has it. */
export const pickKey = (p: SelectedStart) => `${p.run}/${topologyOf(p)}/${p.start}`;

/** `#211/T12.0 · start 37`. */
export const pickName = (p: SelectedStart) => `#${p.run}/${topologyOf(p)} · start ${p.start}`;

/** A dataset's name in a sentence, or its id where the platform never named it. */
export const datasetName = (p: SelectedStart) => p.dataset.name ?? p.dataset.id;

/** "a, b and c". */
function and(words: string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Why Compare can't open these: more than it holds, said as how many to remove. */
export function compareWhy(picks: readonly SelectedStart[]): string | undefined {
  const over = picks.length - COMPARE_HOLDS;
  if (over <= 0) return undefined;
  return `Compare holds ${COMPARE_HOLDS}. Remove ${over === 1 ? "one" : over} first.`;
}

/** Why one config can't fit these: they're on several datasets, or numbers of states. */
export function configWhy(picks: readonly SelectedStart[]): string | undefined {
  // By id: a dataset renamed between picks is one, and a deleted one's namesake another.
  const datasets = new Map(picks.map((p) => [p.dataset.id, datasetName(p)]));
  if (datasets.size > 1) {
    return `A config fits one dataset: these are on ${and([...datasets.values()])}.`;
  }
  const states = [...new Set(picks.map((p) => p.num_states))].sort((a, b) => a - b);
  if (states.length > 1) {
    return `A config fits one number of states: these have ${and(states.map(String))}.`;
  }
  return undefined;
}

const NONE: readonly SelectedStart[] = Object.freeze([]);

/** Each platform's selection, by its id, and who to tell when one changes. */
export class SelectionStore {
  private byPlatform = new Map<string, readonly SelectedStart[]>();
  private listeners = new Set<() => void>();

  picks(platform: string): readonly SelectedStart[] {
    return this.byPlatform.get(platform) ?? NONE;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds `pick`, or takes it out if it's held. */
  toggle(platform: string, pick: SelectedStart): void {
    const held = this.picks(platform);
    const key = pickKey(pick);
    this.set(
      platform,
      held.some((p) => pickKey(p) === key)
        ? held.filter((p) => pickKey(p) !== key)
        : [...held, pick],
    );
  }

  /** Adds each of `picks` it doesn't hold, after those it does. */
  add(platform: string, picks: readonly SelectedStart[]): void {
    const held = this.picks(platform);
    const keys = new Set(held.map(pickKey));
    const added = picks.filter((p) => {
      const key = pickKey(p);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (added.length > 0) this.set(platform, [...held, ...added]);
  }

  /** Puts `picks` first, in their order, with those it held before behind them (⌘K's Compare the best of…). */
  lead(platform: string, picks: readonly SelectedStart[]): void {
    const keys = new Set<string>();
    const led = [...picks, ...this.picks(platform)].filter((p) => {
      const key = pickKey(p);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    this.set(platform, led);
  }

  /** Takes out the picks with these keys. */
  remove(platform: string, keys: readonly string[]): void {
    const held = this.picks(platform);
    const gone = new Set(keys);
    const kept = held.filter((p) => !gone.has(pickKey(p)));
    if (kept.length !== held.length) this.set(platform, kept);
  }

  clear(platform: string): void {
    if (this.picks(platform).length > 0) this.set(platform, NONE);
  }

  /** Forgets every platform's selection: the app's session starting again (tests). */
  forget(): void {
    this.byPlatform.clear();
    for (const listener of this.listeners) listener();
  }

  private set(platform: string, picks: readonly SelectedStart[]): void {
    this.byPlatform.set(platform, Object.freeze(picks));
    for (const listener of this.listeners) listener();
  }
}

/** The app's session's selections. */
export const selections = new SelectionStore();

export interface Selection {
  picks: readonly SelectedStart[];
  /** Whether it holds the start with this key. */
  has: (key: string) => boolean;
  toggle: (pick: SelectedStart) => void;
  add: (picks: readonly SelectedStart[]) => void;
  remove: (keys: readonly string[]) => void;
  clear: () => void;
}

/** The Active platform's selection: none, and nothing to change, with no platform. */
export function useSelection(): Selection {
  const c = useConnection();
  const platform = c.status === "none" ? "" : c.platformId;
  const picks = useSyncExternalStore(
    useCallback((listener: () => void) => selections.subscribe(listener), []),
    () => selections.picks(platform),
  );
  const keys = useMemo(() => new Set(picks.map(pickKey)), [picks]);
  return useMemo(
    () => ({
      picks,
      has: (key: string) => keys.has(key),
      toggle: (pick: SelectedStart) => platform !== "" && selections.toggle(platform, pick),
      add: (more: readonly SelectedStart[]) => platform !== "" && selections.add(platform, more),
      remove: (gone: readonly string[]) => platform !== "" && selections.remove(platform, gone),
      clear: () => platform !== "" && selections.clear(platform),
    }),
    [picks, keys, platform],
  );
}
