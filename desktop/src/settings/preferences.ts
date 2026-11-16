/**
 * This computer's theme and notification choices, as Settings' General
 * section reads and changes them. A change applies at once, before the
 * desktop has saved it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "../wire/api.gen";
import type { Preferences } from "../wire/types.gen";

export const PREFERENCES = ["preferences"] as const;

export function usePreferences() {
  return useQuery({ queryKey: PREFERENCES, queryFn: commands.preferences });
}

/**
 * Saves the preferences: the page shows them at once, over any read on its
 * way, and reads them back once the desktop answers. Saves go one at a
 * time, in the order they're made, so the last is what's kept.
 */
export function useSetPreferences(): (preferences: Preferences) => Promise<unknown> {
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: (preferences: Preferences) => commands.set_preferences(preferences),
    scope: { id: "set_preferences" },
    onMutate: async (preferences) => {
      await queries.cancelQueries({ queryKey: PREFERENCES });
      queries.setQueryData<Preferences>(PREFERENCES, preferences);
    },
    onSettled: () => queries.invalidateQueries({ queryKey: PREFERENCES }),
  });
  return mutation.mutateAsync;
}
