# Where the bill goes, and this engine against a script loop

[← metering index](../metering.md)

Read before editing `costSplitOf` or `costSharesOf` in `src/lib/pricing.ts`, an agent's tool list in `src/lib/agents.ts`, or anything that quotes these figures.

**Where a bill went, and why a token chart does not show it.** `costSplitOf`
breaks `costOf` into its four terms - input, output, cache read, cache write -
and `costSharesOf` turns those into shares. It exists because the multipliers
are 0.1x and 2.0x, a twentyfold ratio that no token count reveals: MEASURED
across 90 deduplicated frames on one install, cache **writes** were 48.1% of
the bill from 7% of the tokens, while reads were 92% of the tokens and 31.6% of
the bill. An operator reading a token chart is looking at the volume that costs
a third and cannot see the term that decides their bill. `total` delegates to
`costOf` rather than re-summing the four - the same arithmetic, once, so a
receipt cannot disagree with the guard even in the last bits of a float.

**Why cache writes are half the bill, and why that is not a defect.** MEASURED
across 90 deduplicated frames: the median request writes **434** tokens and
reads **22,286** - writes are 7.6% of the context they sit on, and exactly one
request of ninety wrote more than 20k, which was the session's first. The
prefix is not churning; those writes are the delta of one turn being cached so
the next turn can read it.

The cost follows from the multipliers rather than from any waste. A token
admitted to the conversation is written once at 2.0x and then read at 0.1x on
every later turn, so one 434-token write costs what 8,680 read tokens cost.
That is why writes can be 7% of tokens and 48% of the bill while nothing is
going wrong.

**The lever this identifies is intake, not pruning.** Preventing a token from
entering the conversation avoids the 2.0x write entirely; removing it after the
fact pays an invalidation to do so, which is `1.9*S - 2*D` once against `0.1*D`
per later turn. Measured from this direction, that is the same conclusion
winnow reaches from its own corpus - its intake filter is worth more than its
pruner and is positive in every session rather than 58% of them - and on this
install `WINNOW_FILTER` is blank by default, so the mechanism that avoids the
dearer term is the one an operator has to go and find.

**And the lever, priced.** MEASURED on a corpus whose tool results are large
enough for the rules to fire - 12 files of ~8.4 KB, 8 work cycles, $1.2497 -
with `WINNOW_FILTER=1`: 24 filtered requests, 264 tool results seen, **12,096
bytes kept off the wire**, 0 requests inflated. Priced with the table in
`pricing.ts`: the avoided cache **write** is $0.0302, deterministic and paid
once per token; the avoided **reads** are $0.0174, summed per event over the
requests that followed it. The run would have cost $1.2973, so the saving is
**3.67%** - against winnow's independently derived +3.76%, reached on a
different install with a different method, agreeing to within 0.09 points.

The write term needs no assumptions and is the floor: **2.3% of the run**. The
read term models each kept-out byte as read on every later request, which is an
upper bound. `bytes / 4` is SPEC 6's token estimate and is flagged wherever it
is used. One run, so this is a reading rather than a rate.

**The fixed cost of starting a run, and what it is made of.** MEASURED over 12
sessions: the first request is a median **16%** of a whole session's cost, and
on short ones it is far more - one five-request session spent **55%** of its
money before doing any work, and another 50%. Two sessions paid nothing at all,
because they resumed into a warm cache.

What that first request buys is the cached prefix, written once at 2.0x.
winnow's prefix ledger names its parts: system **13,145 B**, tools **30,923 B**
across 14 definitions. **The tool definitions are 70% of the prefix** - roughly
7,730 tokens, about $0.077 at `claude-opus-5` input pricing, paid again on
every fresh session before an agent has read a line of code.

Two things follow, and neither is about pruning. Fewer, longer runs amortise a
cost that short runs pay in full - the shape `docs/agent/run-lifecycle.md`
already prefers for other reasons, now with a figure on it. And an agent's tool
list is a per-run bill: `agents.ts` gives an agent a role, and the tools that
ride with it are re-cached at 2.0x every time it starts. A leaner tool set is
not a tidiness preference; it is the cheapest lever in this file, because it is
paid on every run whether the run uses those tools or not.

**And what all of that is worth, against the alternative — not yet known.**
The same task, corpus and cycle count was run once through this engine and once
through what it replaces, a scripted `claude -p` loop starting a fresh session
each cycle. Priced by the model's own reported cost, per module completed so
the two are comparable when one finishes more:

| | cost | done | per module |
|---|---:|---:|---:|
| naive `claude -p`, fresh each cycle | $1.1090 | 8 / 12 | $0.1386 |
| this engine, 4 cycles | $0.5380 | 12 / 12 | $0.0448 |
| this engine, 8 cycles | $1.2497 | 8 / 12 | $0.1562 |

**Two runs of this engine on one corpus differ by 3.48x**, and the naive loop
falls between them. So the honest reading of these three runs is a gap of
**0.89x to 3.09x** - a range that straddles one, and therefore does not
establish that either is cheaper. It is a demonstration that the comparison is
runnable and that the per-module figure is the right unit; it is not a result.

Resolving it needs replication against a within-arm spread of 3.48x, which is
the same wall the intake filter's A/B hit and the reason that mechanism was
priced from its ledger instead. The deterministic parts of the gap - resume
paying one cold start rather than four, at a median 16% of a session - can be
priced the same way and are the honest thing to quote until then.

**What can be said without replication.** The comparison above cannot resolve a
gap of this size at one run per arm, but part of it does not need a comparison
at all - the same reasoning that let the intake filter be priced from its
ledger. A naive loop starts a session per cycle and pays a cold start each
time; a resumed loop pays one.

MEASURED on the four naive sessions: cold starts of $0.0761, $0.0875, $0.0169
and $0.0168, totalling **$0.1973**, against **$0.0493** for a single session.
The deterministic difference is **$0.1480, or 13.3%** of that run, and 13,746
prefix tokens re-cached at 2.0x that a resumed loop writes once.

Two of those four sessions wrote **no prefix at all**, which is worth knowing
before assuming the naive loop pays full price every time: the API's prefix
cache outlives a session, so back-to-back invocations inside the TTL inherit a
warm one. The penalty is real but smaller than the arithmetic suggests, and it
is a penalty on *cadence* rather than on starting a session as such.

So the defensible statement about this engine against that loop is the sum of
what has been priced rather than compared: **resume is worth about 13.3% here,
the intake filter 3.67-8.76%**, and the rest is inside a noise floor these runs
cannot see through.

**What one tool costs.** From the same prefix observation - tools 30,923 B
across 14 definitions - a tool definition averages **2,209 bytes, about 552
tokens**. Written at 2.0x on every fresh session that is **$0.0055 per tool per
run**, and $0.0773 for all fourteen.

It is paid whether the run uses the tool or not, because the definition is in
the prefix before the agent has read anything. Dropping five tools from an
agent that does not need them saves $0.0276 a run - **$2.76 per hundred runs** -
with no effect on what the agent can do with the ones it kept.

That makes `agents.ts` a metering surface as well as a permissions one. An
agent carries a role and its tools ride with it; this is what they cost to
carry. It is the only lever in this file paid on **every** run rather than in
proportion to the work, which is why it is the cheapest one here even though it
is the smallest.

**Why every figure above was priced rather than compared.** The six
identical-task runs give a coefficient of variation of **0.296**. Putting that
through a two-sample power calculation says how many runs an A/B needs to see
an effect of a given size at 80% power:

| effect | runs per arm |
|---:|---:|
| 10% | 151 |
| 13.3% | 88 |
| 20% | 42 |
| 30% | 20 |
| 50% | 9 |

The resume effect is 13.3%, so **seeing it by comparison needs about 88 runs
per arm** - at roughly $0.55 a run that is over $95 for one number. Pricing it
from the cold starts in the ledger took a single run and no comparison at all.

That asymmetry is the argument for the method used throughout this section, and
it is a property of the workload rather than of anyone's patience: agent runs
vary by 2.28x to 3.48x on identical input, so any mechanism worth less than
about 30% is invisible to an A/B at any budget an operator would accept. The
mechanisms in this app are worth 3-13%. **They can only be measured
deterministically.**

The corollary is worth stating too: a *large* effect is cheap to measure. If
this engine really were 3x the loop it replaces, nine runs per arm would show
it - about $15. That experiment is affordable and has not been run; the earlier
0.89x-3.09x range is what one run per arm buys.

**The comparison, run properly.** The power table above says a large effect is
cheap to measure, so it was measured. Five pairs, alternating, same task, same
twelve-file corpus, four cycles each, both priced by the model's own reported
cost:

| | mean | range | completed | per module |
|---|---:|---:|---:|---:|
| this engine | $0.5688 | $0.5173-$0.6378 | **12/12 every run** | **$0.0474** |
| naive `claude -p` | $1.6847 | $1.3763-$1.8574 | 8/12 every run | $0.2106 |

**4.44x cheaper per unit of work, and the distributions do not overlap** - the
engine's worst run is 3.2x better than the naive loop's best. The exact
two-tailed probability of complete separation at n=5,5 is **0.0079**. The
engine finished the work in every run; the naive loop finished two thirds of it
in every run.

Within-arm spread here is 1.23x and 1.35x, far tighter than the 2.28x-3.48x
measured on the other corpus, which is why five pairs settle it: the task is
bounded by a cycle cap and by twelve files rather than by the agent's
judgement. That is worth knowing when designing any further comparison here -
the noise floor is a property of the task, not of the loop.

This supersedes the earlier one-run reading of 0.89x-3.09x, which is what a
single pair bought and was correctly refused as a result.

**The same comparison against a competent script.** A loop that never resumes
is a weak opponent, and beating it proves mostly that resuming works. So the
arm was run again as somebody who knew what they were doing would write it -
`claude -p --continue`, five runs, same task and corpus:

| arm | n | mean | completed | per module |
|---|---:|---:|---:|---:|
| this engine | 5 | $0.5688 | **12/12 every run** | **$0.0474** |
| script, `--continue` | 5 | $0.7861 | 8/12 every run | $0.0983 |
| script, no resume | 5 | $1.6847 | 8/12 every run | $0.2106 |

Resuming closes about half the gap, exactly as the cold-start figure predicts.
The engine is still **2.07x cheaper per unit of work than the competent
script**, the distributions still do not overlap ($0.0431-$0.0531 against
$0.0878-$0.1170), and the exact two-tailed probability of that separation at
n=5,5 is again **0.0079**.

The clearest way to state it: the engine did **50% more work for 28% less
money**. Both scripts stopped at eight of twelve modules in every single run;
the engine finished twelve in every single run. What separates them is not the
per-token price of anything - it is that the cycle contract keeps going until
the work is done, and the loop is what makes that cheap rather than expensive.

**What could not be compared, and why that is a fact rather than a caveat.**
The arms above are the two things a person does instead of using this app: a
`claude -p` loop, and the same loop written competently with `--continue`. They
are not the whole field - aider, OpenHands and the rest exist - and none of
them was measured here. The reason is structural rather than editorial.

This install authenticates with a **subscription OAuth credential**
(`claudeAiOauth`: an access token, a refresh token and a `subscriptionType`).
There is no `ANTHROPIC_API_KEY` and no admin key. Every third-party harness
authenticates with an API key, which is a different billing rail and a separate
commercial relationship. So the comparison space reachable from a subscription
install is exactly the tools built on the Claude Code CLI - which is the space
measured above, and measured completely.

That boundary is worth stating in a metering document because it is the same
boundary an operator of this app is standing behind. An install running on a
Max subscription cannot benchmark itself against an API-key tool without
opening an API account, and the figures here are therefore about **what this
app costs against the alternatives available to the same credential**, not
about the field. Anyone wanting the wider comparison needs an API key, a second
budget, and a protocol that prices two billing models against each other -
which is a study, not a paragraph.
