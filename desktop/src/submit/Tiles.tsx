/**
 * Submit run's four tiles (LaptopSubmitRun): the work, its time, when it begins
 * and what it writes, each as a few words (`plan.ts` says them). Shown once the
 * config's settings are read.
 */
import type { Tile } from "./plan";

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <section className="sub-tiles" aria-label="This run">
      {tiles.map((t) => {
        const id = `sub-tile-${t.name.toLowerCase()}`;
        return (
          <div key={t.name} className="sub-tile" role="group" aria-labelledby={id}>
            <span id={id} className="label">
              {t.name}
            </span>
            <span className="sub-tile-main">
              {t.glyph !== undefined && <span className={`g g-${t.glyph}`} aria-hidden="true" />}
              <span className={t.mono ? "sub-big sub-big-mono" : "sub-big"}>{t.big}</span>
              {/* Not drawn in a flex row, but read between the two. */}
              {t.unit !== undefined && (
                <>
                  {" "}
                  <span className="sub-unit">{t.unit}</span>
                </>
              )}
            </span>
            {t.past !== undefined ? (
              <span className="sub-warn sub-tile-hint">
                <span className="g g-failed" aria-hidden="true" />
                <span>{t.past}</span>
              </span>
            ) : (
              <span className="hint sub-tile-hint">{t.hint}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}
