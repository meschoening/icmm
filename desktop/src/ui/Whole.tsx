/**
 * Text whose hyphenated identifiers, an account like `lab-account` or a partition like
 * `general-cpu`, never break at their own hyphens (#449's SF05). They stay as typed, so a copy
 * of one is the name itself: kept whole by `nowrap`, not by look-alike hyphens.
 */
export function Whole({ text }: { text: string }) {
  const parts = text.split(/(\S*\w-\w\S*)/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="nw">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
