import type { ReactNode } from "react";
import type { UnreadableError } from "../wire/types.gen";
import { unreadableConfigWords } from "./words";

/**
 * Why ICMM can't read a config, in the three-line box: a newer ICMM's
 * names this ICMM's version and says what to do (CF16); any other, the
 * agent's sentence, and a damaged one what to do (#452). `next` replaces the
 * second line where the page offers another way (Submit run's Change…), and
 * `children` are the box's buttons, at its bottom right.
 */
export function UnreadableBox({
  name,
  error,
  next,
  children,
}: {
  name: string;
  error: UnreadableError;
  next?: ReactNode;
  children?: ReactNode;
}) {
  const say = unreadableConfigWords(name, error);
  const second = next ?? say.next;
  return (
    <div className="fail-box" role="alert">
      <div className="fail-say">
        <p className="fail-what">{say.what}</p>
        {second !== undefined && <p className="fail-next">{second}</p>}
        <p className="term fail-raw">unreadable · {error.data.details}</p>
      </div>
      {children !== undefined && <div className="fail-actions">{children}</div>}
    </div>
  );
}
