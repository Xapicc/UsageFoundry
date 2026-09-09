import {
  ZERO_TOKENS,
  addTokens,
  guardCostOf,
  resolvePrice,
  totalTokens,
  type TokenCounts,
} from "./pricing";

/**
 * What a chat turn's output says while it is still being produced.
 *
 * ## Why this exists at all
 *
 * The chat child used to run `--output-format json`, which prints **one object
 * when it exits**. Everything about a turn therefore existed in one string in
 * one process's memory until the child was done: the assistant's text, the
 * turn's cost, the thread's running total. A restart, an OOM or a deploy in the
 * middle lost all three together while the money stayed spent, and the page had
 * nothing to draw but a spinner for as long as the turn ran. The run loop
 * solved this years earlier — `--output-format stream-json`, persist, *then*
 * publish — and the chat had neither half.
 *
 * This is the reading half, kept pure so it can be tested without a child: fold
 * one line at a time into an accumulator, and let the caller decide when to
 * persist. What it must never do is decide anything about the database, because
 * the ordering (persist, then publish) is the caller's invariant and a reader
 * that wrote would own half of it.
 *
 * ## An unrecognised event is counted, never dropped
 *
 * `orchestrator.ts`'s Claude parser tests four types and has no fifth branch;
 * the Codex parser twelve lines below it logs an unknown type once per cycle
 * and its docblock explains why that is not survivable — a CLI that renames an
 * event goes on producing turns that look thinner rather than turns that fail.
 * That asymmetry is a row on `proposals/GapRegister/` (B6), and this file is
 * not going to add a third parser to the wrong side of it.
 */

/** The main thread's text, the measured usage, and what could not be read. */
export interface ChatTurnAccumulator {
  /** Assistant text as it arrives, main thread only. Live view, never stored. */
  text: string;
  /** Usage the CLI reported, summed across requests — measured, not derived. */
  tokens: TokenCounts;
  /** Our own price for those tokens: a guard figure, never a shown one. */
  costGuardUSD: number;
  sessionId: string | null;
  /** The final `result` object, once one has arrived. */
  result: Record<string, unknown> | null;
  /** Lines that were not JSON at all — a CLI writing prose to stdout. */
  unreadable: number;
  /** Event types with no branch here, by name, so a rename is visible. */
  unknownTypes: Set<string>;
}

export function newChatTurnAccumulator(): ChatTurnAccumulator {
  return {
    text: "",
    tokens: { ...ZERO_TOKENS },
    costGuardUSD: 0,
    sessionId: null,
    result: null,
    unreadable: 0,
    unknownTypes: new Set(),
  };
}

/** `message.usage` as this app counts tokens. Absent fields are zero, not null. */
function usageOf(message: Record<string, unknown> | undefined): TokenCounts {
  const usage = (message?.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const creation = (usage.cache_creation ?? {}) as Record<string, unknown>;
  // The 1h bucket is only ever present when the caller asked for it, and the
  // flat `cache_creation_input_tokens` is the sum of both when the breakdown is
  // not there. `readTokens` in `transcripts.ts` reads the same fields the same
  // way and for the same reason: what neither bucket declared goes in its own
  // field, priced at the floor for display and at the 1h class for the guard,
  // rather than into `cacheWrite5m` where a 2.00x write would be billed at
  // 1.25x with nothing anywhere saying so.
  const write5m = n(creation.ephemeral_5m_input_tokens);
  const write1h = n(creation.ephemeral_1h_input_tokens);
  const flat = n(usage.cache_creation_input_tokens);
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheWriteUnattributed:
      write5m || write1h ? Math.max(0, flat - write5m - write1h) : flat,
  };
}

/** The text blocks of one assistant message, joined the way the CLI prints them. */
function textOf(message: Record<string, unknown> | undefined): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => {
      const b = block as Record<string, unknown>;
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * Fold one line of `stream-json` into the accumulator.
 *
 * Returns what changed, so a caller can persist on the events that moved
 * something rather than on every line: a turn reading a large file produces
 * hundreds of `user` events carrying tool output, none of which the operator is
 * waiting to see.
 */
export function readChatEvent(
  acc: ChatTurnAccumulator,
  line: string,
): { textGrew: boolean; spendGrew: boolean; sawResult: boolean } {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Counted rather than ignored: a CLI that starts writing anything but JSON
    // to stdout would otherwise present as a turn that produced no text.
    acc.unreadable += 1;
    return { textGrew: false, spendGrew: false, sawResult: false };
  }
  if (!ev || typeof ev !== "object") {
    acc.unreadable += 1;
    return { textGrew: false, spendGrew: false, sawResult: false };
  }

  if (typeof ev.session_id === "string" && ev.session_id) {
    acc.sessionId = ev.session_id;
  }

  const type = typeof ev.type === "string" ? ev.type : "";

  if (type === "assistant") {
    const message = ev.message as Record<string, unknown> | undefined;
    // A delegated turn, if one is ever forwarded here. The chat passes no
    // `--forward-subagent-text`, so this is belt: a sub-agent's voice in the
    // operator's transcript would read as the orchestrator's own.
    if (ev.parent_tool_use_id) {
      return { textGrew: false, spendGrew: false, sawResult: false };
    }
    const before = acc.text.length;
    acc.text += textOf(message);

    const used = usageOf(message);
    const spendGrew = totalTokens(used) > 0;
    if (spendGrew) {
      acc.tokens = addTokens(acc.tokens, used);
      // Priced by us, so it is a *guard* figure and is labelled one everywhere
      // it lands: the CLI's own `total_cost_usd` arrives with the `result`
      // event and is the shown figure. `guardCostOf` charges an unplaced model
      // the fallback rate rather than nothing, for the reason it exists — a
      // ceiling that stops existing the day a new model ships is worse than one
      // that over-charges.
      const model = typeof message?.model === "string" ? message.model : undefined;
      acc.costGuardUSD = guardCostOf(acc.tokens, resolvePrice(model));
    }
    return { textGrew: acc.text.length > before, spendGrew, sawResult: false };
  }

  if (type === "result") {
    acc.result = ev;
    return { textGrew: false, spendGrew: false, sawResult: true };
  }

  // `system` is the init banner and carries the session id, taken above.
  // `user` is tool output coming back up, which the operator is not waiting on.
  if (type === "system" || type === "user") {
    return { textGrew: false, spendGrew: false, sawResult: false };
  }

  acc.unknownTypes.add(type || "(no type)");
  return { textGrew: false, spendGrew: false, sawResult: false };
}
