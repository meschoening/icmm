/**
 * "earlier data" on Home's cards (#398, HF09): a hover word that says which
 * revision the run fit and which one is current. Each card is a link, so the
 * word is no second Tab stop: the card names its tooltip (`HoverWord`).
 */
import { useDatasets } from "../datasets/queries";
import { useTooltip, type Tooltip } from "../ui/Tooltip";
import type { RunDataset } from "../wire/types.gen";
import { earlierTip } from "./ended";

/** The tooltip "earlier data" opens, for the card's `aria-describedby`; none on current data. */
export function useEarlierTip(d: RunDataset): Tooltip | undefined {
  const current = useDatasets().data?.find((x) => x.id === d.id)?.revision;
  const tip = useTooltip(d.earlier ? earlierTip(d, current) : undefined);
  return d.earlier ? tip : undefined;
}
