/** The facts line's points: "57 points, 12 interpolated, 9 validation" or ", no validation". */
export function PointsFacts({
  counts,
}: {
  counts: { points: number; interpolated: number; validation: number };
}) {
  return (
    <>
      <span className="n">{counts.points}</span> {counts.points === 1 ? "point" : "points"}
      {counts.interpolated > 0 && (
        <>
          , <span className="n">{counts.interpolated}</span> interpolated
        </>
      )}
      {counts.validation > 0 ? (
        <>
          , <span className="n">{counts.validation}</span> validation
        </>
      ) : (
        ", no validation"
      )}
    </>
  );
}
