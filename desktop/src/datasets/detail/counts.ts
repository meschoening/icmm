import type { DatasetSummary } from "../../wire/types.gen";

/** Every protocol and point across `datasets`, for Datasets' facts line. */
export function allDatasetsCount(datasets: DatasetSummary[]): {
  protocols: number;
  points: number;
} {
  let protocols = 0;
  let points = 0;
  for (const d of datasets) {
    protocols += d.protocols.length;
    for (const p of d.protocols) points += p.points;
  }
  return { protocols, points };
}
