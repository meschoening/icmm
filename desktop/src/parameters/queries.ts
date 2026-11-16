/**
 * A topology's parameters as shown (#287): the raw best vectors the agent
 * reads, made canonical by this computer's own engine whatever the Active
 * platform (ADR-0007, ADR-0013), with the topology's edges and the range each
 * value can take in the run's box. Nothing here needs the connection, so what
 * it drew stays while the platform is away.
 */
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { commands } from "../wire/api.gen";
import type { Bounds, CanonicalParameters, ParameterRange, WireError } from "../wire/types.gen";

/** The most vectors one call sends (`MAX_VECTORS`): more go in parts. */
const PER_CALL = 1000;

/** What to make canonical: `items`' raw vectors, each item a start or whatever holds one. */
export interface CanonicalAsk<T> {
  numStates: number;
  graph: number;
  openState: number;
  bounds: Bounds;
  items: readonly T[];
  /** An item's raw vector, as the runs database stores it. */
  raw: (item: T) => readonly number[];
}

export type Canonical<T> =
  | { kind: "pending" }
  | { kind: "failed"; error: WireError; retry: () => Promise<unknown> }
  | {
      kind: "shown";
      /** Each lower state first, in the order of their parameters. */
      edges: number[][];
      ranges: ParameterRange[];
      /** Each item asked, with its values as shown. */
      shown: { item: T; values: number[] }[];
    };

/** Every part's answer as one: the vectors in the order asked, not yet paired with items. */
type Answered =
  Exclude<Canonical<never>, { kind: "shown" }> | ({ kind: "shown" } & CanonicalParameters);

/**
 * `ask`'s items as shown, once every part has answered. While a changed ask
 * of the same topology is drawn, such as a start that just finished, the
 * items last drawn stay, so the rows don't empty and fill again.
 */
export function useCanonicalParameters<T>(ask: CanonicalAsk<T> | undefined): Canonical<T> {
  const items = ask?.items ?? [];
  const parts = Array.from({ length: Math.max(1, Math.ceil(items.length / PER_CALL)) }, (_, i) =>
    items.slice(i * PER_CALL, (i + 1) * PER_CALL),
  );
  const topology =
    ask === undefined
      ? undefined
      : JSON.stringify([ask.numStates, ask.graph, ask.openState, ask.bounds]);
  const now = useQueries({
    queries: parts.map((part) => {
      const vectors = part.map((item) => [...ask!.raw(item)]);
      return {
        queryKey: ["host", "canonical_parameters", topology, vectors],
        queryFn: () =>
          commands.canonical_parameters({
            num_states: ask!.numStates,
            graph: ask!.graph,
            open_state: ask!.openState,
            bounds: ask!.bounds,
            vectors,
          }),
        enabled: ask !== undefined,
        staleTime: Infinity,
        retry: false,
      };
    }),
    // Module-level, so stable: the answer is the same object until a result changes.
    combine: combined,
  });
  // The cache holds only the engine's answer, so another page asking for the same vectors
  // pairs them with its own items.
  const [kept, setKept] = useState<{ topology: string; answer: Answered; items: readonly T[] }>();
  if (now.kind === "shown" && topology !== undefined && kept?.answer !== now) {
    setKept({ topology, answer: now, items });
  }
  const held = now.kind === "pending" && kept !== undefined && kept.topology === topology;
  const answer = held ? kept.answer : now;
  const asked = held ? kept.items : items;
  return useMemo(
    () =>
      answer.kind !== "shown"
        ? answer
        : {
            kind: "shown",
            edges: answer.edges,
            ranges: answer.ranges,
            shown: answer.vectors.map((values, i) => ({ item: asked[i], values })),
          },
    [answer, asked],
  );
}

/** Every part's answer as one, the first failure, or pending while a part is. */
function combined(results: UseQueryResult<CanonicalParameters, Error>[]): Answered {
  const failed = results.find((r) => r.isError);
  if (failed !== undefined) {
    return {
      kind: "failed",
      error: failed.error as unknown as WireError,
      retry: () => Promise.all(results.filter((r) => r.isError).map((r) => r.refetch())),
    };
  }
  if (results.some((r) => r.data === undefined)) return { kind: "pending" };
  const answers = results.map((r) => r.data!);
  return {
    kind: "shown",
    edges: answers[0].edges,
    ranges: answers[0].ranges,
    vectors: answers.flatMap((a) => a.vectors),
  };
}
