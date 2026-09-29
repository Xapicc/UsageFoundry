import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * Two pure functions, both earning a test the same way: their failure is
 * silent. A manifest wrongly accepted yields a plugin the page reports as
 * enabled and the CLI ignores, and a malformed argv fragment changes what a
 * spawn is permitted to do without changing anything visible.
 *
 * The switch itself is driven against a real mount and a real database, on the
 * same grounds: a plugin that cannot be switched off keeps reaching every work
 * cycle's argv, and nothing about that looks different from one the operator
 * meant to leave on. `DATA_DIR` and the mount are named before the first import
 * of `plugins.ts`, for `deleteBranch.test.ts`' reason: `config.ts` is read at
 * module load.
 */

let plugins: typeof import("./plugins");
let root: string;
let mount: string;

const MOUNT_DIR = "plugins-mount";

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-plugins-")));
  mount = path.join(root, MOUNT_DIR);
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = mount;
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(mount, { recursive: true });

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  plugins = await import("./plugins");
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pluginDirArgs", () => {
  it("emits nothing at all for an empty list", () => {
    // The failure this pins is not cosmetic. A bare `--plugin-dir` with no
    // value takes the *next* argv entry as its path, which in `buildArgs` is
    // whatever flag follows — so an install with no plugins enabled would hand
    // the run a permission mode nobody chose.
    assert.deepEqual(plugins.pluginDirArgs([]), []);
    assert.deepEqual(plugins.pluginDirArgs([""]), []);
  });

  it("repeats the flag per directory rather than joining them", () => {
    // `claude --help`: "repeatable: --plugin-dir A --plugin-dir B". A joined
    // list is accepted as a single path that does not exist, and a plugin path
    // that does not exist is skipped with a warning and exit 0.
    assert.deepEqual(plugins.pluginDirArgs(["/workspace/a", "/workspace/b"]), [
      "--plugin-dir",
      "/workspace/a",
      "--plugin-dir",
      "/workspace/b",
    ]);
  });

  it("keeps the caller's order", () => {
    const dirs = ["/workspace/z", "/workspace/a"];
    assert.deepEqual(plugins.pluginDirArgs(dirs), [
      "--plugin-dir",
      "/workspace/z",
      "--plugin-dir",
      "/workspace/a",
    ]);
  });
});

describe("parsePluginManifest", () => {
  it("reads the fields the page shows", () => {
    const out = plugins.parsePluginManifest(
      JSON.stringify({ name: "orient", version: "0.1.0", description: "  git state  " }),
    );
    assert.deepEqual(out, { name: "orient", version: "0.1.0", description: "git state" });
  });

  it("refuses a manifest with no name", () => {
    // The CLI needs a name to address the plugin by. Without one the directory
    // loads as nothing, which from the outside is indistinguishable from the
    // plugin having no effect.
    const out = plugins.parsePluginManifest(JSON.stringify({ version: "1.0.0" }));
    assert.ok("error" in out && /no name/i.test(out.error));
    assert.ok("error" in plugins.parsePluginManifest(JSON.stringify({ name: "   " })));
  });

  it("refuses malformed JSON rather than treating it as absent", () => {
    const out = plugins.parsePluginManifest("{ not json");
    assert.ok("error" in out && /not valid JSON/i.test(out.error));
  });

  it("refuses a manifest that is not an object", () => {
    // `JSON.parse("null")` and `JSON.parse("[]")` both succeed, and a plain
    // property read on either yields undefined rather than throwing — so
    // without this branch an array would fall through to the no-name refusal
    // by accident rather than by decision.
    assert.ok("error" in plugins.parsePluginManifest("null"));
    assert.ok("error" in plugins.parsePluginManifest("[]"));
    assert.ok("error" in plugins.parsePluginManifest('"orient"'));
  });

  it("treats absent optional fields as null, not as empty strings", () => {
    // The page distinguishes "no version declared" from a blank one, and a
    // blank string renders as a version that exists and is empty.
    const out = plugins.parsePluginManifest(JSON.stringify({ name: "x", description: "  " }));
    assert.deepEqual(out, { name: "x", version: null, description: null });
  });
});

/** A plugin directory directly under the mount, with a manifest that parses unless told otherwise. */
function writePlugin(name: string, manifest = JSON.stringify({ name })): string {
  const dir = path.join(mount, name);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), manifest);
  return dir;
}

function breakManifest(dir: string): void {
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "{ not json");
}

describe("setPluginEnabled and enabledPluginDirs", () => {
  it("switches off a plugin whose manifest no longer parses", () => {
    const dir = writePlugin("manifest-breaks");
    plugins.setPluginEnabled(dir, true);
    breakManifest(dir);

    plugins.setPluginEnabled(dir, false);

    assert.ok(!plugins.enabledPluginDirs().dirs.includes(dir));
    // Mended again, it stays off: the entry is gone from the store rather than
    // withheld while broken, so repairing the manifest does not quietly put the
    // plugin back into every work cycle.
    writePlugin("manifest-breaks");
    assert.ok(!plugins.enabledPluginDirs().dirs.includes(dir));
  });

  it("switches off a plugin whose folder has gone", () => {
    const dir = writePlugin("folder-goes");
    plugins.setPluginEnabled(dir, true);
    fs.rmSync(dir, { recursive: true });

    plugins.setPluginEnabled(dir, false);

    assert.ok(!plugins.enabledPluginDirs().missing.includes(dir));
    // What a stranded entry cost before: a different plugin written to the same
    // path later was loaded into every cycle without anyone pressing the switch.
    writePlugin("folder-goes", JSON.stringify({ name: "someone-else" }));
    assert.ok(!plugins.enabledPluginDirs().dirs.includes(dir));
  });

  it("withholds an enabled plugin whose manifest breaks from every spawn", () => {
    // Enabling refuses exactly this manifest, so a stored entry must not reach
    // `--plugin-dir` in a state the switch would have refused.
    const dir = writePlugin("withheld");
    plugins.setPluginEnabled(dir, true);
    assert.ok(plugins.enabledPluginDirs().dirs.includes(dir));

    breakManifest(dir);

    const { dirs, broken } = plugins.enabledPluginDirs();
    assert.ok(!dirs.includes(dir));
    const entry = broken.find((b) => b.path === dir);
    assert.ok(entry && /not valid JSON/.test(entry.error), JSON.stringify(broken));
  });

  it("still proves containment and the manifest before switching one on", () => {
    // Both containment phases are load-bearing: the lexical one for a path
    // outside every mount, the one after `realpathSync` for a symlink inside
    // the mount that points out of it.
    const outside = path.join(root, "outside-plugin");
    fs.mkdirSync(path.join(outside, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    assert.throws(() => plugins.setPluginEnabled(outside, true), /not inside a workspace mount/);
    const link = path.join(mount, "link-out");
    fs.symlinkSync(outside, link);
    assert.throws(() => plugins.setPluginEnabled(link, true), /not inside a workspace mount/);

    const broken = writePlugin("never-parsed", "{ not json");
    assert.throws(() => plugins.setPluginEnabled(broken, true), /not valid JSON/);
    assert.throws(
      () => plugins.setPluginEnabled(path.join(mount, "no-such-plugin"), true),
      /not inside a workspace mount/,
    );

    const stored = plugins.enabledPluginDirs();
    for (const refused of [outside, link, fs.realpathSync(link), broken]) {
      assert.ok(!stored.dirs.includes(refused) && !stored.missing.includes(refused), refused);
    }
  });
});

describe("discoverPlugins' problems", () => {
  it("offers the switch-off beside every enabled plugin the list cannot show", () => {
    const broken = writePlugin("problem-broken");
    plugins.setPluginEnabled(broken, true);
    breakManifest(broken);
    const gone = writePlugin("problem-gone");
    plugins.setPluginEnabled(gone, true);
    fs.rmSync(gone, { recursive: true });
    // Deeper than discovery looks, so it is loaded and yet has no row, and so
    // no switch, in the list.
    const deep = path.join(mount, "deep", "a", "b", "c");
    fs.mkdirSync(path.join(deep, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(deep, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "deep" }));
    plugins.setPluginEnabled(deep, true);
    const neverEnabled = writePlugin("problem-never-enabled", "{ not json");

    const { plugins: listed, problems } = plugins.discoverPlugins();
    const about = (dir: string) => problems.filter((p) => p.message.includes(dir));

    for (const dir of [broken, gone, deep]) {
      assert.ok(!listed.some((p) => p.path === dir), dir);
      // One entry, not the malformed-manifest line *and* a "no longer present"
      // one, which is what an enabled broken plugin used to produce.
      assert.deepEqual(
        about(dir).map((p) => p.enabledPath),
        [dir],
        JSON.stringify(problems),
      );
    }
    // Nothing to switch off: it was never on.
    assert.deepEqual(
      problems.filter((p) => p.message.startsWith("problem-never-enabled")).map((p) => p.enabledPath),
      [null],
      JSON.stringify(problems),
    );
    assert.ok(!about(neverEnabled).some((p) => p.enabledPath !== null));
  });

  it("reports a mount root whose own manifest is broken, once", () => {
    // The root is looked at apart from the walk, and that branch used to drop a
    // manifest that did not parse with no line at all.
    const manifestDir = path.join(mount, ".claude-plugin");
    fs.mkdirSync(manifestDir, { recursive: true });
    const aboutRoot = () =>
      plugins
        .discoverPlugins()
        .problems.filter((p) => p.message.startsWith(`${MOUNT_DIR}: `) || p.enabledPath === mount);
    try {
      breakManifest(mount);
      const off = aboutRoot();
      assert.deepEqual(off.map((p) => p.enabledPath), [null], JSON.stringify(off));
      assert.match(off[0].message, /not valid JSON/);

      // Enabled, the stored-entry pass reports it with its switch-off, and the
      // root's own line would be the same problem again with no control.
      fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify({ name: "root" }));
      plugins.setPluginEnabled(mount, true);
      breakManifest(mount);
      const on = aboutRoot();
      assert.deepEqual(on.map((p) => p.enabledPath), [mount], JSON.stringify(on));
    } finally {
      plugins.setPluginEnabled(mount, false);
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});
