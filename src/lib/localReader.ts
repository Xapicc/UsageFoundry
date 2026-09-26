import {
  LOCAL_READER_BASE_URL,
  LOCAL_READER_LOG,
  LOCAL_READER_MODEL,
  LOCAL_READER_SERVER,
} from "./config";

/**
 * The local reader trial: LocalModelOffload's stdio MCP server, added beside the
 * taskboard in a work cycle's config so the cycle can hand reading to a model on
 * the operator's own machine. A trial on the `local-offload-trial` branch, not a
 * feature — `proposals/LocalModelOffload/` is the design it measures.
 *
 * **Off is inert.** A blank base URL returns no entry, so the config file a run
 * gets is byte-identical to the one it got before this existed.
 *
 * **Half-configured throws rather than turning itself off.** A base URL with no
 * model or no server path is an operator who meant to switch it on; returning
 * nothing would read as a trial where the model simply never offered anything.
 * `prepareRunTaskboard` catches the throw into its `unavailable` row, so the
 * sentence lands on the run's own log.
 *
 * **The server decides, per session, whether to offer anything.** It lists no
 * tools and sends no instructions while its model server does not answer, and
 * logs that per session — which is what the trial compares, since the host is
 * shared and asleep often enough to supply the runs that were not offered them.
 *
 * `node` is a parameter so the entry can be asserted without depending on where
 * this process's own binary is.
 */
export function localReaderServers(
  settings: { baseUrl: string; model: string; server: string; log: string },
  node: string = process.execPath,
): Record<string, unknown> {
  if (!settings.baseUrl) return {};
  if (!settings.model) throw new Error("UF_LOCAL_READER_BASE_URL is set but UF_LOCAL_READER_MODEL is blank");
  if (!settings.server) throw new Error("UF_LOCAL_READER_BASE_URL is set but UF_LOCAL_READER_SERVER is blank");
  return {
    uf_local: {
      type: "stdio",
      command: node,
      args: [settings.server],
      // The child's environment has `UF_*` stripped by `childEnv`, which is why
      // the values are written here rather than inherited.
      env: {
        LOCAL_READER_BASE_URL: settings.baseUrl,
        LOCAL_READER_MODEL: settings.model,
        LOCAL_READER_STEERING: "must",
        ...(settings.log ? { LOCAL_READER_LOG: settings.log } : {}),
      },
    },
  };
}

/** `localReaderServers` over this install's environment. */
export function configuredLocalReader(): Record<string, unknown> {
  return localReaderServers({
    baseUrl: LOCAL_READER_BASE_URL,
    model: LOCAL_READER_MODEL,
    server: LOCAL_READER_SERVER,
    log: LOCAL_READER_LOG,
  });
}
