/**
 * What Configs asks the Active platform's agent: its configs, newest
 * modified first, those that name a dataset (Dataset detail's), one of
 * them as it was last saved, and a config's topology counts from
 * the engine's lists. Each is kept under `configs`, which the change feed
 * reads again; a dataset's change reads them again too, since each names
 * its dataset as it is now (`useAgentDataFollowsChanges`).
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { CHECK_AFTER_MS } from "../datasets/queries";
import { agentKey, canAsk } from "../setup/queries";
import { useConnection, type ConnectionState } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { Config, ConfigCheck, ConfigSummary, WireError } from "../wire/types.gen";

const platformOf = (c: ConnectionState) => (c.status === "none" ? "" : c.platformId);

/** Where a config's read is kept: under `configs`, which the change feed reads again. */
export const configKey = (c: ConnectionState, id: string) =>
  agentKey(platformOf(c), "configs", "one", id);

/** Every config on the Active platform, all pages. */
export function useConfigs() {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "configs", "all"),
    queryFn: allConfigs,
    enabled: canAsk(c),
  });
}

/** How many times a listing starts again when configs change faster than it pages. */
const RESTARTS = 3;

/**
 * Every config on the Active platform, newest modified first, as the first
 * page found them. A listing the configs outran (`stale_cursor`) starts again
 * from the first page.
 */
export async function allConfigs(): Promise<ConfigSummary[]> {
  for (let tries = 0; ; tries++) {
    const all: ConfigSummary[] = [];
    let after: string | null = null;
    try {
      do {
        const page = await commands.list_configs({ after });
        all.push(...page.configs);
        after = page.next;
      } while (after !== null);
      return all;
    } catch (error) {
      const e = error as Partial<WireError> & { data?: { reason?: string } };
      if (tries >= RESTARTS || e.code !== "conflict" || e.data?.reason !== "stale_cursor") {
        throw error;
      }
    }
  }
}

export function useConfig(id: string | undefined) {
  const c = useConnection();
  return useQuery({
    queryKey: configKey(c, id ?? ""),
    queryFn: () => commands.read_config({ id: id! }),
    enabled: id !== undefined && canAsk(c),
  });
}

/**
 * The configs that name the dataset `id`, by id, newest modified first (none
 * without an `id`): the list Configs reads, so Dataset detail's section, its facts and Delete's
 * count agree with Configs and with each other.
 */
export function useDatasetConfigs(id: string | undefined) {
  const c = useConnection();
  const naming = useCallback(
    (all: ConfigSummary[]) => all.filter((x) => x.dataset.id === id),
    [id],
  );
  return useQuery({
    queryKey: agentKey(platformOf(c), "configs", "all"),
    queryFn: allConfigs,
    enabled: canAsk(c),
    select: naming,
  });
}

/**
 * The engine's counts for a saved config: its number of states' topologies
 * and state graphs, what each Specific ID fits, and its per-start file size.
 * The counts follow from the engine’s lists; file sizes also use the dataset’s
 * current protocol count, so dataset changes invalidate the cached answer.
 */
export function useTopologyCounts(config: Config | undefined) {
  const c = useConnection();
  const body = config === undefined ? null : JSON.stringify(config);
  return useQuery({
    queryKey: agentKey(platformOf(c), "validate_config", body),
    queryFn: () => commands.validate_config({ config: JSON.parse(body!) as Config }),
    enabled: body !== null && canAsk(c),
    staleTime: Infinity,
  });
}

/** Where validation is kept: dataset changes invalidate its protocol-dependent estimates. */
const checkKey = (c: ConnectionState, body: string) =>
  agentKey(platformOf(c), "validate_config", body);

/** `validate_config`'s answer, and the config it's for, as JSON. */
export interface Answered {
  body: string;
  check: ConfigCheck;
}

/**
 * `validate_config`'s answer for the Config builder's `config`, a moment
 * after it stops changing; the last answer stays until the next, so issues
 * don't flicker (`answered`, with the config it's for). `current` says it's
 * for `config` as it is now.
 */
export function useConfigCheck(config: Config) {
  const c = useConnection();
  const body = JSON.stringify(config);
  const [settled, setSettled] = useState(body);
  useEffect(() => {
    const t = setTimeout(() => setSettled(body), CHECK_AFTER_MS);
    return () => clearTimeout(t);
  }, [body]);
  const q = useQuery({
    queryKey: checkKey(c, settled),
    queryFn: () => commands.validate_config({ config: JSON.parse(settled) as Config }),
    enabled: canAsk(c),
    staleTime: Infinity,
  });
  const [answered, setAnswered] = useState<Answered>();
  if (q.data !== undefined && answered?.check !== q.data) {
    setAnswered({ body: settled, check: q.data });
  }
  return { answered, body, current: answered?.body === body };
}
