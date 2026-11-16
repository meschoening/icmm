/**
 * Delete…'s question and its write, for a config: the Configs page's, under its head, and
 * Edit config's, under a damaged config's box (#452).
 */
import { useEffect, useRef, useState } from "react";
import { commands } from "../wire/api.gen";
import { DeleteAsk } from "./DeleteAsk";
import { useConfigWrite } from "./write";

/**
 * Delete…'s question and its write, for a config by `id`. `sent`: a delete
 * went out, so the config turning up gone is this page's delete landing,
 * though its answer was lost, not another computer's. `more` is the button
 * Keep it gives focus back to: ⋯ here, Delete config… on Edit config (#452).
 */
export function useDelete(id: string, name: string, platform: string, onDeleted: () => void) {
  const write = useConfigWrite(platform);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // One config's: a page that goes on to another (Edit config, by ⌘K) asks afresh, and the
  // first one's answer, when it comes, takes the page nowhere (#452).
  const [forId, setForId] = useState(id);
  if (forId !== id) {
    setForId(id);
    setAsking(false);
    setSent(false);
    write.setMessage(undefined);
  }
  const on = useRef(id);
  useEffect(() => {
    on.current = id;
  });
  const alive = useRef(true);
  useEffect(() => {
    // Set again on each mount: StrictMode mounts twice.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const keep = () => {
    setAsking(false);
    write.setMessage(undefined);
    setTimeout(() => more.current?.focus());
  };
  const remove = async () => {
    setSent(true);
    const done = await write.run(
      { id },
      (key) => commands.delete_config({ request_key: key, id }),
      { happened: `${name} deleted`, again: "Deleting" },
    );
    // Deleted here or elsewhere first, it's gone either way.
    if ((done.ok || done.code === "not_found") && alive.current && on.current === id) onDeleted();
  };
  const ask = asking ? (
    <DeleteAsk
      id={id}
      name={name}
      working={write.working}
      message={write.message}
      onKeep={keep}
      onDelete={() => void remove()}
    />
  ) : null;
  return { ask, open: () => setAsking(true), more, working: write.working, sent };
}
