/**
 * What the Dataset wizard asks the Active platform's agent: the names its
 * datasets have (so a name can be checked as it's typed), and
 * `validate_dataset`'s issues with the draft as it changes (ADR-0003).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { agentKey, canAsk } from "../setup/queries";
import { useConnection, type ConnectionState } from "../shell/connection";
import { commands } from "../wire/api.gen";
import type { DatasetContent, DatasetSummary } from "../wire/types.gen";

const platformOf = (c: ConnectionState) => (c.status === "none" ? "" : c.platformId);

/** Every dataset on the Active platform, all pages; the change feed's `datasets` reads it again. */
export function useDatasets() {
  const c = useConnection();
  return useQuery({
    queryKey: agentKey(platformOf(c), "datasets", "all"),
    queryFn: allDatasets,
    enabled: canAsk(c),
  });
}

/** Every dataset on the Active platform, newest Modified first (DS12).
 * The agent pages by immutable first-save time so concurrent edits cannot skip rows.
 */
export async function allDatasets(): Promise<DatasetSummary[]> {
  const all: DatasetSummary[] = [];
  let after: string | null = null;
  do {
    const page = await commands.list_datasets({ after });
    all.push(...page.datasets);
    after = page.next;
  } while (after !== null);
  return all.sort(
    (a, b) => b.modified_at.localeCompare(a.modified_at) || b.id.localeCompare(a.id),
  );
}

/** The dataset named `name` ignoring case, if the platform has one. */
export function named(datasets: DatasetSummary[], name: string): DatasetSummary | undefined {
  const key = name.toLowerCase();
  return datasets.find((d) => d.name.toLowerCase() === key);
}

/** How long typing pauses before the draft is checked. */
export const CHECK_AFTER_MS = 250;

/**
 * `validate_dataset`'s issues with `content`, and each protocol's template,
 * a moment after it stops changing; the last answer stays until the next,
 * so issues don't flicker. `undefined` until one comes, or while the agent
 * can't be asked. `current` says the answer is for `content` as it is now.
 * `id` is the saved dataset it's a change to, whose own name is no clash.
 */
export function useDatasetIssues(content: DatasetContent | null, id: string | null = null) {
  const c = useConnection();
  const body = content === null ? null : JSON.stringify(content);
  const [settled, setSettled] = useState(body);
  useEffect(() => {
    const t = setTimeout(() => setSettled(body), CHECK_AFTER_MS);
    return () => clearTimeout(t);
  }, [body]);
  const q = useQuery({
    // Under `datasets`, so a dataset another computer saves checks the name again.
    queryKey: agentKey(platformOf(c), "datasets", "validate", id, settled),
    queryFn: () =>
      commands.validate_dataset({ id, content: JSON.parse(settled!) as DatasetContent }),
    enabled: settled !== null && canAsk(c),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const checking = settled !== body || q.isFetching;
  return {
    issues: q.data?.issues,
    templates: q.data?.templates,
    checking,
    current: !checking && !q.isPlaceholderData && q.data !== undefined,
  };
}
