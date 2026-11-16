/**
 * The SSH key menu both platform forms share: the private keys in `~/.ssh`,
 * the platform's own key when it isn't among them, and "Choose a file…",
 * which opens the OS's file dialog.
 */
import type { SelectHTMLAttributes } from "react";
import { usePlatformCommands, useSshKeys } from "./commands";
import { CHOOSE } from "./sshFields";

export type SshKeySelectProps = {
  /** The key shown and sent; `""` for any of the usual keys. */
  value: string;
  onChange: (key: string) => void;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">;

export function SshKeySelect({ value, onChange, ...rest }: SshKeySelectProps) {
  const keys = useSshKeys();
  const commands = usePlatformCommands();
  const options = [...(keys.data?.keys ?? [])];
  if (value !== "" && !options.includes(value)) options.push(value);

  const pick = async (chosen: string) => {
    if (chosen !== CHOOSE) {
      onChange(chosen);
      return;
    }
    const file = await commands.chooseFile({ title: "Choose an SSH key", folder: "~/.ssh" });
    if (file.path !== null) onChange(file.path);
  };

  return (
    <select {...rest} value={value} onChange={(e) => void pick(e.target.value)}>
      {value === "" && (
        <option value="">
          {options.length > 0 ? "Any of the usual keys" : "No keys in ~/.ssh"}
        </option>
      )}
      {options.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
      <option value={CHOOSE}>Choose a file…</option>
    </select>
  );
}
