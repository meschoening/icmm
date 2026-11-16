/**
 * The mark of a start **Still improving** at its end (#234): a down arrow,
 * stroked in its parent's color, on Run detail's note and on Topology's
 * squares, legend and Best starts.
 */
export function ImprovingMark({
  className,
  size = 10,
  label,
}: {
  className?: string;
  size?: number;
  /** Its words for a screen reader; without them it's decoration. */
  label?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <path
        d="M5 1.2v7.2M1.9 5.4L5 8.5l3.1-3.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
