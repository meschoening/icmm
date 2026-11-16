/**
 * "recoveryE and tauE", each name in mono: protocols named inside a sentence, as the Start
 * page's Drift box and Compare's drift line have them (#360, #453).
 */
import { Fragment } from "react";

export function ProtocolNames({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, i) => (
        <Fragment key={name}>
          {i === 0 ? "" : i === names.length - 1 ? " and " : ", "}
          <span className="mono">{name}</span>
        </Fragment>
      ))}
    </>
  );
}
