// Copies stdin to stdout, prefixing each line with an ISO timestamp (ms) taken
// when the line arrived, so a pipeline can show when the CLI printed what.
//   claude ... | node stamp.mjs > stdout.stamped
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
