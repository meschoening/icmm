import type { ReactNode } from "react";

/**
 * A list page's facts line while its read is under way (#445, SF08): the dots
 * and "Reading the configs on McKelvey HPC…" where the facts land, so the
 * head holds its height and its buttons stay put. `action` sits at its end
 * (Home's Try again once it's slow).
 *
 * Every list page (Home, Datasets, Configs, Runs, Results) and Edit config
 * always draws its facts line: the facts, or this, or the state in its own
 * short words ("Couldn’t read the configs", "Not connected to McKelvey HPC",
 * "None on McKelvey HPC yet") as a plain `p.facts`.
 */
export function ReadingFacts({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p className="facts f-read" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{children}</span>
      {action}
    </p>
  );
}

/** A list page with nothing on its platform yet: Runs' dashed card, its prose capped (SF14). */
export function ListEmpty({ children }: { children: ReactNode }) {
  return <div className="list-empty">{children}</div>;
}
