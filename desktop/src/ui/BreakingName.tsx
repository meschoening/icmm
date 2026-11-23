/**
 * A protocol's name, which breaks only after `_` or `-` (a hyphen breaks on its own), wherever
 * it's shown: Dataset detail, the Datasets list, and the New dataset wizard's Protocols and
 * Review steps (#528, #560). A name with neither that's still wider than its column breaks where
 * it must. `<wbr>` adds no text, so copying the name gives it as it is.
 *
 * Only a name with neither breaks anywhere: `overflow-wrap: anywhere` would also let a grid or
 * table column shrink below a name's parts, and break it mid-word there.
 */
import { Fragment } from "react";

export function BreakingName({ name }: { name: string }) {
  if (!/[_-]/.test(name)) return <span className="bname-any">{name}</span>;
  const parts = name.split("_");
  return (
    <span className="bname">
      {parts.map((part, i) =>
        i === parts.length - 1 ? (
          part
        ) : (
          <Fragment key={i}>
            {`${part}_`}
            <wbr />
          </Fragment>
        ),
      )}
    </span>
  );
}
