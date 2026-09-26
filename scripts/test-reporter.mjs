/**
 * `npm test`'s reporter: Node's own default, plus the failures Node 22 counts nowhere.
 *
 * A suite that throws while its `describe` body is being built, before any `it`
 * is registered, is printed `not ok` and then left out of `# tests`, `# fail` and
 * the exit code. So a run with a failing suite in it prints `fail 0` and exits 0,
 * and the only trace is one `not ok` line among twenty thousand. A suite whose
 * `after` hook throws goes the same way. Node fixed it in 24.15.0
 * (nodejs/node#62282, which sets the exit code but still leaves `# fail` at 0);
 * this repository pins 22, which never got it. `sandboxMountPoints.test.ts`
 * builds its cases from the installed CLI at exactly that point on purpose, and
 * its tripwire fired unseen behind a green run until somebody grepped for it.
 *
 * So this passes every event to the reporter Node would have chosen, then names
 * each suite that failed on its own account and exits 1. A suite failing because
 * a test in it failed is not named, because Node already counted that test.
 */
import path from "node:path";
import { pipeline } from "node:stream";
import { spec, tap } from "node:test/reporters";

// Node 22's own choice, so a terminal and a pipe each get the output they had before.
function defaultReporter(events) {
  if (!process.stdout.isTTY) return tap(events);
  const formatter = new spec();
  // An error destroys `formatter` with it, and reading `formatter` rethrows it.
  pipeline(events, formatter, () => {});
  return formatter;
}

// A suite failure that is only its children's (`subtestsFailed`) or its parent's
// (`cancelledByParent`) is already counted, or already named through that parent.
function failedOnItsOwn(data) {
  if (data.todo || data.details?.type !== "suite") return false;
  const failureType = data.details.error?.failureType;
  return failureType !== "subtestsFailed" && failureType !== "cancelledByParent";
}

function describeSuiteFailure(data) {
  const where = data.file ? ` (${path.relative(process.cwd(), data.file)}:${data.line})` : "";
  const error = data.details.error;
  const firstLine = String(error?.cause ?? error).split("\n")[0];
  return `✖   ${data.name}${where}\n      ${firstLine}\n`;
}

export default async function* reporter(source) {
  const suiteFailures = [];
  async function* watch() {
    for await (const event of source) {
      if (event.type === "test:fail" && failedOnItsOwn(event.data)) suiteFailures.push(event.data);
      yield event;
    }
  }
  yield* defaultReporter(watch());
  if (suiteFailures.length === 0) return;
  process.exitCode = 1;
  const count = suiteFailures.length === 1 ? "1 suite" : `${suiteFailures.length} suites`;
  yield `\n✖ ${count} failed outside any test, which the fail count above does not include:\n`;
  for (const data of suiteFailures) yield describeSuiteFailure(data);
}
