# The stack unit

**What one stack is, as an artifact a human writes.** The mechanism that consumes
it is [01a-mechanism.md](01a-mechanism.md); this file is the format, the closed
verb list, the refusals, and the Terraform example written out exactly as an
author would write it.

Checked against the tree at `baf051d`. The Terraform URLs and digests in §5 were
fetched from the publisher on 2026-09-12 and the commands that fetched them are
printed beside them; everything about what the applier does with them is design
rather than observation, because **this container has no Docker**.

---

## 1. A stack is a directory

```
stacks/
  terraform/
    stack.json        required, and the only file the applier reads
    README.md         optional, for the author's prose
```

**The directory name is the stack's identity.** Two stacks are distinct when
their directories are distinct, which means the filesystem enforces uniqueness
and the applier does not have to. `stack.json`'s `name` must equal the directory
name, and a mismatch is a refusal rather than a rename, because a mismatch means
somebody copied a directory and did not finish, and silently trusting either one
of the two is how the operator ends up with a tool they did not choose.

`name` is required even though the directory already carries it, because the file
has to be self-describing when it is read out of its directory: in a gist, in a
pull request, in a chat message. That is what R2's *"a third party can author,
copy and share"* costs, and it costs one line.

**JSON, not TOML or YAML.** `JSON.parse` is in the language, this repository has
four production dependencies (`package.json`) and a format needing a fifth is a
format this design cannot have. It is also what this tree already uses for
operator-authored declarative data: `settings.json` under `DATA_DIR`, the CLI's
`--settings`, and the managed settings the entrypoint writes at
`docker-entrypoint.sh:423-441`. The objection that JSON cannot carry a comment is
answered by the stack being a **directory**: prose goes in `README.md` beside the
declaration, where it can be as long as it needs to be.

---

## 2. The schema

```
{
  "schema":  1,                     required, integer, currently 1
  "name":    "<string>",            required, must equal the directory name
  "summary": "<string>",            optional, one line, shown in the read-back
  "install": [ <step>, ... ],       required, at least one, applied in file order
  "env":     { "KEY": "<value>" },  optional, exported to every agent child
  "state":   [ "<relative path>" ], optional, directories created under {state}
  "allow":   [ "<argv prefix>" ]    optional, what a work cycle may run
}
```

Three tokens expand inside `install`, `env` and `state` values, and nothing else
does. There is no shell, so there is no `$VAR`, no backtick and no `$( )`.

| Token | Expands to | Why it exists |
|---|---|---|
| `{arch}` | `amd64` or `arm64`, from `dpkg --print-architecture` | the same call the image already makes at `Dockerfile:164` |
| `{state}` | `/var/lib/uf-stacks/state/<name>` | `C6`: the tool's own cache, relocated off `$HOME` |
| `{pkg}` | `/var/lib/uf-stacks/pkg/<name>` | where the step installs to, before it is linked |

### 2.1 `install` steps: three verbs and nothing else

Each step is an object with a `kind` drawn from a closed list. This is
`11-option-allowlisted-installer.md`'s closed verb list with constant argv
templates, applied where it belongs, and it is what keeps *"never a shell"*
(`docs/agent/security.md:14`) true of an artifact a third party wrote.

**`archive`** - the general one, and the one the operator's own example needs.

```
{ "kind": "archive",
  "url": "<https:// url, may contain {arch}>",
  "checksums": "<https:// url of the publisher's checksum manifest>",
  "sha256": "<64 hex chars>",        // optional, and see §6
  "unpack": "zip" | "tar.gz" | "none",
  "bin": [ { "from": "<path inside the archive>", "as": "<name on PATH>" } ] }
```

Exactly one of `checksums` and `sha256` is required. The applier downloads to a
scratch directory, verifies, and only then unpacks. **Nothing downloaded is
executed by the applier at any point**, which is the property that separates this
verb from the two below.

**`uv-tool`** - `uv tool install <spec>`, with `UV_TOOL_BIN_DIR={pkg}/bin`.
This is the existing `UF_PY_TOOLS` loop's command, `uv_as_agent tool install
"$1"` (`docker-entrypoint.sh:233`),
pointed at the toolbox instead of at `/home/node/pytools`, which is the
agent-writable directory `01a-` §2.2 refuses to add a second of.

```
{ "kind": "uv-tool", "spec": "ruff==0.14.1", "bin": ["ruff"] }
```

**`npm-global`** - `npm install -g --prefix {pkg} <spec>`.

```
{ "kind": "npm-global", "spec": "@musistudio/claude-code-router@1.0.66", "bin": ["ccr"] }
```

**`uv-tool` and `npm-global` execute code the package ships**, at install time,
as the agent uid. That is not a change this design makes: it is what
`docker-entrypoint.sh:233` already does with `UF_PY_TOOLS`, and it is stated here
rather than glossed because §6's honesty about integrity depends on it. A stack
using either verb is as trusted as the package it names. A stack using `archive`
is as trusted as the URL it names, and nothing it downloads runs until an agent
runs it.

`gh extension install` is deliberately **not** a fourth verb. `UF_GH_EXTENSIONS`
already does it in one `.env` line, and already pins:
`gh_as_agent extension install "$1" --pin "$2"` (`docker-entrypoint.sh:159-161`) and replacing a
working loop is churn; `01d-` §1 says what the boundary between the two
mechanisms is.

### 2.2 `env`

Exported into the server's environment at boot and reaching every agent child
through `childEnv`, which copies the server's environment and strips prefixes and
names that do not include these (`src/lib/orchestrator.ts:5698-5716`). Four
refusals, each with the silent failure it prevents:

| Refused | Because |
|---|---|
| any key matching `UF_*` | `childEnv` deletes the whole prefix, so it would be set and then silently absent in every child (`C2`) |
| `PATH`, `HOME`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DATA_DIR`, `GIT_*`, `CLAUDE_*`, `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*` | a stack that can set these is a stack that can redirect the app, not just add a tool |
| any value containing a shell metacharacter | there is no shell to interpret it, so a value that assumes one is a bug the author should be told about at parse time |
| any value resolving under `/home/node/.claude` | that bind is the **host's** `~/.claude` for every session on the machine (`docker-compose.yml:401`), and `.env.example:304` already warns about a tool that *"wires itself in globally" on first run* |

### 2.3 `state`

Relative paths, created under `{state}` before the first run, owned by the agent
uid. It exists because some tools refuse to start when a directory they were
pointed at is absent - Terraform is one, which is why the example needs it - and
because the alternative is every stack author discovering that separately.

### 2.4 `allow`

Each entry is an argv prefix. The applier turns `"terraform plan"` into
`Bash(terraform plan:*)` and appends it to the work cycle's `--allowedTools`,
beside `ISOLATED_GIT_TOOLS = ["Bash(git add:*)", "Bash(git commit:*)"]`
(`src/lib/cycleInvocation.ts:633`). Why this is needed at all, and what would
make it unnecessary, is [01c-reach-and-permission.md](01c-reach-and-permission.md).

**The first word of every entry must be a binary this stack itself links.** A
stack may grant its own tools and nothing else. Without that rule a shared
`stack.json` could carry `"rm -rf"` or `"curl"` and an operator copying a
directory would be handing an agent a capability they never read, which is the
whole trust boundary of R2 failing on one line of a file nobody scrolled through.

**`allow` is optional and its default is empty**, so a stack author must opt in
by naming the commands. That is deliberate and the Terraform example shows why:
a blanket `terraform` grant includes `terraform apply`, and an agent that can
`terraform apply` can change infrastructure that is not in any of this app's
budgets, guards or diffs. The cost of the safe default is the one quiet failure
`01a-` §8 names: a stack that installs perfectly and grants nothing looks fine
and fails inside a tool call. R5 point 3 is what makes it visible.

---

## 3. What is refused at parse, before anything is downloaded

Unknown top-level key; unknown `kind`; `schema` other than `1`; `name` not equal
to the directory name; a `url` or `checksums` that is not `https://`; an
`unpack` other than the three; a `bin.from` that escapes `{pkg}` after
normalisation; a `sha256` that is not 64 hex characters; any `env` key or value
from §2.2's table; any `allow` entry whose first word is not one of this stack's
own `bin` names; any `allow` entry containing `(` or `)`, which would otherwise
let a grant close the `Bash(...)` it is being interpolated into.

All of them write a `failed` receipt carrying the reason, and none of them stops
the boot or the other stacks.

---

## 4. What the applier does with a step, in order

1. `curl -fsSL --proto '=https' --tlsv1.2` the artifact and the checksum manifest
   into a scratch directory. `curl -fsSL` is `Dockerfile:171`'s own flag set; the
   two `--proto`/`--tlsv1.2` additions are this design's, and they are worth one
   flag each here because the URL came out of a file a stranger wrote rather than
   out of a reviewed `Dockerfile` line.
2. `sha256sum --ignore-missing --check` against the manifest, or compare against
   `sha256`, with `sha256sum --ignore-missing --check` as at `Dockerfile:173`.
   **Non-zero here ends the stack**: nothing is unpacked, nothing is
   linked, the receipt is `failed`.
3. Unpack. `tar -xzf` for `tar.gz`; for `zip`, **`python3 -m zipfile -e`**, which
   is stdlib in the `python3` already in the image at `Dockerfile:130`, because
   the image has no `unzip` - `command -v unzip` returns nothing in this
   container, where `tar`, `python3`, `curl`, `jq`, `sha256sum` and `install` all
   resolve.
4. **`chmod 0755` every file named in `bin`.** `python3 -m zipfile` does not
   preserve the executable bit. Measured in this container on 2026-09-12: a file
   zipped at `0755` extracts at `0644`, which would otherwise be a `Permission
   denied` inside a tool call at the far end of a green install.
5. `chown -R root:root {pkg}` and `chmod -R go-w {pkg}`.
6. `install -m 0755` each `bin` entry into `/var/lib/uf-stacks/bin/<as>`, as
   root, which is `Dockerfile:175`'s own idiom for the same act.

Steps 1 to 4 run under
`setpriv --reuid="$UF_AGENT_UID" --regid="${UF_AGENT_GID:-$UF_AGENT_UID}"
--clear-groups`, the form `docker-entrypoint.sh:147-148` and `:218-219` already
use. Steps 5 and 6 are root's.
`01a-` §6 gives the reason the split is safe here and would not be at run time.

---

## 5. The worked example: Terraform

`stacks/terraform/stack.json`, complete, as an author writes it:

```json
{
  "schema": 1,
  "name": "terraform",
  "summary": "HashiCorp Terraform 1.13.1, with its provider cache off $HOME.",
  "install": [
    {
      "kind": "archive",
      "url": "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_linux_{arch}.zip",
      "checksums": "https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_SHA256SUMS",
      "unpack": "zip",
      "bin": [{ "from": "terraform", "as": "terraform" }]
    }
  ],
  "env": {
    "TF_PLUGIN_CACHE_DIR": "{state}/plugin-cache",
    "TF_CLI_ARGS_init": "-input=false",
    "CHECKPOINT_DISABLE": "1"
  },
  "state": ["plugin-cache"],
  "allow": [
    "terraform version",
    "terraform fmt",
    "terraform validate",
    "terraform init",
    "terraform plan"
  ]
}
```

`stacks/terraform/README.md`, which the applier never reads:

```markdown
# terraform

Terraform 1.13.1. `terraform apply` is deliberately not granted: a work cycle can
read, format, validate and plan, and a person applies.

Upgrading: change all three occurrences of the version and restart. The provider
cache in `state/` is kept across the upgrade.
```

**What each line is doing.**

`{arch}` is there because this image is built for both architectures and a stack
that hardcodes `amd64` is a stack that installs nothing on the other one, quietly,
because the 404 arrives at boot and the operator reads the log once.

`checksums` rather than a literal digest is the choice §6 argues: it is the
publisher's own manifest, covering both architectures, and it is the same
property the image already has. **Both are real.** Fetched 2026-09-12 with
`curl -fsS https://releases.hashicorp.com/terraform/1.13.1/terraform_1.13.1_SHA256SUMS`:

```
4449e2ddc0dee283f0909dd603eaf98edeebaa950f4635cea94f2caf0ffacc5a  terraform_1.13.1_linux_amd64.zip
2bb0787c2da1ad94d6a495a848aad4e9b572adb02bfc7361afeee80f07fd90ac  terraform_1.13.1_linux_arm64.zip
```

`unpack: "zip"` is the field that made §4 step 3 necessary. The operator's own
example is the case the image cannot already handle: **Terraform ships a zip and
this image has no `unzip`.**

`TF_PLUGIN_CACHE_DIR` is `C6` in one line. Without it Terraform writes providers
under `$HOME/.terraform.d`, which is the writable layer and is gone on the next
`docker compose up --build` - and the symptom is not an error but every
`terraform init` re-downloading a few hundred megabytes, which is a slow work
cycle the operator pays for and cannot see. `state: ["plugin-cache"]` exists
because Terraform errors rather than creating that directory itself.

`allow` names five commands and not `terraform apply`. The grant is a prefix, so
`terraform plan -out=tf.plan` is covered by `terraform plan`; `terraform apply`
matches no entry and falls back to `acceptEdits`, which will refuse it in a
headless run. That is the design working, not failing.

**Adding this to an install is:** copy the directory into `./stacks/`,
`docker compose up -d`. Nothing else. `git diff --name-only` over the commit is
`stacks/terraform/stack.json` and `stacks/terraform/README.md`, and no file the
image contains is among them, which is R1's own test.

---

## 6. Pinning and integrity

**The version is pinned in the declaration and nowhere else.** It appears in the
`url` and in the `checksums` url, and the declaration's digest is what the
applier reconciles against, so a version bump is an edit and a restart and there
is no resolver, no lockfile and no "latest".

**This keeps the property `22-validation.md` found and does not change it.** Every
pinned download in this repository verifies the **publisher's** digest and never
one this repository chose. The pattern is `Dockerfile:163-175`: read the
architecture from `dpkg --print-architecture`, fetch the artifact and the
publisher's `checksums.txt` beside it with `curl -fsSL -O`, then
`sha256sum --ignore-missing --check` before `install -m 0755`. The reasoning is
written out beside it at `Dockerfile:159-161`, that this is the same TLS trust as
fetching a keyring and that it fails loudly if the artefact is not the one the
manifest describes.

**The argument for keeping it, given that a stack comes from a stranger.** A
literal `sha256` chosen by the stack's author is stronger against a publisher who
re-cuts a release under the same version, and weaker against everything else,
because the author who writes the digest is the same author who writes the URL.
The trust boundary is the stack, not the digest: an operator consuming somebody
else's stack is trusting their choice of URL, and a digest they also chose adds
nothing to that. So `checksums` is the documented form and `sha256` exists for
the case the manifest does not: an artifact published without one, where the
operator takes the digest themselves once and pins it.

**What is verified before anything is executed.** The artifact, against the
manifest, before it is unpacked. Nothing else: a stack's URL is not checked
against an allowlist of hosts, and there is no signature verification, because
this repository has no key material and inventing a trust root is a larger
decision than this design. `01d-` §3 lists it among what this does not do.

**The honest sentence, and it belongs in `docs/agent/security.md`.** A stack is
software you have chosen to install, declared in a file you can read in thirty
seconds. Consuming a third party's stack is the same act as taking their `RUN`
line into your Dockerfile. What this mechanism buys is that the act is
**reviewable** - one small file, every URL and digest visible, every granted
command listed - and **revocable** - delete the directory, restart. It does not
make it safe, and nothing that installs software can.
