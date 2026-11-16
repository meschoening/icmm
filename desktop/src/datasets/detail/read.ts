/**
 * Dataset detail's read: the dataset's current revision from the Active
 * platform's agent. The change feed's `datasets` reads it again, so another
 * computer's save shows at once, and a delete comes back as `not_found`.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { allDatasets } from "../queries";
import { agentKey, canAsk } from "../../setup/queries";
import { useConnection, type ConnectionState } from "../../shell/connection";
import { commands } from "../../wire/api.gen";
import { usePlatforms } from "../../settings/commands";
import type { DatasetSummary, SavedPlatform } from "../../wire/types.gen";

const platformOf = (c: ConnectionState) => (c.status === "none" ? "" : c.platformId);

/** Where the dataset's read is kept: under `datasets`, which the change feed reads again. */
export const datasetKey = (c: ConnectionState, id: string) =>
  agentKey(platformOf(c), "datasets", "one", id);

export function useDataset(id: string) {
  const c = useConnection();
  return useQuery({
    queryKey: datasetKey(c, id),
    queryFn: () => commands.read_dataset({ id }),
    enabled: canAsk(c),
  });
}

/**
 * The dataset as Datasets lists it, while `wanted`: its name and facts
 * while it's read, or when it can't be. Datasets' own list serves, so a
 * page opened from it asks nothing more.
 */
export function useListed(id: string, wanted: boolean): DatasetSummary | undefined {
  const c = useConnection();
  const q = useQuery({
    queryKey: agentKey(platformOf(c), "datasets", "all"),
    queryFn: allDatasets,
    enabled: wanted && canAsk(c),
  });
  return q.data?.find((d) => d.id === id);
}

/**
 * The Active platform as a failure or a sentence names it: its saved entry,
 * else the connection's name for it; `undefined` with none.
 */
export function useActivePlatform(): Pick<SavedPlatform, "type" | "name"> | undefined {
  const c = useConnection();
  const platforms = usePlatforms();
  if (c.status === "none") return undefined;
  const saved = platforms.data?.platforms.find((p) => p.id === c.platformId);
  return saved ?? { type: "ssh", name: c.platform };
}

/**
 * A read's last failure, kept while it's read again. A query without data
 * forgets its error as it refetches, so each change the feed reports would
 * otherwise swap the failure for the reading line and back, moving focus
 * and announcing the box again. `settled`: the read has data, or can't be
 * asked, so nothing is kept.
 */
export function useHeldFailure<E>(
  failure: E | undefined,
  fetching: boolean,
  key: string,
  settled: boolean,
): E | undefined {
  const [held, setHeld] = useState<{ key: string; failure: E }>();
  // Settled first: holding a failure it then drops would set it again at every render.
  if (settled) {
    if (held !== undefined) setHeld(undefined);
  } else if (failure !== undefined && (held?.failure !== failure || held.key !== key)) {
    setHeld({ key, failure });
  }
  if (failure !== undefined) return failure;
  return fetching && !settled && held?.key === key ? held.failure : undefined;
}
