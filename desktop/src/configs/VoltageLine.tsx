/**
 * What Voltage dependence bounds make (CF01), on the builder:
 * "Midpoints −60 to +80 mV · widths up to 80 mV", its numbers in
 * mono.
 */
import type { voltageWords } from "./words";

export function VoltageLine({ from, to, width }: NonNullable<ReturnType<typeof voltageWords>>) {
  return (
    <>
      <span className="nw">
        Midpoints <span className="n">{from}</span> to <span className="n">{to}</span>
        {" "}mV
      </span>{" "}
      ·{" "}
      <span className="nw">
        widths up to <span className="n">{width}</span>
        {" "}mV
      </span>
    </>
  );
}
