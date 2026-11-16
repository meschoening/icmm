/**
 * The saved platforms, as the Settings page reads and changes them through
 * the desktop's commands. Every change refetches the list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { press } from "../connection/pressed";
import { commands } from "../wire/api.gen";
import type { ChooseParams, PlatformForm, SavedPlatforms } from "../wire/types.gen";

const PLATFORMS = ["platforms"] as const;

export function usePlatforms() {
  return useQuery({ queryKey: PLATFORMS, queryFn: commands.platforms });
}

/** The hosts `~/.ssh/config` names, for the forms' "Fill in from" menu. */
export function useSshConfigHosts() {
  return useQuery({
    queryKey: ["ssh_config_hosts"],
    queryFn: commands.ssh_config_hosts,
    staleTime: 0,
  });
}

export function useSshKeys() {
  return useQuery({
    queryKey: ["ssh_keys"],
    queryFn: commands.ssh_keys,
    staleTime: 0,
  });
}

/**
 * The platform commands; each refetches the list once it settles. Connect,
 * Retry now and Trust and connect press their buttons (`connection/pressed.ts`).
 */
export function usePlatformCommands() {
  const queries = useQueryClient();
  return useMemo(() => {
    const then = <T>(p: Promise<T>) =>
      p.finally(() => void queries.invalidateQueries({ queryKey: PLATFORMS }));
    return {
      add: (form: PlatformForm) => then(commands.add_platform({ form })),
      edit: (id: string, form: PlatformForm) => then(commands.edit_platform({ id, form })),
      remove: (id: string) => then(commands.remove_platform({ id })),
      // Each stays gray until its progress shows in the connection.
      connect: (id: string) =>
        press({ button: "connect", platformId: id }, () => then(commands.connect_platform({ id }))),
      disconnect: () => then(commands.disconnect_platform()),
      retry: () => press({ button: "retry" }, () => commands.retry_connection()),
      trust: (fingerprint: string) =>
        press({ button: "trust" }, () => commands.trust_host_key({ fingerprint })),
      forget: (fingerprint: string) => commands.forget_host_key({ fingerprint }),
      setUpKey: () => commands.set_up_ssh_key(),
      addKey: (password: string) => then(commands.add_ssh_key({ password })),
      useKey: (identity_file: string) => then(commands.use_ssh_key({ identity_file })),
      sshConfigHost: (alias: string) => commands.ssh_config_host({ alias }),
      openLogs: () => commands.open_logs_folder(),
      chooseFile: (p: ChooseParams) => commands.choose_file(p),
      chooseFolder: (p: ChooseParams) => commands.choose_folder(p),
    };
  }, [queries]);
}

/**
 * Sets the platform ICMM connects to when it opens; `null` is Don't connect.
 * The list shows the new choice at once, over any read already on its way,
 * and reads it back once the desktop answers. Choices are saved one at a
 * time, in the order they're made, so the last one is what's kept.
 */
export function useSetLaunch(): (id: string | null) => Promise<unknown> {
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string | null) => commands.set_launch_platform({ id }),
    scope: { id: "set_launch_platform" },
    onMutate: async (id) => {
      await queries.cancelQueries({ queryKey: PLATFORMS });
      queries.setQueryData<SavedPlatforms>(PLATFORMS, (now) =>
        now === undefined ? now : { ...now, launch: id },
      );
    },
    onSettled: () => queries.invalidateQueries({ queryKey: PLATFORMS }),
  });
  return mutation.mutateAsync;
}

export { failureOf, type Failure } from "../failure";
