import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildCredentials, McpConfigOwnership } from "./privsep";
import {
  resolveChatGid,
  resolveChildCredentials,
  resolveMcpConfigOwnership,
} from "./privsep";

/**
 * The decision behind every spawn in this app, and both ways of getting it
 * wrong are silent in opposite directions.
 *
 * Credentials this process cannot apply fail every spawn with EPERM — loud, but
 * only at the moment a run starts. No credentials at all is the expensive one:
 * the container looks identical, every page reads the same, and one
 * `tr '\0' '\n' < /proc/<server>/environ` inside any agent hands back
 * UF_AUTH_TOKEN, ANTHROPIC_ADMIN_KEY and UF_GITHUB_TOKEN. Nothing downstream
 * can tell a separated install from a shared one.
 */

describe("resolveChildCredentials", () => {
  it("asks for nothing when no agent uid is configured", () => {
    // `npm run dev`, the test suite, and every deployment predating the split.
    assert.equal(
      resolveChildCredentials({
        serverUid: 501,
        agentUid: undefined,
        agentGid: undefined,
      }),
      null,
    );
    assert.equal(
      resolveChildCredentials({ serverUid: 0, agentUid: "  ", agentGid: "1000" }),
      null,
    );
  });

  it("drops to the configured pair when the server is root", () => {
    assert.deepEqual(
      resolveChildCredentials({ serverUid: 0, agentUid: "1000", agentGid: "1000" }),
      { uid: 1000, gid: 1000 },
    );
    assert.deepEqual(
      resolveChildCredentials({ serverUid: 0, agentUid: "501", agentGid: "20" }),
      { uid: 501, gid: 20 },
    );
  });

  it("asks for nothing when the agent uid is root", () => {
    // Not a boundary — it is the server's own identity — but not a typo to
    // refuse either: compose fills this from `UF_UID`, so a host whose own uid
    // is 0 has root-owned bind mounts and no separable uid to run an agent as.
    // Throwing would take that install down over something it cannot change,
    // where `null` is the pre-split arrangement, which the boot log names.
    assert.equal(
      resolveChildCredentials({ serverUid: 0, agentUid: "0", agentGid: "0" }),
      null,
    );
  });

  it("refuses a uid with no gid beside it", () => {
    // libuv sets gid then uid and never calls setgroups, so a child handed no
    // gid keeps the server's — group 0 on this image.
    assert.throws(
      () =>
        resolveChildCredentials({ serverUid: 0, agentUid: "1000", agentGid: "" }),
      /UF_AGENT_GID/,
    );
  });

  it("refuses a name where an id belongs", () => {
    // `UF_AGENT_UID=node` is the plausible typo, and silently ignoring it is a
    // container that reports privilege separation and has none.
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 0,
          agentUid: "node",
          agentGid: "1000",
        }),
      /numeric id/,
    );
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 0,
          agentUid: "1000",
          agentGid: "-1",
        }),
      /numeric id/,
    );
  });

  it("refuses to start unseparated when separation was asked for", () => {
    // The load-bearing case. An operator who pins `user:` back to their own uid
    // in a compose override, while compose still names an agent uid, gets a
    // server that cannot switch uids — and every boundary in the app quietly
    // stops existing. Throwing puts that at the boot rather than nowhere.
    assert.throws(
      () =>
        resolveChildCredentials({
          serverUid: 1000,
          agentUid: "1000",
          agentGid: "1000",
        }),
      /cannot switch to another/,
    );
  });
});

/**
 * The gid that keeps a live MCP capability away from a concurrent work cycle.
 *
 * Its failure is the quietest in this file: the capability file is written,
 * chowned and read exactly as before, the turn works, the boot log says
 * separation is on — and the group it was handed to is one every agent is
 * already in, so `0710`/`0040` grant precisely what they were written to refuse.
 * Nothing downstream can tell the two apart, which is why the collision is a
 * refusal rather than a fallback.
 */
describe("resolveChatGid", () => {
  const agents = { uid: 1000, gid: 1000 };

  it("asks for nothing when there is no uid split to sharpen", () => {
    // `npm run dev`, the test suite, and a host whose own uid is 0. Compose sets
    // UF_CHAT_GID unconditionally, so this pair is a normal state rather than a
    // misconfiguration: one uid means a sibling reads whatever this process can
    // write, whatever group carries it.
    assert.equal(
      resolveChatGid({ separated: null, chatGid: "65533" }),
      null,
    );
  });

  it("asks for nothing when no chat gid is configured", () => {
    // The uid split whole, minus this one boundary. `describeSeparation()` is
    // what stops that being silent.
    assert.equal(resolveChatGid({ separated: agents, chatGid: undefined }), null);
    assert.equal(resolveChatGid({ separated: agents, chatGid: "  " }), null);
  });

  it("takes the configured group when the agents run in another", () => {
    assert.equal(resolveChatGid({ separated: agents, chatGid: "65533" }), 65533);
    assert.equal(
      resolveChatGid({ separated: { uid: 501, gid: 20 }, chatGid: "65533" }),
      65533,
    );
  });

  it("refuses the group the agents already run in", () => {
    // The whole defect, expressed as configuration: the file would be handed to
    // the group it is being kept from, and every mode on it would still read as
    // tightened. This is why the shipped default is far from the range an
    // operator's own UF_GID lands in.
    assert.throws(
      () => resolveChatGid({ separated: agents, chatGid: "1000" }),
      /every agent already runs as/,
    );
  });

  it("refuses group 0", () => {
    // The server's own group on this image, so the capability would come back
    // within reach of the half of the split it is kept from.
    assert.throws(
      () => resolveChatGid({ separated: agents, chatGid: "0" }),
      /server's own group/,
    );
  });

  it("refuses a name where an id belongs", () => {
    assert.throws(
      () => resolveChatGid({ separated: agents, chatGid: "ufchat" }),
      /numeric id/,
    );
  });
});

/**
 * What that group then buys, judged the way the kernel judges it.
 *
 * `resolveChatGid` above settles *which* group; this settles the mode pair, and
 * it is the last decision before `writeMcpConfig` writes the bytes — that
 * function applies whatever it is handed and re-checks none of it. The
 * assertions are access questions rather than two octal literals because a
 * literal is not what has to hold: `0640` reads as tighter than `0710` and hands
 * the file to its owner, and `0044` reads as tighter than `0040` and hands it to
 * every agent on the box. What must hold is that the agents' credentials are
 * refused and the turn's own child is not.
 *
 * The refusal itself is not observable from here: a unit test is one process
 * under one uid and cannot be turned away by a mode it wrote. That is what the
 * `docker compose exec` form in `docs/verification.md` watches happen.
 */
describe("resolveMcpConfigOwnership", () => {
  const agents: ChildCredentials = { uid: 1000, gid: 1000 };
  const chatGid = 65533;
  const READ = 0o4;
  const TRAVERSE = 0o1;

  /**
   * Which of the three permission classes a set of credentials is judged by.
   *
   * POSIX takes the first class that matches and never falls through to a later
   * one, which is the whole of why a group works here: an agent is neither the
   * owner nor in the group, so it is left with "other" however generous the
   * group bits are.
   */
  function bitsFor(
    mode: number,
    owner: ChildCredentials,
    by: ChildCredentials,
  ): number {
    if (by.uid === owner.uid) return (mode >> 6) & 0o7;
    if (by.gid === owner.gid) return (mode >> 3) & 0o7;
    return mode & 0o7;
  }

  function ownership(): McpConfigOwnership {
    const own = resolveMcpConfigOwnership({ separated: agents, chatGid });
    if (!own) {
      throw new Error("a uid split with a chat gid must hand the config to it");
    }
    return own;
  }

  /**
   * Who owns the directory and the file. The server writes both and
   * `chownToGroup` leaves the owner alone, and a separated server is root —
   * `resolveChildCredentials` refuses to start on any other arrangement.
   */
  function ownerOf(own: McpConfigOwnership): ChildCredentials {
    return { uid: 0, gid: own.gid };
  }

  it("refuses a work-cycle agent that already knows the path", () => {
    // The defect, written as the thing that has to stay false. `--mcp-config
    // <path>` is an argv element and /proc/<pid>/cmdline is world-readable, so
    // knowing the path is assumed rather than defended against: moving the file
    // out of /tmp closed enumeration and nothing else. These two bits are the
    // whole of what stands between a concurrent agent and a live capability.
    const own = ownership();
    const owner = ownerOf(own);
    assert.equal(bitsFor(own.fileMode, owner, agents) & READ, 0);
    assert.equal(bitsFor(own.dirMode, owner, agents) & TRAVERSE, 0);
  });

  it("still lets the turn's own child open what was written for it", () => {
    // Not a formality: a config the chat child cannot read is a turn with no
    // tools at all, which reads as a model that chose to call none.
    // `chatChildCredentials` is what puts that child in this group and no
    // work cycle in it.
    const own = ownership();
    const owner = ownerOf(own);
    const chatChild: ChildCredentials = { uid: agents.uid, gid: own.gid };
    assert.equal(bitsFor(own.fileMode, owner, chatChild) & READ, READ);
    assert.equal(bitsFor(own.dirMode, owner, chatChild) & TRAVERSE, TRAVERSE);
  });

  it("asks for nothing when there is no group to hand it to", () => {
    // Both fall back whole rather than half-applying a boundary: `chat.ts` then
    // chowns to the agents' uid at 0700/0600, which is what every install had
    // before the group existed and what `describeSeparation()` says out loud.
    assert.equal(resolveMcpConfigOwnership({ separated: null, chatGid }), null);
    assert.equal(
      resolveMcpConfigOwnership({ separated: agents, chatGid: null }),
      null,
    );
  });
});
