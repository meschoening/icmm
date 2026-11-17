/**
 * A hint that keeps the room of its longest wording (#469 R04): every wording it may say is laid
 * in the one cell, the one it says shown and the others hidden from sight and from screen readers,
 * so a switch between them never changes its height and moves nothing under it.
 */
export function KeptHint({
  says,
  may,
  className = "hint",
  id,
}: {
  says: string;
  /** Every wording it may say, `says` among them or not. */
  may: string[];
  className?: string;
  /** The id of what it says, for an `aria-describedby`: the shown wording alone. */
  id?: string;
}) {
  const others = [...new Set(may)].filter((m) => m !== says);
  return (
    <span className={`${className} kept`}>
      <span id={id}>{says}</span>
      {others.map((m) => (
        <span key={m} className="kept-room" aria-hidden="true">
          {m}
        </span>
      ))}
    </span>
  );
}
