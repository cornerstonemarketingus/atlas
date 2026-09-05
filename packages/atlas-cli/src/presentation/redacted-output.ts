import type { SecretRedactor } from "../domain/secret-redaction.js";

/**
 * Scrubs a rendered CLI result before it is printed.
 *
 * This is a separate boundary from the model one, and it is not redundant with
 * it. What the CLI prints becomes `result.json`, which the runner reads and
 * turns into a pull request body, and which GitHub Actions captures in its
 * logs. Both are readable by people who never had access to the repository the
 * agent was working in. The fields most at risk are exactly the ones carrying
 * real command output: a validation diagnostic quotes what a failing test
 * compared, and the model's own summary quotes the code it changed.
 *
 * The whole rendered string is scrubbed rather than selected fields, so a field
 * added to the output later is covered without anyone remembering to add it
 * here. Placeholders are plain text and keep JSON well-formed, so the runner's
 * `JSON.parse` is unaffected.
 */
export async function redactRenderedOutput(rendered: string, redactor: SecretRedactor): Promise<string> {
  return (await redactor.redact(rendered)).text;
}
