/**
 * A run's config as Export its config… writes it (#344, #336 decision 10):
 * the settings the run recorded at submit, in the config format (ADR-0016),
 * with its dataset's name beside the id the config names it by, since an id
 * says nothing to a reader. Its Search seed is the one the run fit with,
 * drawn at submit where the config had none, so the file fits it again
 * (RF13, #368). Nothing imports it.
 */
import type { Config, RunDataset } from "../wire/types.gen";

export function configJson(settings: Config, dataset: RunDataset, seed: number): string {
  const { dataset_id, ...rest } = settings;
  const { format, name, ...after } = rest;
  const search = { ...after.search, search_seed: seed };
  return (
    JSON.stringify(
      { format, name, dataset_id, dataset_name: dataset.name, ...after, search },
      null,
      2,
    ) + "\n"
  );
}
