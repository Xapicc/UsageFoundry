#!/usr/bin/env node
/**
 * Point `.next` at a scratch directory off the bind mount, when there is one.
 *
 * `next build` cannot finish in a checkout under `/workspace` — the Docker bind
 * mount, `fuseblk`. Compilation, typechecking and static generation all pass;
 * the `output: "standalone"` copy then dies on a spurious `ENOENT` or `ENOTDIR`
 * from a recursive `mkdir` whose parent directory is right there in the listing,
 * at a different path every run. It is the copy's own concurrency against that
 * filesystem's directory cache, not anything about the tree: pristine `HEAD`
 * fails identically, and the same source on `overlayfs` builds every time.
 *
 * So this hands the copy a filesystem that does not do that. It runs before
 * `next build` and does nothing at all unless the checkout is on a filesystem
 * named below *and* a scratch root exists that is not — which is why it is inert
 * in the image build, where `/app` is on the image's own filesystem.
 *
 * A symlink rather than `distDir`, and the difference is not cosmetic. Both were
 * measured. Pointing `distDir` outside the project makes Next rewrite
 * `tsconfig.json`'s `include` to reach back in through `../../..`, and the route
 * types it generates there can no longer resolve `next` — the build fails at
 * "Checking validity of types" having also dirtied a tracked file. Node repeats
 * the same failure at page-data collection, because it resolves the *real* path
 * of what it requires and then walks up from the scratch directory looking for
 * `node_modules`. Keeping the path spelled `.next` costs neither: every consumer
 * — `tsconfig.json`, `next start`, `smoke-pages.mjs`, the Dockerfile's
 * `COPY --from=builder /app/.next/standalone` — is handed the string it already
 * expects, and the kernel resolves it. The `node_modules` link beside the
 * scratch `.next` is what answers Node's walk up, and is load-bearing.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * Named rather than inferred, and a denylist rather than an allowlist, because
 * this is the one filesystem the defect has been measured on. Anything else —
 * including a filesystem with the same defect nobody has hit yet — gets today's
 * behaviour rather than a redirection nobody has tested.
 *
 * Two spellings of one mount: `statfs` reports the generic FUSE type, so
 * `stat -f -c %T` says `fuseblk` where the mount table says `virtiofs`. Both are
 * listed so a reader grepping for either name finds this line.
 */
const RACY_FILESYSTEMS = new Set(["virtiofs", "fuseblk"]);

/**
 * Reads the mount table rather than shelling out to `stat -f`, whose `%T` is a
 * GNU extension the image's coreutils may not have. Absent `/proc` — macOS —
 * this returns null and the caller does nothing, which is correct there.
 */
function filesystemType(target) {
  let mountinfo;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  let deepest = null;
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    // A mount point containing a space is escaped as \040 here; leaving it
    // encoded simply fails to match, which lands on the no-op path.
    const mountPoint = line.split(" ")[4];
    const type = line.slice(separator + 3).split(" ")[0];
    const contains = target === mountPoint || target.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (contains && (!deepest || mountPoint.length > deepest.mountPoint.length)) {
      deepest = { mountPoint, type };
    }
  }
  return deepest?.type ?? null;
}

function findScratchRoot() {
  for (const base of [process.env.TMPDIR, "/tmp"]) {
    if (!base || !existsSync(base)) continue;
    if (RACY_FILESYSTEMS.has(filesystemType(base))) continue;
    return base;
  }
  return null;
}

function ensureSymlink(linkPath, target) {
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (isSymlink(linkPath) && readlinkSync(linkPath) === target) return false;
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath);
  return true;
}

function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

const projectDir = process.cwd();
if (!RACY_FILESYSTEMS.has(filesystemType(projectDir))) process.exit(0);

const scratchRoot = findScratchRoot();
// Every candidate scratch root is on a racy filesystem too, so there is nowhere
// better to put the output. Saying so beats a build that fails several minutes
// later for a reason this file already knew.
if (!scratchRoot) {
  console.warn("redirect-dist-dir: no scratch root off the bind mount; the standalone copy may fail");
  process.exit(0);
}

const distPath = path.join(projectDir, ".next");
// Keyed on the checkout, because sibling worktrees build concurrently and a
// shared scratch directory would have them overwrite each other's output.
const scratchDir = path.join(scratchRoot, `next-dist-${createHash("sha1").update(projectDir).digest("hex").slice(0, 12)}`);
const scratchDist = path.join(scratchDir, ".next");

// `rm -rf .next` has to keep meaning a clean build. It removes the link and
// leaves the scratch behind, so an absent link is what says to discard it.
if (!isSymlink(distPath)) rmSync(scratchDist, { recursive: true, force: true });
mkdirSync(scratchDist, { recursive: true });
ensureSymlink(path.join(scratchDir, "node_modules"), path.join(projectDir, "node_modules"));
ensureSymlink(distPath, scratchDist);

console.log(`redirect-dist-dir: .next -> ${scratchDist} (checkout is on ${filesystemType(projectDir)})`);
