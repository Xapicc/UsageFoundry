import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import { CODEX_BIN, CODEX_HOME } from "./config";
import { childCredentials, chownForChild } from "./privsep";

/**
 * `claudeAuth.ts` for the other provider, and it is a copy of that module's
 * *shape* rather than of its flow, because the two CLIs finish a sign-in in
 * opposite directions.
 *
 * Claude prints a link, holds a PKCE verifier in memory, and reads the code the
 * browser hands back on **stdin** — so the operator carries the secret from the
 * browser to this app, and `submitCode` is what completes it. Codex's headless
 * path is a device flow: `codex login --device-auth` prints a link *and* a
 * one-time code, then polls OpenAI itself until somebody approves. Nothing ever
 * comes back through this app. There is therefore no `submitCode` here, and
 * that absence is the design rather than a gap: the operator types the code into
 * the browser, the child's own exit is the completion, and the page learns about
 * it by re-reading the status.
 *
 * What the pinned CLI actually prints, measured against `codex-cli 0.153.4` in
 * this image rather than read off `--help`:
 *
 *   `codex login status`            one line, and the exit code is *not* the
 *                                   answer — `Not logged in` exits 1 and so does
 *                                   `Error checking login status: …`
 *   `codex login --device-auth`     a banner, the URL, then the one-time code,
 *                                   all with SGR colour that survives both
 *                                   `NO_COLOR` and `FORCE_COLOR=0`; then silence
 *                                   while it polls
 *   `codex login --with-api-key`    reads one line from **stdin**, and exits
 *                                   **0 even when it read nothing**
 *   `codex logout`                  one line, exit 0, whether or not there was
 *                                   anything to remove
 *
 * Two of those four are why this file is not a search-and-replace of its
 * neighbour, and each is commented where it is handled.
 *
 * Subscription sign-in is the point; `submitApiKey` is the fallback. They are
 * separate calls rather than one because they fail differently and only one of
 * them takes a secret.
 */

/** How the container's Codex is authenticated, when it is. */
export type CodexAuthMethod = "chatgpt" | "apikey";

/** What the CLI answered about who, if anyone, is signed in. */
export interface CodexAuthStatus {
  loggedIn: boolean;
  method: CodexAuthMethod | null;
  /**
   * The CLI's own masked tail of a stored key — `sk-proj-***67890`.
   *
   * Carried because it is the only thing distinguishing one API-key install
   * from another, and it is the CLI's mask rather than ours: `redactSecrets`
   * below is written so that this survives it and an unmasked key does not.
   */
  apiKeyHint: string | null;
}

export type CodexAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The hosts a printed device-login URL may point at.
 *
 * `claudeAuth.ts`'s reasoning exactly: this string is rendered as a link the
 * operator is told to open and sign in on, and it arrives as parsed text rather
 * than in a structured field. The realistic failure is a CLI version that
 * changes what it prints, and a mismatch fails loudly with the offending output
 * rather than offering some other page as the place to enter OpenAI
 * credentials.
 */
const DEVICE_URL_DOMAINS = ["openai.com", "chatgpt.com"];

/**
 * The shape of a one-time code, as the pinned CLI prints it: `W0B1-99ZLZ`.
 *
 * Anchored to a whole line and to this alphabet because the code is scraped out
 * of a banner that also contains prose, and a loose match would hand the
 * operator a fragment of a sentence to type into OpenAI's device page. Nothing
 * downstream can tell a wrong code from a right one — the browser simply
 * refuses it, minutes later, with no way back to this app.
 */
const DEVICE_CODE = /^[A-Z0-9]{3,6}-[A-Z0-9]{3,6}$/;

/** Long enough for a slow first run of the CLI, short enough to report. */
const URL_TIMEOUT_MS = 30_000;
/**
 * A device login nobody approved.
 *
 * Deliberately *longer* than the CLI's own 15-minute code expiry, so the child
 * is what gives up and the operator reads its reason, rather than this timer
 * killing a flow that was still live. It is a backstop against a child that
 * neither succeeds nor exits, not a policy about how long a code lasts.
 */
const PENDING_TIMEOUT_MS = 16 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** Enough of the CLI's own words to quote back; a bound so a wedge cannot grow. */
const CAPTURE_LIMIT = 16_384;

interface PendingLogin {
  child: ChildProcess;
  url: string;
  /** The one-time code the operator types into the browser. Not a secret we hold. */
  code: string;
  startedAt: number;
  /** Everything the child has said, for the error message if it fails. */
  output: () => string;
  timer: NodeJS.Timeout;
}

/**
 * On `globalThis` for `claudeAuth.ts`'s reason — a module-level `let` resets on
 * every request in dev — and on **new keys** rather than a shape shared with
 * that module, since `??=` would hand a pre-upgrade value straight back.
 */
const store = globalThis as typeof globalThis & {
  __ufCodexLogin?: PendingLogin | null;
  __ufCodexLoginFailure?: string | null;
  __ufCodexAuthRead?: Promise<CodexAuthResult<CodexAuthStatus>> | null;
};

/**
 * Terminal escapes, removed before anything is read out of CLI output.
 *
 * Mandatory here in a way it is merely prudent next door: the pinned Codex
 * prints its URL and its code wrapped in `ESC[94m … ESC[0m` **even with
 * `NO_COLOR=1` and `FORCE_COLOR=0` and a pipe on stdout** — measured, not
 * assumed. Without this the code scraped off the banner would carry a colour
 * reset on the end of it.
 */
function stripEscapes(raw: string): string {
  return (
    raw
      // OSC: ESC ] … terminated by BEL or by ST (ESC \\). Its payload is an
      // href, so it goes with the wrapper and the visible label survives.
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
      // CSI: ESC [ … final byte. Colour, cursor moves, a spinner redrawing.
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
  );
}

/**
 * Blank out anything key-shaped before CLI output is quoted back.
 *
 * The pinned CLI does not echo a key — `--with-api-key` says only "Reading API
 * key from stdin..." — so this guards the version that does, and it guards it at
 * the one place where CLI output leaves this module: `describeOutput`, whose
 * string reaches an HTTP body and whatever the operator's browser or proxy keeps
 * of it.
 *
 * The threshold is what makes it usable rather than merely safe. `codex login
 * status` reports a stored key as `sk-proj-***67890`, and that masked form is
 * the only thing telling two API-key installs apart, so it has to survive: the
 * eight-character run this matches is broken by the CLI's own `***`, while a
 * real key — an unbroken run far longer than eight — is not.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}

/**
 * The URL *and* the one-time code out of `codex login --device-auth`, or `null`.
 *
 * Pure, and tested, for `extractLoginUrl`'s reason one provider over: every way
 * of getting it wrong is silent and points the operator somewhere. Both halves
 * or neither, because a link with no code beside it is a page that cannot be
 * completed, and a code with no link is a string with nowhere to go.
 *
 * The code is looked for **after** the URL rather than anywhere in the output.
 * The CLI prints them in that order under numbered steps, and searching the
 * whole banner would let a code-shaped token in a future version's header — a
 * build id, a plan name — be handed over as the thing to type.
 */
export function extractDeviceLogin(
  raw: string,
): { url: string; code: string } | null {
  const text = stripEscapes(raw);

  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    const allowed = DEVICE_URL_DOMAINS.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (!allowed) continue;

    const after = text.slice((match.index ?? 0) + match[0].length);
    for (const line of after.split("\n")) {
      const candidate = line.trim();
      if (DEVICE_CODE.test(candidate)) return { url: url.toString(), code: candidate };
    }
    // A recognised link with no code under it yet: the child is mid-write, and
    // the caller polls. Returning the URL alone would open a sheet the operator
    // cannot finish.
    return null;
  }
  return null;
}

/**
 * `codex login status` into the shape the page renders.
 *
 * A result union rather than a boolean because this CLI has **four** answers and
 * only two of them are a login: `Not logged in`, `Logged in using ChatGPT`,
 * `Logged in using an API key - <mask>`, and `Error checking login status: …`
 * for a credential file it cannot read. The exit code cannot make that split —
 * the first and the last both exit 1 — so the text is what decides, and a
 * fourth-case answer collapsed into "signed out" would put a Sign in button in
 * front of an operator whose real problem is a corrupt `auth.json`.
 *
 * Line by line rather than on the whole string, because the CLI prints an
 * unrelated warning above its answer whenever it cannot write its PATH aliases,
 * which is every run of it in this container.
 */
export function parseCodexStatus(raw: string): CodexAuthResult<CodexAuthStatus> {
  const text = stripEscapes(raw);

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed === "Not logged in") {
      return {
        ok: true,
        value: { loggedIn: false, method: null, apiKeyHint: null },
      };
    }
    if (/^Logged in using ChatGPT\b/.test(trimmed)) {
      return {
        ok: true,
        value: { loggedIn: true, method: "chatgpt", apiKeyHint: null },
      };
    }
    const key = /^Logged in using an API key(?:\s*-\s*(\S+))?/.exec(trimmed);
    if (key) {
      return {
        ok: true,
        value: {
          loggedIn: true,
          method: "apikey",
          apiKeyHint: key[1] ? redactSecrets(key[1]) : null,
        },
      };
    }
  }

  return { ok: false, error: describeOutput(text) };
}

/** What went wrong, in the CLI's own words where it left any, minus any secret. */
function describeOutput(text: string): string {
  const line = redactSecrets(stripEscapes(text))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // The PATH-alias warning is on every invocation and is never the answer, so
    // quoting it back would describe every failure as the same irrelevance.
    .filter((l) => !l.startsWith("WARNING: proceeding, even though"))
    .pop();
  return line
    ? `\`${CODEX_BIN} login\` answered: ${line.slice(0, 300)}`
    : `\`${CODEX_BIN} login\` answered nothing`;
}

/**
 * The pasted API key, or why it was refused.
 *
 * The key reaches the child on **stdin**, never in argv, so this is not guarding
 * a command line — the CLI reads exactly one line, and a value carrying a
 * newline would present its first half as the key and leave the rest in the
 * pipe. Whitespace around a paste is the normal case and is trimmed.
 *
 * No refusal here quotes the input, and that is the rule for this whole path
 * rather than a nicety of wording: the value is a credential, and an error
 * message is the one part of a failed request that gets kept.
 */
export function normalizeApiKey(input: unknown): CodexAuthResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "No API key was sent." };
  }
  const key = input.trim();
  if (key === "") return { ok: false, error: "Paste an API key." };
  if (/\s/.test(key)) {
    return {
      ok: false,
      error: "That contains a space or a line break — paste only the key.",
    };
  }
  if (key.length > 512) {
    return { ok: false, error: "That is too long to be an API key." };
  }
  return { ok: true, value: key };
}

/**
 * Environment for a Codex auth child — `authEnv`'s denylist verbatim, plus the
 * one variable that decides where the credential lands.
 *
 * A copy rather than an import for the reason `claudeAuth.ts` gives for its own
 * copy: an auth route has no business pulling the run loop in behind it. The two
 * therefore move together or they disagree, which is a thing to know when
 * editing either.
 *
 * `OPENAI_API_KEY` and `CODEX_API_KEY` are deliberately **not** stripped, and
 * unlike next door that is not because the panel has to answer for them:
 * measured against the pinned CLI, neither variable changes what `codex login
 * status` reports — an install with `OPENAI_API_KEY` set and an empty
 * `CODEX_HOME` still answers `Not logged in`. There is consequently no
 * `apiKeySource` row on this panel, because there is no environment credential
 * for it to outrank. Stripping them here would state the opposite.
 */
function codexAuthEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    CODEX_HOME,
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR" ||
      key === "NODE_OPTIONS"
    ) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Spawn options shared by all four commands.
 *
 * `childCredentials()` is load-bearing here for exactly the reason it is at
 * `claudeAuth.ts`'s spawn site rather than the containment reason it carries
 * everywhere else: the CLI writes `auth.json` at mode 0600 owned by whoever
 * wrote it, and the uid that has to open it afterwards is the agent's. A login
 * taken with the server's own authority is a panel reporting a healthy sign-in
 * over a credential no child can read.
 */
function spawnOptions(): SpawnOptions {
  return {
    env: codexAuthEnv(),
    ...childCredentials(),
    stdio: ["pipe", "pipe", "pipe"],
  };
}

/**
 * Make `CODEX_HOME` exist and belong to the uid that will write in it.
 *
 * The directory `claudeAuth.ts` never has to think about, because `~/.claude` is
 * a bind mount that already carries the host uid. Codex's is not mounted on a
 * stock install, so it is created by whichever process gets there first — and
 * the first process is the server, which is root. Left root-owned it is a
 * directory the login child cannot write, and the failure surfaces as the CLI
 * refusing to save rather than as anything naming a permission.
 *
 * `chownForChild` throws on failure and is allowed to, one layer up: a
 * `CODEX_HOME` the child cannot write is a sign-in that cannot complete, and
 * saying so is better than a login that reports success over nothing on disk.
 */
function ensureCodexHome(): CodexAuthResult<null> {
  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
    chownForChild(CODEX_HOME);
    return { ok: true, value: null };
  } catch (err) {
    return {
      ok: false,
      error: `Could not prepare ${CODEX_HOME}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One command to completion. Never throws; a failure is a value. */
function runCodex(
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(CODEX_BIN, args, spawnOptions());
    } catch (err) {
      resolve({
        code: null,
        output: "",
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let output = "";
    const take = (chunk: Buffer) => {
      if (output.length < CAPTURE_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    // The secret's whole journey: written here, one line, and the pipe closed
    // behind it. It is in no argv, so it is in no `/proc/<pid>/cmdline`, which
    // is world-readable and is what `--with-api-key` exists to avoid.
    if (stdin !== undefined) child.stdin?.write(`${stdin}\n`);
    child.stdin?.end();

    let settled = false;
    const done = (r: {
      code: number | null;
      output: string;
      spawnError: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        code: null,
        output,
        // The args are safe to name: none of the four carries a value, which is
        // the property `--with-api-key` was chosen for.
        spawnError: `\`${CODEX_BIN} ${args.join(" ")}\` did not answer within ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err) =>
      done({ code: null, output, spawnError: err.message }),
    );
    child.on("close", (code) => done({ code, output, spawnError: null }));
  });
}

/**
 * Who the container's Codex is signed in as.
 *
 * Callers arriving while a read is already running share it, exactly as
 * `readAuthStatus` does next door: this is a spawn on a route with no rate limit
 * in front of it, the page polls it while a device login is pending, and the
 * answer cannot differ between two reads a few milliseconds apart.
 */
export function readAuthStatus(): Promise<CodexAuthResult<CodexAuthStatus>> {
  if (store.__ufCodexAuthRead) return store.__ufCodexAuthRead;
  const read = statusOnce().finally(() => {
    store.__ufCodexAuthRead = null;
  });
  store.__ufCodexAuthRead = read;
  return read;
}

async function statusOnce(): Promise<CodexAuthResult<CodexAuthStatus>> {
  const home = ensureCodexHome();
  if (!home.ok) return home;

  const res = await runCodex(["login", "status"], COMMAND_TIMEOUT_MS);
  if (res.spawnError) {
    return {
      ok: false,
      error: `Could not run \`${CODEX_BIN}\`: ${res.spawnError}`,
    };
  }
  // Deliberately not gated on the exit code. `Not logged in` exits 1, which is
  // an answer rather than a failure, and `parseCodexStatus` is what tells that
  // apart from the other thing exit 1 means.
  return parseCodexStatus(res.output);
}

/** Is a device login waiting for somebody to approve it right now? */
export function pendingLogin(): {
  url: string;
  code: string;
  startedAt: number;
} | null {
  const p = store.__ufCodexLogin;
  return p ? { url: p.url, code: p.code, startedAt: p.startedAt } : null;
}

/**
 * Why the last device login ended without signing in, if one did.
 *
 * Reported because nothing else can say it. A Codex device flow finishes inside
 * the child — no request comes back through this app — so the page learns that
 * it worked by the status changing, and would otherwise learn that it *failed*
 * by the status not changing, which is indistinguishable from still waiting.
 * Held until the next login starts rather than cleared on read, so a reload does
 * not lose the only account of what happened.
 */
export function lastLoginFailure(): string | null {
  return store.__ufCodexLoginFailure ?? null;
}

/**
 * Drop the pending login, killing the child that is polling for approval.
 *
 * Called on cancel, on timeout, and at the start of every new login. Safe to
 * call when there is none.
 */
export function cancelLogin(): void {
  const p = store.__ufCodexLogin;
  if (!p) return;
  store.__ufCodexLogin = null;
  clearTimeout(p.timer);
  p.child.kill("SIGKILL");
}

/**
 * Start a device login and return the link and the code to type into it.
 *
 * The child stays alive afterwards, polling OpenAI, until somebody approves the
 * code, the code expires, or something cancels it. **This is the manual step and
 * nothing in this app can take it**: the operator opens the link on a device
 * that can reach it, signs in to their OpenAI account, and enters the code.
 *
 * Destructive to an existing login, measured rather than assumed: starting a
 * device flow on a container already signed in leaves `codex login status`
 * answering `Not logged in` from that moment, before anybody has approved
 * anything. The page therefore offers this only when signed out, and the sign-in
 * sheet says what pressing it costs.
 */
export async function beginLogin(): Promise<
  CodexAuthResult<{ url: string; code: string }>
> {
  // Any earlier attempt is dead to us the moment a second code exists, and the
  // operator is about to be shown the newer one.
  cancelLogin();
  store.__ufCodexLoginFailure = null;

  const home = ensureCodexHome();
  if (!home.ok) return home;

  let child: ChildProcess;
  try {
    child = spawn(CODEX_BIN, ["login", "--device-auth"], spawnOptions());
  } catch (err) {
    return {
      ok: false,
      error: `Could not run \`${CODEX_BIN}\`: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let output = "";
  const take = (chunk: Buffer) => {
    if (output.length < CAPTURE_LIMIT) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  // Nothing to say to this child — it reads no code back, it polls — and an open
  // stdin leaves a CLI that decides to prompt waiting on a line nobody will
  // send. Closing it is measured safe: the flow runs to its own timeout with
  // stdin at `/dev/null`.
  child.stdin?.end();

  const exited = new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      child.on("close", (code) => resolve({ code, output }));
      child.on("error", (err) => {
        output += `\n${err.message}`;
        resolve({ code: null, output });
      });
    },
  );

  const found = await waitForDeviceLogin(() => output, exited);
  if (!found.ok) {
    child.kill("SIGKILL");
    return found;
  }

  const timer = setTimeout(() => {
    store.__ufCodexLoginFailure =
      "The sign-in was not approved in time. Start it again.";
    cancelLogin();
  }, PENDING_TIMEOUT_MS);
  timer.unref?.();

  const pending: PendingLogin = {
    child,
    url: found.value.url,
    code: found.value.code,
    startedAt: Date.now(),
    output: () => output,
    timer,
  };
  store.__ufCodexLogin = pending;

  // Registered after the store is set, so the handler can tell *this* pending
  // login from the one that replaced it. A cancelled child exits too, and its
  // exit must not write a failure onto the flow the operator is now looking at.
  void exited.then((e) => {
    if (store.__ufCodexLogin !== pending) return;
    store.__ufCodexLogin = null;
    clearTimeout(timer);
    // Success writes the credential and says nothing here: the page reads the
    // status, which is the only thing that proves the file landed. A non-zero
    // exit is the one ending nothing else can see.
    store.__ufCodexLoginFailure =
      e.code === 0 ? null : describeOutput(e.output);
  });

  return { ok: true, value: { url: found.value.url, code: found.value.code } };
}

/** Poll the captured output until the pair appears, the child dies, or we give up. */
function waitForDeviceLogin(
  output: () => string,
  exited: Promise<{ code: number | null; output: string }>,
): Promise<CodexAuthResult<{ url: string; code: string }>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CodexAuthResult<{ url: string; code: string }>) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(r);
    };

    const look = () => {
      const found = extractDeviceLogin(output());
      if (found) finish({ ok: true, value: found });
    };

    // Polled rather than driven off `data`, for the reason next door: the
    // listener accumulating `output` is already attached, and a second one would
    // have to agree with it about ordering.
    const poll = setInterval(look, 100);
    poll.unref?.();

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `\`${CODEX_BIN} login --device-auth\` printed no sign-in link and code within ${Math.round(URL_TIMEOUT_MS / 1000)}s. ${describeOutput(output())}`,
      });
    }, URL_TIMEOUT_MS);
    timer.unref?.();

    void exited.then(() => {
      // One last look: a child that printed the pair and left immediately is not
      // the shape we expect, but the pair would still be there.
      look();
      finish({
        ok: false,
        error: `\`${CODEX_BIN} login --device-auth\` exited before printing a sign-in link. ${describeOutput(output())}`,
      });
    });

    look();
  });
}

/**
 * Sign in with an API key instead — the fallback, not the front door.
 *
 * The key goes to the child on stdin and nowhere else. What earns the second
 * half of this function is measured: **`codex login --with-api-key` exits 0 when
 * it read nothing at all**, printing "No API key provided via stdin." and
 * leaving the credential exactly as it was. An exit code is therefore not a
 * success signal here, and a route that trusted one would report a sign-in over
 * an unchanged install. The status read is what decides, and it has to agree
 * about the *method* as well as the fact — an install that was already signed in
 * with ChatGPT would otherwise pass on the credential this call did not write.
 */
export async function submitApiKey(
  input: unknown,
): Promise<CodexAuthResult<CodexAuthStatus>> {
  const key = normalizeApiKey(input);
  if (!key.ok) return key;

  // A device flow already deletes the stored credential when it starts, so
  // leaving one polling behind a key that just landed would be a child racing to
  // overwrite it the moment somebody approves.
  cancelLogin();

  const home = ensureCodexHome();
  if (!home.ok) return home;

  const res = await runCodex(
    ["login", "--with-api-key"],
    COMMAND_TIMEOUT_MS,
    key.value,
  );
  if (res.spawnError) {
    return {
      ok: false,
      error: `Could not run \`${CODEX_BIN}\`: ${res.spawnError}`,
    };
  }
  if (res.code !== 0) {
    return { ok: false, error: describeOutput(res.output) };
  }

  const status = await readAuthStatus();
  if (!status.ok) return status;
  if (!status.value.loggedIn || status.value.method !== "apikey") {
    return { ok: false, error: describeOutput(res.output) };
  }
  return status;
}

/**
 * Sign the container's Codex out.
 *
 * Destructive to work in flight and deliberately not guarded here, on
 * `claudeAuth.ts`'s reasoning: this module cannot see runs, and a sign-out that
 * refused while any existed would be unreachable exactly when a leaked
 * credential most needs revoking. The page confirms instead.
 */
export async function signOut(): Promise<CodexAuthResult<CodexAuthStatus>> {
  cancelLogin();
  store.__ufCodexLoginFailure = null;

  const home = ensureCodexHome();
  if (!home.ok) return home;

  const res = await runCodex(["logout"], COMMAND_TIMEOUT_MS);
  if (res.spawnError) {
    return {
      ok: false,
      error: `Could not run \`${CODEX_BIN}\`: ${res.spawnError}`,
    };
  }
  if (res.code !== 0) {
    return { ok: false, error: describeOutput(res.output) };
  }
  return readAuthStatus();
}
