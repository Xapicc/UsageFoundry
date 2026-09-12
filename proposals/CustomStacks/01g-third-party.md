# The third-party story

**What a person publishes so another operator can use their stack, what the
consumer does to adopt it, and what goes wrong in between.** The format is
[01b-stack-format.md](01b-stack-format.md); this file is the part of R2 that is
about two people rather than one file, and it ends in a complete stack written
out whole.

Checked against the tree at `68a8aa7`. The example's URLs and digests were
fetched from the publishers **in this container on 2026-09-12** and the commands
that fetched them are printed beside them; both binaries were run here. Nothing
about what the applier does with them has been observed, because **this container
has no Docker**.

**Writing this example found two defects in `01b-`'s schema.** Both are §5, both
are fixed in `01b-` in place, and both were invisible to the Terraform example
because Terraform happens to publish in the one shape the schema assumed. That is
what a second worked example is for.

---

## 1. What a publisher publishes

**A directory. That is the entire answer, and keeping it the entire answer is the
requirement.**

```
shell-lint/
  stack.json      required, and the only file the applier reads
  README.md       optional, for the author's prose
```

`01b-` §1 fixes both facts: the directory name is the stack's identity, and
`stack.json` is the only file read. So publishing is putting that directory
somewhere another person can get it, and there is no second artifact, no
registration, no manifest of manifests and nothing to version but the file
itself.

**Four channels, and the design deliberately privileges none of them.**

| Channel | What the consumer does | What it costs the publisher |
|---|---|---|
| a repository | `git clone`, `cp -r shell-lint ~/uf/stacks/` | a repository |
| a directory inside an existing repository | the same, from a `stacks/` they already clone | nothing |
| a gist or a paste | save one file into a directory they name | nothing |
| a tarball | `tar -xzf`, then copy | a release |

**The gist row is why `name` is required even though the directory already
carries it.** `01b-` §1: the file *"has to be self-describing when it is read out
of its directory: in a gist, in a pull request, in a chat message."* A stack
pasted into a chat message is still a complete stack, and the consumer's
directory name is checked against it rather than inferred from it.

**There is no registry and there will not be one.** `01d-` §3 refuses
`stack install <url>` by name: *"That the copy is manual is what makes the host
filesystem the trust boundary, and a fetch verb would put the boundary back
inside the container."* The consequence for a publisher is that their stack
spreads by being copied, and the consequence for a consumer is that nothing in
this app ever fetched code on their behalf.

### 1.1 What a publisher owes a consumer, and what they cannot promise

**Owed, and all four are checkable by reading the file:**

1. **A pinned version in the URL**, never `latest`. `01b-` §6: *"The version is
   pinned in the declaration and nowhere else … so a version bump is an edit and
   a restart and there is no resolver, no lockfile and no `latest`."*
2. **An integrity claim** — `checksums`, the publisher's own manifest, where one
   exists; `sha256` where it does not, which is the case §5 exercises.
3. **An `allow` list that is the narrowest thing that works**, because `allow`
   defaults to empty and every entry in it is a capability the consumer is
   granting without having typed it.
4. **A `summary` line**, because it is what the read-back draws beside the name
   (`01b-` §2) and a stack with none is a row in somebody's Settings page saying
   nothing.

**Not owed, and a publisher who claims any of them is overclaiming:**

- that the URL will still be there. Publishers delete releases.
- that the artifact behind a `checksums` manifest has not been re-cut. `01b-` §6
  is explicit that a digest the stack's author chose *"is stronger against a
  publisher who re-cuts a release under the same version, and weaker against
  everything else, because the author who writes the digest is the same author
  who writes the URL."*
- that the tool is safe. `01b-` §6's closing sentence is the honest one and it
  belongs in a publisher's README as much as in this app's docs: *"Consuming a
  third party's stack is the same act as taking their `RUN` line into your
  Dockerfile … It does not make it safe, and nothing that installs software
  can."*

---

## 2. What a consumer does

**Four commands, and the third is the one that matters.**

```bash
git clone https://example.invalid/someone/uf-stacks /tmp/uf-stacks
cat /tmp/uf-stacks/shell-lint/stack.json          # read it. all of it.
cp -r /tmp/uf-stacks/shell-lint ./stacks/
docker compose up -d && docker compose logs -f usagefoundry
```

**The `cat` is the security model**, and this design's whole claim is that it is a
realistic act rather than a ritual. A `stack.json` is on the order of thirty
lines, there is no shell in it (`01b-` §2, and `docs/agent/security.md:14`'s
*"Never a shell. Argv arrays only"* is what makes that enforceable), and every
URL, digest, environment variable and granted command is a literal on its own
line. The five things to look at are §4's checklist.

**Nothing else is required, and that is R2.3's own test** — *"Copying that
artifact to a second install and doing nothing else produces the same tools
there"* (`01-constraints.md` R2). No `.env` edit, no `docker-compose.yml` edit,
no `Dockerfile`, which is R1. `git diff --name-only` over the consumer's commit
is `stacks/shell-lint/stack.json` and `stacks/shell-lint/README.md`, and no path
the image contains is among them.

**Adoption is reversible in one command**: `rm -r ./stacks/shell-lint` and a
restart, after which the applier removes `pkg/`, `state/` and the links its own
receipt records (`01a-` §7). `01e-` §6 is what the app says about that before the
operator does it, and the one thing worth its own sentence is that
`state/<stack>` goes with it.

---

## 3. What can go wrong between them

Nine failure modes, in the order a consumer meets them. The column that matters
is the third: this directory's own asymmetry is that a loud failure costs a log
line and a quiet one costs billed tokens forever (`01-constraints.md` R5), so
every row that is quiet is a row this design owes an answer.

| # | What | Loud or quiet | What catches it |
|---|---|---|---|
| 1 | directory renamed on copy, so `name` mismatches | **loud** | parse refusal, `failed` receipt (`01b-` §3) |
| 2 | schema key the consumer's version does not know | **loud** | unknown-key refusal (`01b-` §3) |
| 3 | URL 404s — release deleted or retagged | **loud** | `curl -f` non-zero, `failed` receipt (`01b-` §4.1) |
| 4 | digest mismatch — re-cut release, or a wrong digest | **loud** | step 2 ends the stack, nothing unpacked (`01b-` §4.2) |
| 5 | publisher's arch spelling is not `{arch}`'s | **loud, and it was a schema hole** | §5, fixed |
| 6 | one digest against a per-arch URL | **quiet, and it was the worse hole** | §5, fixed |
| 7 | two stacks claim one binary name | **loud** | both `conflicted`, neither linked (`01a-` §7) |
| 8 | installs perfectly, `allow` is empty or wrong | **quiet** | R5 point 3 — `unverified`, then `failing` ([01f-](01f-read-back.md) §3) |
| 9 | the tool is malicious | **silent, and nothing here catches it** | §3.1 |

**Row 6 is the one this section exists for.** Before §5, a stack whose URL varied
by architecture and whose publisher shipped no manifest would install on one
architecture and fail the digest on the other — which is loud — *or*, if the
author pinned the digest for the arch they happened to be on and the consumer was
on the other, produce a `failed` receipt on a machine the author never tested. It
never installs the wrong software, because the digest check is before the unpack
and there is no branch where a mismatch proceeds; what it does is make a
correct-looking stack fail on half the machines that try it, and blame the
consumer's architecture in a message nobody wrote.

**Row 8 is the one the whole read-back exists for**, and it is the failure
`01a-` §8 names as this design's single quiet one. A stack that installs
perfectly and grants nothing looks fine everywhere except inside the tool call
that gets refused. `01f-` §3's composition is what makes it visible: `unverified`
while nothing has tried, `failing` once something has.

### 3.1 Row 9, stated plainly

**Nothing in this design stops a malicious stack, and no version of this design
could.** A stack names software and this app installs it; `uv-tool` and
`npm-global` execute what the package ships at install time as the agent uid
(`01b-` §2.1), and `archive` executes nothing at install time but installs a
binary an agent will run.

What the mechanism buys is stated in `01b-` §6 and does not grow here: the act is
**reviewable**, one small file with every URL and digest visible, and
**revocable**, delete the directory and restart. Two further properties come from
where the artifact lives rather than from what it says, and both are real:

- **The declaration is on the host and the mount is read-only** (`01a-` §1), so
  an agent cannot rewrite what gets installed. *"The read-only mount is a kernel
  flag, not a sentence: root inside the container cannot write it either."*
- **`allow` can only grant this stack's own binaries** (`01b-` §2.4), so a shared
  `stack.json` cannot smuggle `Bash(curl:*)` past a consumer who skimmed it. That
  rule is the difference between reviewing a file and having to review it
  carefully.

---

## 4. The consumer's checklist

Five lines to read in a `stack.json`, in priority order. This is the list a
`docs/` page would carry when the feature is promoted; it is here rather than
there because **this is still a proposal and promotion is by implementing it**.

1. **`allow`** — every entry is a command an agent may run without asking. Read
   it as if it were the whole file. `[]` is the safe answer and the default.
2. **`url`** — whose domain is it? A digest verifies that you got what the URL
   serves, never that the URL is the project's.
3. **`checksums` or `sha256`** — one must be there (`01b-` §3). Prefer
   `checksums`, which is the publisher's manifest; a bare `sha256` was chosen by
   the same person who chose the URL.
4. **`kind`** — `archive` runs nothing at install time. `uv-tool` and
   `npm-global` run whatever the package's install hooks run, as the agent uid.
5. **`env`** — refused keys are refused at parse (`01b-` §2.2), so what remains
   is by construction a variable that only affects the tool. Read it anyway; a
   proxy variable is a routing decision.

---

## 5. Two defects this example found, and the schema repair

Both were invisible against Terraform. Terraform's publisher uses Go's
architecture spelling and ships a `SHA256SUMS` manifest, which is exactly the
shape `01b-` §2 assumed, so the one worked example in the design run exercised
neither branch.

### 5.1 `{arch}` has one spelling and publishers have two

`01b-` §2 gives `{arch}` as *"`amd64` or `arm64`, from `dpkg --print-architecture`"*,
which is Debian's spelling and the one `Dockerfile:164-168` already switches on.
A large share of publishers use `uname -m`'s instead. **Measured in this
container on 2026-09-12:**

```bash
$ dpkg --print-architecture
arm64
$ uname -m
aarch64
```

shellcheck's release assets are `shellcheck-v0.11.0.linux.x86_64.tar.gz` and
`…linux.aarch64.tar.gz` — verified against
`curl -fsSL https://api.github.com/repos/koalaman/shellcheck/releases/latest | jq -r '.assets[].name'`
on 2026-09-12 — so no expansion of `{arch}` can name them.

**The repair is a second token and not a mapping table.** `{arch_uname}` expands
to `x86_64` or `aarch64`, derived from the same `dpkg --print-architecture`
switch so that exactly one thing decides what architecture this is. A table
inside the applier keyed on publisher would be configurability for a requirement
that does not exist; two tokens is the whole of the variation, because these are
the only two spellings the image's two architectures have.

### 5.2 One `sha256` cannot pin a per-arch URL

This is the worse of the two, because it is the one that produces a stack that
works for its author and fails for half its consumers.

`01b-` §2.1 gives `sha256` as *"optional, 64 hex chars"*, one string per step,
while `url` *"may contain `{arch}`"*. When both are used — which is every bare
binary published without a manifest — the declaration asserts one digest about
two different files. shfmt is exactly that case: its release carries no checksum
manifest at all (`curl -fsSL https://api.github.com/repos/mvdan/sh/releases/latest | jq -r '.assets[].name'`
on 2026-09-12 lists eight binaries and nothing else), and the two Linux binaries
digest differently, as they must:

```bash
$ sha256sum shfmt_v3.14.1_linux_amd64 shfmt_v3.14.1_linux_arm64
76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf  …amd64
5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489  …arm64
```

**The repair: `sha256` may be a string or an object keyed by `{arch}`'s value.**
A string is kept for the case it is correct in — a `url` with no `{arch}` in it —
and an object is required when the `url` contains `{arch}` or `{arch_uname}`.
That last clause is the load-bearing half: it is a **parse refusal**, so the
defect is loud at the one moment somebody can fix it rather than quiet on
somebody else's machine.

The refusal joins `01b-` §3's list, and it is the only one there that is about
two fields disagreeing rather than one field being wrong.

---

## 6. The example: a shell-linting stack

**A different shape from Terraform on every axis that matters.** Terraform is one
tool, one archive, a `zip`, a publisher manifest, a state directory and an
environment variable. This is **two tools in one stack**, two publishers, a
`tar.gz` and a bare binary, no manifest anywhere, no state and no environment —
and it is the case that found §5.

**Why two tools in one stack rather than two stacks.** `01d-` §3: *"No dependency
graph between stacks. No `depends_on`, no topological sort … two things that must
be ordered are one stack."* These two do not need ordering, but they are one
decision an operator makes — *should agents on this install lint shell scripts* —
and a stack is the unit of that decision. Splitting them would give the operator
two rows to keep in step for no property either one gains.

### `stacks/shell-lint/stack.json`

```json
{
  "schema": 1,
  "name": "shell-lint",
  "summary": "shellcheck 0.11.0 and shfmt 3.14.1, for agents editing shell scripts",
  "install": [
    {
      "kind": "archive",
      "url": "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.{arch_uname}.tar.gz",
      "sha256": {
        "amd64": "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
        "arm64": "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc"
      },
      "unpack": "tar.gz",
      "bin": [{ "from": "shellcheck-v0.11.0/shellcheck", "as": "shellcheck" }]
    },
    {
      "kind": "archive",
      "url": "https://github.com/mvdan/sh/releases/download/v3.14.1/shfmt_v3.14.1_linux_{arch}",
      "sha256": {
        "amd64": "76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf",
        "arm64": "5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489"
      },
      "unpack": "none",
      "bin": [{ "from": "shfmt_v3.14.1_linux_{arch}", "as": "shfmt" }]
    }
  ],
  "allow": ["shellcheck", "shfmt -d", "shfmt -l"]
}
```

### `stacks/shell-lint/README.md`

> Two static binaries so an agent working on shell scripts can check its own
> work. No `state`, no `env`: neither tool has a cache or a config file it needs
> pointed anywhere, and both read the script in front of them and exit.
>
> `allow` grants the two read-only invocations and deliberately not `shfmt -w`,
> which rewrites files in place. At `acceptEdits` an agent can rewrite a file
> anyway, so the grant would not add a capability — it would move a write out of
> the diff the operator reviews and into a tool call, which is a different thing
> and not one this stack should decide for you. Add `"shfmt -w"` if you want it.
>
> Upgrading: bump both versions in the URLs and both digests, restart. The
> digests are per architecture because neither project publishes a checksum
> manifest; `sha256sum` the file you downloaded, once, and pin it.

### What is different from the Terraform example, line by line

| | Terraform (`01b-` §5) | shell-lint |
|---|---|---|
| steps | one | **two, applied in file order** |
| publishers | one | **two, neither related to the other** |
| unpack | `zip` | **`tar.gz` and `none` — both other branches** |
| integrity | `checksums`, the publisher's manifest | **`sha256` per arch, because neither publishes one** |
| arch token | `{arch}` | **`{arch_uname}` and `{arch}`, one of each** |
| `state` | required, Terraform refuses to start without it | **absent** |
| `env` | one variable | **absent** |
| `allow` | narrowed away from `apply` | **narrowed away from `-w`, for a different reason** |

**Three of those rows are branches nothing had exercised**, and two of them were
broken until §5. The `zip`-only executable-bit repair at `01b-` §4.4 is the third
and it survives: `tar -xzf` preserves mode, so this stack needs it for neither
step, and the `chmod 0755` is correct as an unconditional step rather than as a
`zip` special case.

**Both binaries were run in this container on 2026-09-12**, which is a fact about
the artifacts rather than about the applier:

```bash
$ ./shellcheck --version | sed -n 2p
version: 0.11.0
$ ./shfmt --version
v3.14.1
```

That is the whole of what can be observed here. Whether the applier installs
them, whether a link survives `docker compose up --build`, and whether a work
cycle at `acceptEdits` may invoke `shellcheck` are three different questions, and
`22-validation.md` lists the commands for all three.
