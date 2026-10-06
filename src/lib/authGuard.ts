/**
 * Whether this process may serve at all, given what it was told about auth.
 *
 * `UF_AUTH_TOKEN` empty means every route in this app is open: `POST /api/runs`
 * starts a billed agent with write access to every mount, `PUT /api/settings`
 * can widen `chatDefaultGuards.permissionMode` to `bypassPermissions`, and
 * `GET /api/runs/<id>/diff` returns the source of every repository mounted. That
 * was reachable with no credential and *nothing said so* — not a boot line, not
 * a banner, not the login route, which answered a plain success. The only two
 * places the state was written down were a comment in `docker-compose.yml` and
 * one in `.env.example`, both read once, at install time, by whoever wrote the
 * `.env`.
 *
 * So the absence of a token is no longer a default: it is a choice the operator
 * has to make in the environment, the same `${VAR:?}` reasoning `docker-compose`
 * already applies to `UF_WORKSPACE` and `HOME`. Running with auth off stays
 * legitimate — a loopback-bound laptop install is the case it is for — it just
 * cannot be arrived at by saying nothing.
 *
 * Pure, and separated from `instrumentation.ts` for the reason every other
 * decision in this codebase is separated from its side effect: the failure mode
 * is silent in both directions. A refusal that fires on a configured install
 * takes the whole service down; one that never fires leaves the door open and
 * looks exactly like a service that is fine.
 */

export type AuthBootSignal =
  /** A token of at least `MIN_TOKEN_LENGTH` is set. Nothing to say. */
  | { kind: "enabled" }
  /** A token is set and is short enough to guess. Serve, and say so loudly. */
  | { kind: "short"; message: string }
  /** No token, and the operator said that is what they want. Say it, loudly. */
  | { kind: "unauthenticated"; message: string }
  /** No token and no acknowledgement. Do not serve. */
  | { kind: "refused"; message: string };

/**
 * The one spelling that switches authentication off.
 *
 * Exactly `"1"`, and read as a string equality rather than through anything
 * truthy — `continueAfterDone`'s rule, for its reason: this value makes the app
 * refuse to protect itself, so a `"false"`, a `"no"` or a stray quote has to
 * fail towards refusing to start rather than towards serving openly.
 */
const ACKNOWLEDGEMENT = "1";

const REFUSAL = [
  "[usagefoundry] REFUSING TO START: UF_AUTH_TOKEN is empty, so every route in",
  "this app would be open to anyone who can reach the port — including the ones",
  "that start billed agents with write access to your mounted repositories.",
  "",
  "Choose one:",
  "  * set UF_AUTH_TOKEN in .env to a long random string, e.g.",
  "      openssl rand -hex 32",
  "  * or, if this install is bound to loopback on a machine only you use, set",
  "      UF_ALLOW_NO_AUTH=1",
  "    to say so explicitly. The app then starts with no authentication at all",
  "    and says so on every page.",
].join("\n");

const WARNING = [
  "[usagefoundry] ################################################################",
  "[usagefoundry] AUTHENTICATION IS OFF. UF_AUTH_TOKEN is empty and",
  "[usagefoundry] UF_ALLOW_NO_AUTH=1 was set, so this server is serving every",
  "[usagefoundry] route — including run creation and settings — to anyone who",
  "[usagefoundry] can reach its port. Keep it bound to loopback.",
  "[usagefoundry] ################################################################",
].join("\n");

/**
 * The shortest token that says nothing at boot: what `openssl rand -hex 16`
 * prints, half of what `.env.example` and `README.md` tell the operator to
 * generate.
 *
 * The limiters bound the guess *rate* — about 100 a minute at sign-in, 100 at
 * the gate's bearer branch, and a fresh gate budget per restart — so the
 * token's length is the rest of the defence. Thirty-two hex characters is 128
 * bits, which that rate never reaches; at about 288,000 guesses a day a
 * six-digit one falls in under four days and a dictionary word in hours, and
 * those are what an operator choosing by hand picks. A warning rather than a
 * refusal, because a refusal would stop an upgraded install whose token was
 * fine yesterday, ending every run in flight, and that trade is the operator's
 * to make. Length rather than entropy: it is the one property of a secret this
 * process can measure without guessing at how it was made.
 */
export const MIN_TOKEN_LENGTH = 32;

// Says nothing about the token beyond the bound it missed — not its length,
// which narrows the search for anybody reading the log.
const SHORT = [
  "[usagefoundry] ################################################################",
  `[usagefoundry] UF_AUTH_TOKEN IS SHORT: fewer than ${MIN_TOKEN_LENGTH} characters. Sign-in and`,
  "[usagefoundry] bearer guesses are rate-limited, not refused, so a short token",
  "[usagefoundry] is one a guesser can reach. Replace it with the output of",
  "[usagefoundry]     openssl rand -hex 32",
  "[usagefoundry] at your next restart; changing it also signs every browser out.",
  "[usagefoundry] ################################################################",
].join("\n");

export function authBootSignal(env: {
  token: string;
  allowNoAuth: string;
}): AuthBootSignal {
  if (env.token.length >= MIN_TOKEN_LENGTH) return { kind: "enabled" };
  if (env.token.length > 0) return { kind: "short", message: SHORT };
  if (env.allowNoAuth === ACKNOWLEDGEMENT) {
    return { kind: "unauthenticated", message: WARNING };
  }
  return { kind: "refused", message: REFUSAL };
}
