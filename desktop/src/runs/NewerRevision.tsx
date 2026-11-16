/**
 * What a run's page says of a revision a newer ICMM saved (#360, RF12):
 * "herg-wt’s revision 4 was saved by a newer ICMM, so start 23’s fit can’t
 * be drawn here. Get the newest ICMM to draw it." Its nouns are its links,
 * each on one line: the revision opens its Dataset detail, unless its
 * dataset is deleted, and Get the newest ICMM the releases page. `so` says
 * what doesn't draw, and `then` what the newest ICMM draws.
 */
import { Link } from "@tanstack/react-router";
import { GetNewest } from "../ui/GetNewest";
import type { Run } from "../wire/types.gen";

export function NewerRevision({
  dataset,
  so,
  then,
}: {
  dataset: Pick<Run["dataset"], "id" | "name" | "revision" | "deleted">;
  so: string;
  then: string;
}) {
  const which = `${dataset.name ?? "Its dataset"}’s revision ${dataset.revision}`;
  return (
    <>
      {dataset.deleted ? (
        which
      ) : (
        <Link to="/datasets/$id" params={{ id: dataset.id }} className="link nw">
          {which}
        </Link>
      )}{" "}
      was saved by a newer ICMM, {so} <GetNewest /> {then}
    </>
  );
}
