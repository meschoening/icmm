/** What a failed command said, as a form shows it. */
import type { WireError } from "./wire/types.gen";

/** Each field's issue, and a sentence for the rest. */
export interface Failure {
  fields: Record<string, string>;
  message: string | undefined;
}

/** A platform form's field, from an issue's path: `["form", <field>]`. */
function formField(path: string[]): string | undefined {
  const [top, field] = path;
  return top === "form" && field !== undefined && field !== "type" ? field : undefined;
}

/**
 * What a failed command said: an `invalid` answer's issues on the fields
 * `fieldOf` finds for their paths (a platform form's by default), and a
 * sentence for the rest; any other failure is its sentence.
 */
export function failureOf(
  error: unknown,
  fieldOf: (path: string[]) => string | undefined = formField,
): Failure {
  const e = error as Partial<WireError> | undefined;
  if (e?.code === "invalid" && "data" in e && e.data) {
    const fields: Record<string, string> = {};
    const rest: string[] = [];
    for (const issue of e.data.issues) {
      const field = fieldOf(issue.path);
      if (field !== undefined) fields[field] ??= issue.message;
      else rest.push(issue.message);
    }
    return { fields, message: rest.length > 0 ? rest.join(" ") : undefined };
  }
  const message =
    typeof e?.message === "string" ? e.message : `Something went wrong: ${String(error)}`;
  return { fields: {}, message };
}
