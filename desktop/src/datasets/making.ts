/**
 * Making protocols' points on this computer's engine (ADR-0013): each
 * protocol whose measured points or live interpolation settings changed is
 * interpolated afresh and its split proposed again (`regenerate_dataset`,
 * ADR-0011), and Redraw proposes one protocol's split again
 * (`propose_split`), each at the protocol's own validation share (#166).
 * What's made goes to the caller, who keeps it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../wire/api.gen";
import type { Protocol, WireError } from "../wire/types.gen";
import type { Made } from "./points";

/** A protocol to make: its measured points and interpolation settings, keyed as `keyOf` keys them. */
export interface ToMake {
  id: string;
  key: string;
  protocol: Protocol;
}

export interface Making {
  /** The protocols whose points are being made. */
  pending: ReadonlySet<string>;
  /**
   * The protocols the engine couldn't make, with what it said. An `invalid`
   * answer's issues are `validate_dataset`'s too, so they show there.
   */
  failed: ReadonlyMap<string, Partial<WireError>>;
  /** Tries a failed protocol again. */
  retry: (id: string) => void;
}

/**
 * Makes each of `wanted` whose `made` is for another key, one call each.
 * A protocol back at the key of its `kept` points, as saved, gets them back
 * with their marks rather than a fresh proposal.
 */
export function useMaking(
  dataset: string,
  wanted: ToMake[],
  made: Readonly<Record<string, Made | undefined>>,
  onMade: (id: string, made: Made) => void,
  kept: Readonly<Record<string, Made | undefined>> = {},
): Making {
  /** The key each protocol is being made for. */
  const flying = useRef(new Map<string, string>());
  const [failed, setFailed] = useState(
    () => new Map<string, { key: string; error: Partial<WireError> }>(),
  );
  const latest = useRef(new Map<string, string>());
  const onMadeRef = useRef(onMade);
  useEffect(() => {
    onMadeRef.current = onMade;
  });
  // A protocol is being made while what's made is for another key, and the engine hasn't failed it.
  const due = wanted.filter((w) => made[w.id]?.key !== w.key && failed.get(w.id)?.key !== w.key);
  const pending: ReadonlySet<string> = new Set(due.map((w) => w.id));
  const signature = JSON.stringify(due.map((w) => [w.id, w.key]));
  useEffect(() => {
    latest.current = new Map(wanted.map((w) => [w.id, w.key]));
    for (const w of due) {
      const back = kept[w.id];
      if (back?.key === w.key) {
        // Whatever was being made for another key is moot now.
        flying.current.delete(w.id);
        onMadeRef.current(w.id, back);
        continue;
      }
      if (flying.current.get(w.id) === w.key) continue;
      flying.current.set(w.id, w.key);
      const settle = () => {
        if (flying.current.get(w.id) === w.key) flying.current.delete(w.id);
      };
      commands
        .regenerate_dataset({ before: null, after: { name: dataset, protocols: [w.protocol] } })
        .then((answer) => {
          if (latest.current.get(w.id) === w.key) {
            onMadeRef.current(w.id, {
              key: w.key,
              interpolation: w.protocol.interpolation,
              share: w.protocol.validation_share,
              points: answer.protocols[0].points,
            });
          }
          settle();
        })
        .catch((error: Partial<WireError>) => {
          if (latest.current.get(w.id) === w.key) {
            setFailed((was) => new Map(was).set(w.id, { key: w.key, error }));
          }
          settle();
        });
    }
    // `due` is in `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const retry = useCallback((id: string) => {
    setFailed((was) => {
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  }, []);
  const showing = new Map<string, Partial<WireError>>();
  for (const w of wanted) {
    const f = failed.get(w.id);
    if (f !== undefined && f.key === w.key && made[w.id]?.key !== w.key) showing.set(w.id, f.error);
  }
  return { pending, failed: showing, retry };
}

/** Redraw: `protocol`'s split proposed afresh at its share on this computer's engine, as made points. */
export async function redrawn(protocol: Protocol, made: Made): Promise<Made> {
  const answer = await commands.propose_split({ protocol: { ...protocol, points: made.points } });
  return { ...made, points: answer.points, picked: false };
}

/**
 * Redraw's press: its proposal shows in the chart, so its button has no
 * working state but is gray from the press until the proposal lands
 * (`ui/gray.ts`), and a press then does nothing. What a failure said stays
 * until the next press.
 */
export function useRedraw(redraw: () => Promise<void>) {
  const busy = useRef(false);
  const [gray, setGray] = useState(false);
  const [error, setError] = useState<Partial<WireError>>();
  const press = async () => {
    if (busy.current) return;
    busy.current = true;
    setGray(true);
    setError(undefined);
    try {
      await redraw();
    } catch (e) {
      setError(e as Partial<WireError>);
    } finally {
      busy.current = false;
      setGray(false);
    }
  };
  return { gray, error, press };
}
