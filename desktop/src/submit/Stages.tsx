/**
 * "What happens after you submit" (LaptopSubmitRun): the run's four stages,
 * closed until opened. Each stage is a name and what is done in it.
 */
import type { Stage } from "./plan";

export function Stages({ stages }: { stages: Stage[] }) {
  return (
    <details className="sub-stages">
      <summary className="sub-stages-sum">
        {/* The board's chevron: it stays as drawn, open or shut. */}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m4.5 3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="sub-stages-name">What happens after you submit</span>
        <span className="mono sub-stages-count">{stages.length} stages</span>
      </summary>
      <ol className="sub-stages-list">
        {stages.map(([name, what]) => (
          <li key={name} className="sub-stage">
            <span className="sub-rail" aria-hidden="true">
              <span className="sub-node" />
              <span className="sub-line" />
            </span>
            <span className="sub-stage-text">
              <span className="mono sub-stage-name">{name}</span>
              <span className="sub-stage-what">{what}</span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
