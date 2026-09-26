import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localReaderServers } from "./localReader";

/**
 * The trial's one entry in a work cycle's MCP config, and the two ways it could
 * be wrong quietly: an entry written while the trial is off changes every run's
 * config for an install that never asked, and an entry that turns itself off
 * when half-configured reads as a model that never offered anything.
 */
describe("localReaderServers", () => {
  const settings = {
    baseUrl: "http://192.168.0.190:1234/v1",
    model: "qwen/qwen3.6-35b-a3b",
    server: "/workspace/LocalModelOffload/poc/local-reader.mjs",
    log: "",
  };

  it("adds nothing while the base URL is blank", () => {
    assert.deepEqual(localReaderServers({ ...settings, baseUrl: "" }, "/usr/local/bin/node"), {});
  });

  it("refuses a base URL without a model or a server, naming the missing one", () => {
    assert.throws(() => localReaderServers({ ...settings, model: "" }), /UF_LOCAL_READER_MODEL is blank/);
    assert.throws(() => localReaderServers({ ...settings, server: "" }), /UF_LOCAL_READER_SERVER is blank/);
  });

  it("writes a stdio server with its settings in its own env, the log only when set", () => {
    assert.deepEqual(localReaderServers(settings, "/usr/local/bin/node"), {
      uf_local: {
        type: "stdio",
        command: "/usr/local/bin/node",
        args: ["/workspace/LocalModelOffload/poc/local-reader.mjs"],
        env: {
          LOCAL_READER_BASE_URL: "http://192.168.0.190:1234/v1",
          LOCAL_READER_MODEL: "qwen/qwen3.6-35b-a3b",
          LOCAL_READER_STEERING: "must",
        },
      },
    });
    const logged = localReaderServers({ ...settings, log: "/workspace/.local-reader/uf-trial.jsonl" }, "/usr/local/bin/node");
    assert.equal((logged.uf_local as { env: Record<string, string> }).env.LOCAL_READER_LOG, "/workspace/.local-reader/uf-trial.jsonl");
  });
});
