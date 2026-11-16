/**
 * Submit run's write (`submit_run`, LaptopSubmitRun): the page's one
 * `request_key`, kept until the run is recorded so a retry is the same
 * request and lands once (ADR-0009).
 *
 * Every failure keeps the key, a refusal as much as a lost answer: the agent
 * records nothing for a submit it refuses, so sending it again with the same
 * key is a new try, and for one whose answer was lost it replays the run that
 * was recorded. Only a success ends the key, since a second press after one is
 * a second run.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { keyFor } from "../requestKey";
import { agentKey, platformOf } from "../setup/queries";
import { getConnection } from "../shell/connection";
import { useWorking, type Working } from "../ui/working";
import { commands } from "../wire/api.gen";

export type SubmitOutcome = { ok: true; run: number } | { ok: false; error: unknown };

export interface SubmitRun {
  working: Working;
  /**
   * Submits the config `configId`, as it was last saved. A press while one
   * works does nothing, and its promise never settles.
   */
  submit: (configId: string) => Promise<SubmitOutcome>;
}

export function useSubmitRun(): SubmitRun {
  const working = useWorking();
  const queries = useQueryClient();
  const last = useRef<{ key: string; body: string } | null>(null);
  const submit = async (configId: string): Promise<SubmitOutcome> => {
    if (working.busy()) return new Promise<SubmitOutcome>(() => {});
    last.current = keyFor(last.current, { config_id: configId });
    const request_key = last.current.key;
    try {
      const { run } = await working.run(() =>
        commands.submit_run({ request_key, config_id: configId }),
      );
      last.current = null;
      // The new run is in flight and is its config's newest.
      const platform = platformOf(getConnection());
      void queries.invalidateQueries({ queryKey: agentKey(platform, "runs") });
      void queries.invalidateQueries({ queryKey: agentKey(platform, "configs") });
      return { ok: true, run };
    } catch (e) {
      return { ok: false, error: e };
    }
  };
  return { working, submit };
}
