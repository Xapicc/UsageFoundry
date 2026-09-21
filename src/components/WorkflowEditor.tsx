"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentDTO,
  AmbientAgentDTO,
  LoopBoardReadingDTO,
  MergeStrategyDTO,
  RunTemplateDTO,
  SettingsDTO,
  TaskPriorityDTO,
  TaskStatusDTO,
  WorkflowDTO,
  WorkflowNodeKind,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import {
  MAX_FAN_OUT,
  MAX_LOOP_BOARD_THRESHOLDS,
  MAX_LOOP_PASSES,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
  boardThresholds,
} from "@/lib/apiTypes";
import {
  draftSignature,
  draftToGraph,
  linkKey,
  linksOfGraph,
  resolveLayout,
  sectionOf,
  type BlockDraft,
  type LinkDraft,
  type Point,
  type ThresholdDraft,
  type WorkflowDraftBody,
} from "@/lib/canvasGraph";
import { exitHref, leaving, registerLeaveGuard } from "@/lib/unsavedWork";
import {
  EDGE_OPTION_LABEL,
  WORKFLOW_LIMIT_TIMING_NOTE,
  describeAmbientAgents,
  fmtBoardThresholds,
  fmtTaskPlace,
  fmtUSD,
  pctField,
  pctSubmit,
  pollFailureMessage,
} from "@/lib/format";
import {
  KIND_LABEL,
  WorkflowCanvas,
  type CanvasSelection,
} from "@/components/WorkflowCanvas";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import {
  Field,
  Input,
  LimitField,
  Select,
  Switch,
  Textarea,
} from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { GroupLabel, ListGroup, ListRow } from "@/components/ui/List";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";

/**
 * The canvas a workflow is drawn on, and the inspector its selection is edited
 * in.
 *
 * **The graph is the whole interaction and nothing stands in for it.** Blocks
 * with nothing in front of them start at once, and several of them is the
 * parallel case — there is no separate thing to model and nothing to call it in
 * the copy. A link carries the two answers the wire needs, and the picker starts
 * on neither: `on-success` terminates a chain the operator meant to run
 * regardless and `on-finish` starts a run on top of a dependency that crashed,
 * so a pre-selected condition is wrong half the time in both directions.
 *
 * **Nothing here decides what a workflow may be.** A cycle, a template that has
 * been deleted, a workspace that is not mounted, a folder that cannot be
 * resolved, a block with no task, a section that does not end at a merge block
 * and so lands no pass: every one of those is
 * `normalizeWorkflowInput`'s answer, asked over `/api/workflows/validate` while
 * the graph is being drawn and shown in its own words. A second copy of those
 * rules here would be a second set to keep in step, and the day one of them
 * changed the canvas would be confidently wrong about what Save would do.
 *
 * A block names a template for its guards, or names none and takes the guard set
 * in Settings. There is deliberately no permission-mode, per-block budget or
 * isolation control: those decide what an agent may do, and a workflow decides
 * what work to do. The one exception is the workflow-wide budget, which bounds
 * something no per-block guard can see — ten blocks under a $5 block limit is a
 * $50 workflow.
 *
 * The agent picker is not a second exception, and its placement says so: it
 * sits with the work rather than in the guards group, because a saved agent
 * holds no tool list and no permission mode — it decides who the block's child
 * *is* and never what it may do. That is a larger claim than it was while the
 * flag was `--agents`, and it survives the move for the same reason it was made:
 * `--agent` sets a system prompt and a fallback model, and every guard on the
 * block is argued somewhere else. It is the block's own and never its
 * template's, for the reason the workspace picker is; `WorkflowNode.agentId`
 * has it in full. Beside it is the sentence the run form also carries: the
 * registry is a *part* of the set of agents in play and never the whole of it,
 * because the mounted `~/.claude` reaches every child this app spawns.
 *
 * The inspector is a sticky column beside the canvas rather than a form under
 * it, which is what a canvas app on this platform does — but the reason it
 * matters here is that the operator is reading the graph and the block's guards
 * at the same time. `BlockStatement` is that pairing made explicit: every block
 * says in one sentence which guard set applies, where it runs, how many runs it
 * may start and whether it may pay to reconcile a conflict. That sentence is
 * what a press of Run is approved against, so it is prose rather than a row of
 * controls to be read off.
 */

/* ------------------------------------------------------------------ */
/* Where a block sits, which is not part of the graph                  */
/* ------------------------------------------------------------------ */

/**
 * Positions live in this browser, keyed by workflow id, and never in the graph.
 *
 * The alternative — an `x`/`y` on `WorkflowNode` — makes dragging a block a
 * change to the object `topologicalOrder` reads and `normalizeWorkflowInput`
 * rebuilds, so a cosmetic gesture would bump `updated_at` and land in the same
 * blob as what runs. It also would not survive the trip: the normalizer builds
 * each node from a fixed list of fields, so the coordinates would be dropped in
 * passing and the drag would silently not persist.
 *
 * What that costs is stated rather than absorbed: an arrangement someone made
 * by hand does not follow them to another browser. What does follow is the
 * *layout*, because `autoLayout` derives one from the edges — so a graph saved
 * before this existed opens readable, with no migration in front of it and
 * therefore nothing that could lose an edge on the way in.
 */
const LAYOUT_KEY = "uf.workflow-layout.";

function readLayout(id: string): Record<string, Point> | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Shape-checked loosely and used defensively: `resolveLayout` drops an
    // entry it cannot use, so a stale or hand-edited value costs the derived
    // position rather than a block nobody can find.
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Point>)
      : null;
  } catch {
    // Disabled storage, a quota, or a private window. A layout is a nicety and
    // its absence is the derived one.
    return null;
  }
}

function writeLayout(id: string, at: Record<string, Point>): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY + id, JSON.stringify(at));
  } catch {
    /* see readLayout */
  }
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_FAN_OUT = "3";
const DEFAULT_MAX_PASSES = "3";

/**
 * What a board condition counts before anybody picks, and what it stops at.
 *
 * `open` alone rather than both states, and the row says why: a claim on this
 * board is a record of which run holds a task and never a lease — there is no
 * clock on it — so one task left claimed by a run that died holds the loop open
 * for every pass it is allowed, a billed run at a time. Counting `claimed` is
 * offered because a backlog being worked by another run is genuinely not clear;
 * it is not the default because the failure is expensive and silent.
 */
const DEFAULT_STOP_STATUSES = "open";

/**
 * The one threshold a condition starts with: the project whole, until empty.
 *
 * `any` rather than a priority, because that is the question the condition
 * could ask before it could ask any other and the one an operator reaching for
 * "work this backlog" means. A function rather than a constant: each block's
 * list is edited in place, and a shared array would be one list behind every
 * loop in the graph.
 */
function defaultThresholds(): ThresholdDraft[] {
  return [{ priority: "any", atMost: "0" }];
}

/** Each priority as the threshold picker names it, most urgent first. */
const THRESHOLD_PRIORITY_LABEL: Record<string, string> = {
  any: "Any priority",
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** The project picker's "off" value. Cannot collide — see `projectKey`. */
const NO_PROJECT = "";

/**
 * One project, as a `<select>` value.
 *
 * The board's own filter encodes a project exactly this way, and the pairing
 * rule is its: two mounts may hold the same relative path, so a key on the path
 * alone would name two projects with one word. JSON rather than a joined
 * string, for `placeKey`'s reason in `src/app/tasks/page.tsx` — a separator has
 * to be a character neither half can contain, a mount id is operator-supplied
 * config, and there is no such character to pick. Every real key begins `["`,
 * so `""` above cannot be one.
 */
function projectKey(mountId: string, folder: string): string {
  return JSON.stringify([mountId, folder]);
}

/** A project key back as the pair the wire holds. `""` is the condition off. */
function projectPair(key: string): { mountId: string; folder: string } {
  if (key === NO_PROJECT) return { mountId: "", folder: "" };
  const [mountId, folder] = JSON.parse(key) as [string, string];
  return { mountId, folder };
}

/**
 * A project as both this picker and the board name it.
 *
 * Delegated rather than restated, for the reason written on `fmtTaskPlace`
 * itself: an operator who filters the board to a project and then points a loop
 * at it must be reading one name, not two spellings of one, and a rule written
 * out twice is a rule with two places to drift. `describeFolder` builds a
 * task's `mountLabel` from the mount's own `label`, so the two arguments here
 * are the same two values a task carries. `""` is the mount root, which that
 * function already answers with the mount's name alone.
 */
function projectLabel(mountLabel: string, folder: string): string {
  return fmtTaskPlace({ folder, mountLabel, relPath: folder });
}

/**
 * How a merge block lands, before anyone picks.
 *
 * `merge` rather than `settings.landStrategy`: what the graph records has to be
 * what the operator was shown, and this editor does not read settings. Of the
 * two, this is also the one git can still see afterwards — a squash rewrites the
 * commits, so the branch is never an ancestor of its target and `deleteBranch`
 * has to fall back to `-D`.
 */
const DEFAULT_MERGE_STRATEGY: MergeStrategyDTO = "merge";

/** The width a control takes in the inspector's rows. See `ui/Field`'s note:
 *  a width never goes on the control, because two width utilities on one
 *  element resolve by stylesheet order rather than class order. */
/*  `max-md:w-full` and no longer the 288px `w-72` that stood in for it: a
 *  percentage was inert here until `ListRow`'s children wrapper stopped being
 *  shrink-to-fit below the breakpoint, because a percentage had no definite
 *  containing block to resolve against. 288px was what fitted a 390px screen
 *  and nothing else; the full column is what this control wants at every
 *  width, and it clears a 320px viewport by being a fraction of it rather than
 *  by being under it. `ROW_CONTROL_NARROW` keeps its 96px: it holds two digits
 *  at every width, and `Field` gives it the 44px height on its own. */
const ROW_CONTROL = "w-44 max-md:w-full";
const ROW_CONTROL_NARROW = "w-24";

function emptyBlock(id: string, mountId: string, kind: WorkflowNodeKind): BlockDraft {
  return {
    id,
    name: "",
    kind,
    templateId: "",
    mountId,
    folder: "",
    task: "",
    promptOverride: "",
    agentId: "",
    fanOut: DEFAULT_FAN_OUT,
    mergeStrategy: DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: false,
    maxPasses: DEFAULT_MAX_PASSES,
    maxLoopCostUSD: "",
    stopWhenTasksMountId: "",
    stopWhenTasksFolder: "",
    stopWhenTasksIncludeSubfolders: false,
    stopWhenTasksStatuses: DEFAULT_STOP_STATUSES,
    stopWhenTasksThresholds: defaultThresholds(),
  };
}

function toBlocks(workflow: WorkflowDTO): BlockDraft[] {
  return workflow.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind ?? "run",
    templateId: n.templateId ?? "",
    mountId: n.mountId,
    folder: n.folder,
    task: n.task,
    promptOverride: n.promptOverride ?? "",
    agentId: n.agentId ?? "",
    fanOut: n.fanOut?.toString() ?? DEFAULT_FAN_OUT,
    mergeStrategy: n.mergeStrategy ?? DEFAULT_MERGE_STRATEGY,
    mergeAutoResolve: n.mergeAutoResolve ?? false,
    maxPasses: n.maxPasses?.toString() ?? DEFAULT_MAX_PASSES,
    // Null is "no cap", and a number field says that with "" — never a 0, which
    // `normalizeWorkflowInput` reads as off but a reader would take for a limit.
    maxLoopCostUSD: n.maxLoopCostUSD?.toString() ?? "",
    // Null is the condition off, which is every graph saved before the field
    // existed. The other three keep their defaults behind it, so turning it on
    // by picking a workspace lands on the safe pair rather than on blanks.
    stopWhenTasksMountId: n.stopWhenTasks?.mountId ?? "",
    stopWhenTasksFolder: n.stopWhenTasks?.folder ?? "",
    // A condition saved before this field existed says nothing here, and the
    // board's own grouping — one folder is one project — is what it meant.
    stopWhenTasksIncludeSubfolders:
      n.stopWhenTasks?.includeSubfolders === true,
    stopWhenTasksStatuses:
      n.stopWhenTasks?.statuses.join(",") ?? DEFAULT_STOP_STATUSES,
    // Through `boardThresholds`, so a loop saved against the single-number
    // shape opens showing the threshold it has always had rather than the
    // default — an editor that quietly replaced it would save a different
    // workflow than the one it was handed.
    stopWhenTasksThresholds: n.stopWhenTasks
      ? boardThresholds(n.stopWhenTasks).map((t) => ({
          priority: t.priority,
          atMost: t.atMost.toString(),
        }))
      : defaultThresholds(),
  }));
}

/**
 * The links, with a “repeats” link put back where a saved graph only implies
 * one. See `linksOfGraph`: this surface derives what a loop repeats from the
 * links alone, so a workflow that states it as a list has to arrive carrying
 * the arrow that says the same thing.
 */
function toLinks(workflow: WorkflowDTO): LinkDraft[] {
  return linksOfGraph(workflow.nodes, workflow.edges);
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function WorkflowEditor({
  workflow,
}: {
  /** Null for a new workflow; a saved one is edited in place. */
  workflow: WorkflowDTO | null;
}) {
  const router = useRouter();

  const [name, setName] = useState(workflow?.name ?? "");
  const [blocks, setBlocks] = useState<BlockDraft[]>(() =>
    workflow ? toBlocks(workflow) : [],
  );
  const [links, setLinks] = useState<LinkDraft[]>(() =>
    workflow ? toLinks(workflow) : [],
  );
  const [dragged, setDragged] = useState<Record<string, Point>>({});
  const [selection, setSelection] = useState<CanvasSelection | null>(null);

  // The workflow-wide limits. Held as strings for the reason the run form's
  // are: "" is how a number input says "off", and `normalizeInstanceBudget`
  // reads "", 0 and null identically.
  const [costCapped, setCostCapped] = useState(
    (workflow?.instanceBudget.maxInstanceCostUSD ?? null) !== null,
  );
  const [maxInstanceCostUSD, setMaxInstanceCostUSD] = useState(
    workflow?.instanceBudget.maxInstanceCostUSD?.toString() ?? "20",
  );
  const [maxSessionFraction, setMaxSessionFraction] = useState(
    pctField(workflow?.instanceBudget.maxSessionFraction),
  );
  const [maxWeeklyFraction, setMaxWeeklyFraction] = useState(
    pctField(workflow?.instanceBudget.maxWeeklyFraction),
  );
  /**
   * Whether a fraction guard would have anything to measure against.
   *
   * A configured ceiling is one source; the provider's own utilisation is the
   * other, and `windows.ts` prefers it — so "nothing typed in Settings" is not
   * the same as "no reading", and warning on the ceiling alone would nag every
   * install that reads its percentage from Anthropic. Null until Settings
   * answers, which is why the warning renders on `false` rather than on
   * `!ceilings`.
   */
  const [ceilings, setCeilings] = useState<{
    session: boolean;
    weekly: boolean;
  } | null>(null);
  const [templates, setTemplates] = useState<RunTemplateDTO[]>([]);
  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolderDTO[]>([]);
  // The saved registry and the definitions on disk this app did not write, off
  // one payload so no two surfaces can describe the set differently.
  // `agentsLoaded` is what tells "this block names an agent that is gone" from
  // "the list has not arrived yet" — the second must not raise the first.
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [ambientAgents, setAmbientAgents] = useState<AmbientAgentDTO[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** What `normalizeWorkflowInput` says about the graph as it stands. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Why the question could not be asked, which is not the same as an answer. */
  const [unchecked, setUnchecked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /**
   * What each loop's board condition counts today, off the same check.
   *
   * Read from the server and never derived here, for this file's standing
   * reason: the folder on a node is a path *within* its mount and the board
   * stores the canonical absolute one, so anything this surface computed would
   * be comparing two spellings of a path — the defect `loopBoardCount` exists
   * to prevent, drawn in the one place an operator would trust it.
   */
  const [boards, setBoards] = useState<LoopBoardReadingDTO[]>([]);

  // Ids are minted on an action, never during render: `crypto.randomUUID()` in
  // a state initialiser differs between the server pass and hydration and React
  // silently keeps one of them. Seeded past the highest suffix already in the
  // graph rather than from the block count, because a saved workflow that has
  // had blocks removed has gaps.
  const nextId = useRef(
    Math.max(
      0,
      ...blocks.map((b) => Number(/^block-(\d+)$/.exec(b.id)?.[1] ?? 0)),
    ) + 1,
  );

  /* ---------------------------------------------------------------- */
  /* Layout                                                            */
  /* ---------------------------------------------------------------- */

  // Read after mount rather than in a state initialiser: there is no
  // localStorage during the server render of /workflows/new, and a value that
  // differs between the two passes is a hydration mismatch.
  const hydrated = useRef(false);
  useEffect(() => {
    if (workflow) setDragged(readLayout(workflow.id) ?? {});
    hydrated.current = true;
  }, [workflow]);

  useEffect(() => {
    if (!workflow || !hydrated.current) return;
    // Coalesced, because a drag writes a position per pointer move and this is
    // synchronous storage on the same thread as the canvas.
    const timer = setTimeout(() => writeLayout(workflow.id, dragged), 400);
    return () => clearTimeout(timer);
  }, [workflow, dragged]);

  const positions = useMemo(
    () => resolveLayout(blocks, links, dragged),
    [blocks, links, dragged],
  );

  /**
   * Which loop repeats each block, by that loop's name.
   *
   * One derivation for both panels, so the sentence a block's statement reads
   * out and the sentence a link's panel states cannot disagree about what is
   * inside a section. Membership of the link's *source* is what decides whether
   * a link is inside one: the section is everything linked after its first
   * block, so a link out of a member always lands inside it too.
   */
  const sections = useMemo(() => {
    const owner = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind !== "loop") continue;
      for (const id of sectionOf(block.id, blocks, links)) {
        if (!owner.has(id)) owner.set(id, blockLabel(block));
      }
    }
    return owner;
  }, [blocks, links]);

  /* ---------------------------------------------------------------- */
  /* What the install offers                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/templates", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/folders", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([t, f]) => {
        if (!live) return;
        setTemplates((t.templates ?? []) as RunTemplateDTO[]);
        setMounts((f.mounts ?? []) as WorkspaceMountDTO[]);
        setFolders((f.folders ?? []) as WorkspaceFolderDTO[]);
      })
      .catch(() => {
        if (live) setError("The workspace and templates could not be read.");
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // Separate from the pair above for that pair's reason, and it decides what a
  // picker offers rather than only a warning: a failed read leaves the list
  // empty and `agentsLoaded` false, so a block naming an agent is never
  // reported as naming a missing one on the strength of a list that never
  // arrived. Save still refuses it by name, which is the answer that guards
  // anything.
  useEffect(() => {
    let live = true;
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        setAgents((d.agents ?? []) as AgentDTO[]);
        setAmbientAgents((d.ambient ?? []) as AmbientAgentDTO[]);
        setAgentsLoaded(true);
      })
      .catch(() => {
        /* see above; the picker stays empty and the server still decides */
      });
    return () => {
      live = false;
    };
  }, []);

  // Separate from the pair above and deliberately not blocking `loaded`: this
  // decides whether one warning renders, so a slow or failed read must not hold
  // the editor back or turn into an error banner over it.
  useEffect(() => {
    let live = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings as SettingsDTO | undefined;
        if (!live || !s) return;
        setCeilings({
          session:
            s.planUsageFromApi ||
            s.sessionCostLimit !== null ||
            s.sessionTokenLimit !== null,
          weekly:
            s.planUsageFromApi ||
            s.weeklyCostLimit !== null ||
            s.weeklyTokenLimit !== null,
        });
      })
      .catch(() => {
        /* the warning stays unrendered; Run still refuses by name */
      });
    return () => {
      live = false;
    };
  }, []);

  const defaultMount = useCallback(
    () => (mounts.find((m) => m.available) ?? mounts[0])?.id ?? "",
    [mounts],
  );

  const templateName = useCallback(
    (id: string) => templates.find((t) => t.id === id)?.name ?? null,
    [templates],
  );

  const foldersFor = useCallback(
    (mountId: string) => folders.filter((f) => f.mountId === mountId),
    [folders],
  );

  // The sentence the run form's picker carries too, from one place — see
  // `describeAmbientAgents`.
  const ambientLine = useMemo(
    () => describeAmbientAgents(ambientAgents),
    [ambientAgents],
  );

  /* ---------------------------------------------------------------- */
  /* Editing the graph                                                 */
  /* ---------------------------------------------------------------- */

  const addBlock = useCallback(
    (kind: WorkflowNodeKind, at: Point) => {
      const id = `block-${nextId.current++}`;
      setBlocks((prev) => [...prev, emptyBlock(id, defaultMount(), kind)]);
      setDragged((prev) => ({ ...prev, [id]: at }));
      setSelection({ kind: "block", id });
    },
    [defaultMount],
  );

  const updateBlock = useCallback((id: string, patch: Partial<BlockDraft>) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const removeBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    // A link to a block that has gone is a link to nothing, and the server
    // refuses one — so it goes with the block rather than waiting to be
    // discovered at Save. That is also what takes the block out of any section
    // it was in, now that membership is the links and nothing else: a “repeats”
    // link to it goes with it, and so does the chain link that reached it.
    setLinks((prev) => prev.filter((l) => l.from !== id && l.to !== id));
    setDragged((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelection((prev) =>
      prev?.kind === "block" && prev.id === id ? null : prev,
    );
  }, []);

  const moveBlock = useCallback((id: string, at: Point) => {
    setDragged((prev) => ({ ...prev, [id]: at }));
  }, []);

  /**
   * Point a loop's “repeats” link at a block, or take the one already pointing
   * there away.
   *
   * The whole of what this surface writes about a section, and a write to the
   * *links*: membership and order are read back out of them by `sectionOf`, so
   * there is no list here to keep in step with the picture. At most one per
   * loop, by replacing rather than appending — two is a refusal the server
   * writes, and it is not one this gesture has any way to mean.
   *
   * It decides nothing else: whether the block may be repeated, whether the
   * section is a chain and whether two loops are fighting over it are all
   * `graphRefusal`'s, answered by the validate route while the graph is being
   * drawn, and a second opinion here would be a rule to keep in step with no
   * way to notice it had drifted.
   */
  const repeatFrom = useCallback(
    (loopId: string, firstId: string) => {
      const already = links.some(
        (l) => l.from === loopId && l.to === firstId && l.edge === "repeats",
      );
      setLinks((prev) => {
        // Two links go: the loop's own “repeats” link, because it has at most
        // one, and **any** link it already had to this block, because two links
        // between one pair is a graph that can never save — the server refuses
        // it by name, and until then both are drawn on top of each other with
        // one key between them. An ordinary link from a loop to a block it
        // repeats is refused anyway, so replacing it is the only outcome this
        // press could have that leaves a savable graph.
        const rest = prev.filter(
          (l) =>
            !(l.from === loopId && (l.edge === "repeats" || l.to === firstId)),
        );
        return already
          ? rest
          : [
              ...rest,
              {
                from: loopId,
                to: firstId,
                edge: "repeats",
                continueBranch: false,
              },
            ];
      });
      // The link that was just drawn, so the panel states what it means — and
      // nothing at all when the press removed one, because a selection pointing
      // at a link that has gone is an empty panel with a Remove button on it.
      setSelection(already ? null : { kind: "link", from: loopId, to: firstId });
    },
    [links],
  );

  const connect = useCallback(
    (from: string, to: string) => {
      // A link drawn out of a block some loop already repeats extends that
      // section, and inside a section the condition has one safe answer: a pass
      // has to land what it produced, so a member that did not finish is not
      // something the rest of the section should carry on from. So it is drawn
      // carrying that answer rather than unanswered, and the panel *states* it
      // instead of asking. Everywhere else neither condition is safe to assume:
      // see `EDGE_OPTION_LABEL`.
      //
      // The branch is the **second** link's question rather than the first's. A
      // section may fork, and two links carrying one block's branch is refused
      // at Save by name — "two runs cannot extend one branch" — so an editor
      // that set it on every link inside a section would make a section that
      // fans out unsavable, with the sentence naming a control the operator was
      // never shown. The first way out of a block carries its branch, which is
      // the chain a person drawing one block after another means; each later
      // one cuts its own and leaves it for the section's merge block, which is
      // exactly what a fork means.
      const inSection = blocks.some(
        (b) => b.kind === "loop" && sectionOf(b.id, blocks, links).includes(from),
      );
      setLinks((prev) =>
        prev.some((l) => l.from === from && l.to === to)
          ? prev
          : [
              ...prev,
              inSection
                ? {
                    from,
                    to,
                    edge: "on-success" as const,
                    continueBranch: !prev.some(
                      (l) => l.from === from && l.continueBranch,
                    ),
                  }
                : { from, to, edge: "" as const, continueBranch: false },
            ],
      );
      setSelection({ kind: "link", from, to });
    },
    [blocks, links],
  );

  const updateLink = useCallback(
    (from: string, to: string, patch: Partial<LinkDraft>) => {
      setLinks((prev) =>
        prev.map((l) =>
          l.from === from && l.to === to ? { ...l, ...patch } : l,
        ),
      );
    },
    [],
  );

  const removeLink = useCallback((from: string, to: string) => {
    setLinks((prev) => prev.filter((l) => !(l.from === from && l.to === to)));
    setSelection((prev) =>
      prev?.kind === "link" && prev.from === from && prev.to === to
        ? null
        : prev,
    );
  }, []);

  /* ---------------------------------------------------------------- */
  /* What the server says about it                                     */
  /* ---------------------------------------------------------------- */

  const body: WorkflowDraftBody = useMemo(
    () => ({
      name,
      graph: draftToGraph({ blocks, links }),
      instanceBudget: {
        maxInstanceCostUSD: costCapped ? maxInstanceCostUSD : "",
        // Sent as 0–1 fractions rather than the 0–100 the fields show, the
        // same conversion the run form makes: normalizeInstanceBudget's frac()
        // reads a bare 1 as 100%, so a "1" typed into a field labelled % would
        // otherwise be stored as the whole window.
        maxSessionFraction: pctSubmit(maxSessionFraction),
        maxWeeklyFraction: pctSubmit(maxWeeklyFraction),
      },
    }),
    [
      name,
      blocks,
      links,
      costCapped,
      maxInstanceCostUSD,
      maxSessionFraction,
      maxWeeklyFraction,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    // Debounced rather than per keystroke: the check reads every template and
    // resolves every block's folder, which is a syscall per block.
    const timer = setTimeout(() => {
      fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            boards?: LoopBoardReadingDTO[];
          };
          if (!res.ok) {
            setUnchecked(pollFailureMessage(res.status, data.error));
            return;
          }
          setUnchecked(null);
          setRefusal(data.ok ? null : (data.error ?? null));
          // Kept even when the graph was refused: the readings are answered
          // beside the verdict rather than behind it, and a figure that blanked
          // while some *other* block was unfinished would be missing for most
          // of the time somebody is drawing one.
          setBoards(data.boards ?? []);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Not a refusal: the graph has not been judged at all, and saying
          // nothing here would read as "this is fine".
          setUnchecked(
            pollFailureMessage(null, err instanceof Error ? err.message : null),
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [body]);

  /* ---------------------------------------------------------------- */
  /* Not losing it                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Whether there is a graph here that leaving would destroy.
   *
   * Against the signature taken on the first render rather than against a
   * re-derivation of the saved workflow: the drafts are seeded from the DTO by
   * `toBlocks`/`toLinks` and read back by `draftToGraph`, and a round trip that
   * did not land on itself exactly would make an untouched page dirty from the
   * moment it opened. A snapshot cannot drift from the state it was taken of.
   *
   * Nothing clears it on a save, because a save navigates: `router.push` leaves
   * this component, and a page that stays would be lying about what is stored.
   */
  const signature = useMemo(() => draftSignature(body), [body]);
  const savedSignature = useRef(signature);
  const dirty = signature !== savedSignature.current;

  /** The exit that was stopped, held until the operator answers for it. */
  const [pendingExit, setPendingExit] = useState<{
    proceed: () => void;
  } | null>(null);

  /**
   * The tab, the reload and the typed URL — and only those three.
   *
   * The settings page's prompt, for its reasons: registered only while there is
   * something to lose so that a dialog is never raised over a page with nothing
   * on it, `preventDefault` and `returnValue` together because either alone is
   * a silent no-op in some engine, and the wording is the browser's.
   *
   * It does not fire on a client-side navigation, which for this page is most
   * of them; the two effects below are what cover those.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /**
   * Every link on the page, including the shell's own.
   *
   * One listener on the document rather than a guarded `<Link>`: the exits that
   * matter are the sidebar's and the toolbar's, which are outside this
   * component and have no reason to know a graph is being drawn.
   *
   * Capture, and both `preventDefault` and `stopPropagation`. `next/link`
   * navigates from a React handler attached at the root container and reads
   * neither the default nor who prevented it, so a bubble-phase listener runs
   * too late and a prevented default alone still pushes the route — the click
   * has to be stopped before it reaches React at all.
   */
  useEffect(() => {
    if (!dirty) return;
    function onClick(e: MouseEvent) {
      const anchor = e.target instanceof Element ? e.target.closest("a") : null;
      const href = exitHref({
        href: anchor?.hasAttribute("href") ? anchor.href : null,
        target: anchor?.target ?? "",
        download: anchor?.hasAttribute("download") ?? false,
        button: e.button,
        modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
        defaultPrevented: e.defaultPrevented,
        here: window.location.href,
        origin: window.location.origin,
      });
      if (href === null) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingExit({ proceed: () => router.push(href) });
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, router]);

  /**
   * The exits that are not clicks on anything: ⌘1…⌘9 and quick open.
   *
   * Both are `router.push` calls in the shell, so there is no event to stop and
   * nothing this page could observe — they ask instead, and this is the answer.
   * Browser Back is the one exit left uncovered: intercepting `popstate` means
   * pushing a sentinel entry the operator never made and re-pushing it against
   * the router's own restore, which corrupts the history stack in exchange for
   * a dialog. The graph is still there afterwards, one Forward away.
   */
  useEffect(() => {
    if (!dirty) return;
    return registerLeaveGuard((proceed) => {
      setPendingExit({ proceed });
      return true;
    });
  }, [dirty]);

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        workflow ? `/api/workflows/${workflow.id}` : "/api/workflows",
        {
          method: workflow ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        workflow?: WorkflowDTO;
        error?: string;
      };
      if (!res.ok || !data.workflow) {
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      // A new workflow's id only exists now, and the arrangement was made
      // against it — written before the navigation so the detail page's Edit
      // link opens on the layout that was just drawn.
      writeLayout(data.workflow.id, dragged);
      router.push(`/workflows/${data.workflow.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const selectedBlock =
    selection?.kind === "block"
      ? blocks.find((b) => b.id === selection.id)
      : undefined;
  const selectedLink =
    selection?.kind === "link"
      ? links.find((l) => l.from === selection.from && l.to === selection.to)
      : undefined;

  const nameOf = useCallback(
    (id: string) => {
      const block = blocks.find((b) => b.id === id);
      return block?.name.trim() || id;
    },
    [blocks],
  );

  return (
    <>
      {/* No heading here: the page that mounts this carries its own <h1>, the
          same division the rest of the shell keeps. */}
      <div role="alert">{error && <Notice tone="danger" live>{error}</Notice>}</div>

      {/* The split. The canvas is the pane — it is what this page is for — and
          the inspector beside it holds whatever is selected plus the one limit
          that bounds the whole graph. Column and row are placed explicitly
          rather than left to source order, so on a narrow window the canvas
          leads and the inspector follows it. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <Field label="Name" htmlFor="wf-name">
            <Input
              id="wf-name"
              value={name}
              maxLength={MAX_WORKFLOW_NAME}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly maintenance"
            />
          </Field>

          <WorkflowCanvas
            blocks={blocks}
            links={links}
            positions={positions}
            selection={selection}
            full={blocks.length >= MAX_WORKFLOW_NODES}
            onSelect={setSelection}
            onMove={moveBlock}
            onAddBlock={addBlock}
            onConnect={connect}
            onRemoveLink={removeLink}
            onRemoveBlock={removeBlock}
            onRepeat={repeatFrom}
          />

          {/* The server's own sentence, asked while the graph is being drawn.
              Save is deliberately left enabled: this check is advisory and can
              itself be unreachable, and a disabled Save behind a failed
              advisory check strands the operator with no way to reach the
              authority at all. */}
          <div className="mt-4" role="status" aria-live="polite">
            {unchecked ? (
              <Notice tone="warn">{unchecked}</Notice>
            ) : refusal ? (
              <Notice tone="warn" className={checking ? "opacity-70" : ""}>
                {refusal}
              </Notice>
            ) : null}
          </div>
        </div>

        {/* `max-lg:min-w-0` for the run page's reason, one surface over: below
            `lg` these two stack into one implicit `auto` track whose floor is
            this column's min-content, and `BlockStatement` states *where* a
            block runs as an unbroken `mono` path. A deep folder would
            otherwise be a floor under the whole grid and scroll the pane
            sideways. Scoped, because above the breakpoint the track is a fixed
            26rem and this changes which way such a path overflows. */}
        <div className="flex flex-col gap-4 max-lg:min-w-0 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(var(--pane-h)-6rem)] lg:overflow-y-auto">
          <Card>
            <CardTitle>
              {selectedBlock
                ? KIND_LABEL[selectedBlock.kind]
                : selectedLink
                  ? "Link"
                  : "Nothing selected"}
            </CardTitle>

            {!selectedBlock && !selectedLink && (
              <Empty>
                {/* Split because the thing being pointed at is not the same
                    thing at both widths: below the breakpoint the canvas is
                    replaced by a list of the blocks, and naming a canvas there
                    sends a reader looking for one. */}
                <div className="text-ink-muted max-md:hidden">
                  Choose a block or a link on the canvas
                </div>
                <div className="text-ink-muted md:hidden">
                  Choose a block or a link from the list above
                </div>
              </Empty>
            )}

            {selectedBlock && !loaded && (
              <>
                <span className="sr-only">Reading workspaces and templates…</span>
                <SkeletonText lines={4} />
              </>
            )}

            {selectedBlock && loaded && (
              <BlockPanel
                block={selectedBlock}
                blocks={blocks}
                links={links}
                templates={templates}
                templateName={templateName}
                agents={agents}
                agentsLoaded={agentsLoaded}
                ambientLine={ambientLine}
                mounts={mounts}
                foldersFor={foldersFor}
                board={
                  boards.find((b) => b.nodeId === selectedBlock.id) ?? null
                }
                onChange={(patch) => updateBlock(selectedBlock.id, patch)}
                onRemove={() => removeBlock(selectedBlock.id)}
              />
            )}

            {selectedLink && (
              <LinkPanel
                link={selectedLink}
                fromName={nameOf(selectedLink.from)}
                toName={nameOf(selectedLink.to)}
                fromIsLoop={
                  blocks.find((b) => b.id === selectedLink.from)?.kind === "loop"
                }
                insideSection={sections.get(selectedLink.from)}
                onChange={(patch) =>
                  updateLink(selectedLink.from, selectedLink.to, patch)
                }
                onRemove={() => removeLink(selectedLink.from, selectedLink.to)}
              />
            )}
          </Card>

          <Card emphasis="quiet">
            <CardTitle>Limits for the whole workflow</CardTitle>

            <Field label="Spending limit" htmlFor="wf-cost">
              <LimitField
                id="wf-cost"
                modeLabel="Workflow spending limit mode"
                enabled={costCapped}
                onEnabledChange={setCostCapped}
                value={maxInstanceCostUSD}
                onValueChange={setMaxInstanceCostUSD}
                unit="USD"
                offLabel="No limit"
                min={0}
                step="0.5"
              />
              <Hint>
                {costCapped
                  ? "Everything every block spends, together — each block still has its own limits from its guards"
                  : "Only the per-block guards bound this workflow, so ten blocks under a $5 block limit is a $50 workflow"}
              </Hint>
            </Field>

            <Field label="Stop at 5-hour usage" htmlFor="wf-sess">
              <Input
                id="wf-sess"
                type="number"
                min={1}
                max={100}
                placeholder="off"
                value={maxSessionFraction}
                onChange={(e) => setMaxSessionFraction(e.target.value)}
                className="tabular-nums"
                unit="%"
              />
              {maxSessionFraction && ceilings?.session === false && (
                <Hint tone="warn">
                  No 5-hour ceiling is set and the account&rsquo;s own percentage
                  is switched off, so this guard has nothing to measure and Run
                  will refuse the workflow
                </Hint>
              )}
            </Field>

            <Field label="Stop at weekly usage" htmlFor="wf-week">
              <Input
                id="wf-week"
                type="number"
                min={1}
                max={100}
                placeholder="off"
                value={maxWeeklyFraction}
                onChange={(e) => setMaxWeeklyFraction(e.target.value)}
                className="tabular-nums"
                unit="%"
              />
              {maxWeeklyFraction && ceilings?.weekly === false && (
                <Hint tone="warn">
                  No weekly ceiling is set and the account&rsquo;s own percentage
                  is switched off, so this guard has nothing to measure and Run
                  will refuse the workflow
                </Hint>
              )}
            </Field>

            <Hint>{WORKFLOW_LIMIT_TIMING_NOTE}</Hint>
          </Card>
        </div>
      </div>

      {/* The pane's footer, in the run form's and Settings' shape: the default
          action at the right edge of the pane it belongs to, and one line
          saying what pressing it does. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-12 mt-5 border-t border-line bg-canvas px-4 py-3 shadow-bar sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <p
            role="status"
            aria-atomic="true"
            className="mr-auto min-h-5 basis-full text-xs leading-5 text-ink-faint sm:basis-auto"
          >
            {saving
              ? "Saving the graph…"
              : "Saves the graph. Nothing starts until you press Run on it."}
          </p>
          {/* Through the same guard the shell's exits use rather than around
              it: Cancel is the one exit this component owns, and an exit that
              asks on its own terms is an exit that drifts from the others. */}
          <Button
            variant="secondary"
            onClick={() =>
              leaving(() =>
                router.push(
                  workflow ? `/workflows/${workflow.id}` : "/workflows",
                ),
              )
            }
          >
            Cancel
          </Button>
          <Button onClick={save} busy={saving}>
            {workflow ? "Save changes" : "Create workflow"}
          </Button>
        </div>
      </div>

      {/* The one thing standing between a drawn graph and a press on the
          sidebar. It says where the graph is, which is the fact the operator
          cannot see: every block, prompt, guard and link is in this tab and
          nowhere else until the button beside Cancel is pressed. */}
      <Sheet
        open={pendingExit !== null}
        onDismiss={() => setPendingExit(null)}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        confirmVariant="danger"
        cancelLabel="Keep editing"
        onConfirm={() => {
          const exit = pendingExit;
          setPendingExit(null);
          exit?.proceed();
        }}
      >
        Nothing in this graph is stored until{" "}
        {workflow ? "Save changes" : "Create workflow"} is pressed.
      </Sheet>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The inspector                                                       */
/* ------------------------------------------------------------------ */

/**
 * What this block is, in a sentence.
 *
 * The controls under it are how it is changed; this is what it *says*, and it
 * is the copy a press of Run is approved against — which guard set applies (or
 * that it is the untemplated one from Settings), where it runs, which saved
 * agent its child is started as, how many runs a deciding block may start with
 * nobody looking, how many times a repeating one may start one and what those
 * passes may spend together, and whether a merge block may pay a model to
 * reconcile a conflict. Every one of those is a fact somebody would otherwise
 * have to assemble by reading five separate pickers.
 *
 * It is deliberately not a warning: an orchestrator block's fan-out, a loop
 * block's pass cap and a merge block's authorisation are ordinary properties of
 * a block that was configured that way. The tone is on the number itself, where
 * it belongs.
 */
/**
 * What a block is called wherever this file names one.
 *
 * `WorkflowCanvas` has its own copy for the same job; they are not shared
 * because that one also answers for a block that has *gone*, which cannot
 * happen to anything this file holds a draft of.
 */
function blockLabel(block: BlockDraft): string {
  return block.name.trim() || block.id;
}

function BlockStatement({
  block,
  body,
  guards,
  where,
  asAgent,
}: {
  block: BlockDraft;
  /**
   * The blocks a loop repeats, in the order a pass will create them, or empty.
   *
   * Ordered by the caller through `bodyOrder`, which is the client's reading of
   * `loopBody` — so the order read out here is the order the runs happen in
   * rather than the order somebody happened to mark them in.
   */
  body: readonly BlockDraft[];
  guards: ReactNode;
  where: ReactNode;
  /**
   * The agent this block's own child is started as, or null.
   *
   * Stated rather than implied, because this sentence is what a press of Run is
   * approved against — and stated *outside* the guard clause, because an agent
   * bounds nothing: it holds no tool list and no permission mode, and a phrase
   * inside "under …" would claim it does. That placement was re-decided when
   * the flag became `--agent`, not carried over: being the run rather than a
   * helper inside it makes this a bigger fact and not a different *kind* of
   * fact, so it belongs in its own clause and still not under "under".
   */
  asAgent: ReactNode | null;
}) {
  if (block.kind === "merge") {
    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Lands every branch in front of it onto the target that branch&rsquo;s own
        run recorded,{" "}
        <strong className="font-semibold text-ink">
          {block.mergeStrategy === "squash" ? "squashed" : "as a merge commit"}
        </strong>
        .{" "}
        {block.mergeAutoResolve ? (
          <span className="text-warn">
            A conflict is reconciled by Claude on the run&rsquo;s own branch, and
            billed.
          </span>
        ) : (
          "A conflicting branch is reported and left alone."
        )}
      </p>
    );
  }

  if (block.kind === "orchestrator") {
    const cap = Number(block.fanOut);
    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Decides in {where}, and starts{" "}
        {Number.isFinite(cap) && cap > 0 ? (
          <strong className="font-semibold text-warn">
            up to {cap} run{cap === 1 ? "" : "s"}
          </strong>
        ) : (
          <strong className="font-semibold text-danger">
            an unstated number of runs
          </strong>
        )}{" "}
        with no approval — each under {guards}.
        {asAgent && <> It decides as {asAgent}.</>}
      </p>
    );
  }

  if (block.kind === "loop") {
    const passes = Number(block.maxPasses);
    const spend = Number(block.maxLoopCostUSD);
    // "" is off, so the sentence names the spending cap only where there is one
    // — a clause saying "and no limit on what they spend together" would put a
    // permanent alarm on the ordinary loop, whose pass cap already ends it.
    const capped =
      block.maxLoopCostUSD !== "" && Number.isFinite(spend) && spend > 0;
    // The board condition is the one ending that is a fact about something
    // outside this graph, and it is also the one that can stop the loop before
    // it starts — so the sentence a press of Run is approved against has to
    // carry it rather than leave the operator to read it off three controls.
    const drafted = block.stopWhenTasksThresholds;
    // Every number stated, or the sentence says so: a condition with a cleared
    // field is refused at save, and a statement that quietly read it as zero
    // would be approving "until the board is clear" on the operator's behalf.
    const stated =
      drafted.length > 0 &&
      drafted.every((t) => {
        const typed = t.atMost.trim();
        const n = Number(typed);
        return typed !== "" && Number.isInteger(n) && n >= 0;
      });
    const board =
      block.stopWhenTasksMountId === "" ? null : (
        <>
          , or once{" "}
          <strong className="mono break-words font-semibold text-ink">
            {block.stopWhenTasksMountId}
            {block.stopWhenTasksFolder ? ` / ${block.stopWhenTasksFolder}` : ""}
            {block.stopWhenTasksIncludeSubfolders
              ? " and everything under it"
              : ""}
          </strong>{" "}
          has{" "}
          {stated ? (
            <strong className="font-semibold text-ink">
              {/* The same formatter the live instance's block line uses, so a
                  loop states one ending in one wording on both pages. */}
              {fmtBoardThresholds(
                block.stopWhenTasksStatuses.split(",") as TaskStatusDTO[],
                drafted.map((t) => ({
                  priority: t.priority as TaskPriorityDTO | "any",
                  atMost: Number(t.atMost),
                })),
              )}
            </strong>
          ) : (
            <strong className="font-semibold text-danger">
              an unstated number of tasks left
            </strong>
          )}
        </>
      );
    const passCap =
      Number.isInteger(passes) && passes > 0 ? (
        <strong className="font-semibold text-warn">
          {passes} pass{passes === 1 ? "" : "es"}
        </strong>
      ) : (
        <strong className="font-semibold text-danger">
          an unstated number of passes
        </strong>
      );
    const spentBetween = capped ? (
      <>
        , or once they have spent{" "}
        <strong className="font-semibold text-warn">{fmtUSD(spend)}</strong>{" "}
        between them
      </>
    ) : null;
    // Where the loop's own DONE comes from. With a section it is the *last*
    // member's, because that is the run `planLoopPass` reads `reportedDone` off
    // — and naming the wrong block is how somebody asks the wrong agent for it.
    const reporter =
      body.length === 0 ? (
        "the agent"
      ) : (
        <strong className="font-semibold text-ink">
          {blockLabel(body[body.length - 1])}
        </strong>
      );

    if (body.length > 0) {
      // Not "Repeats in {where} … under {guards}": with a section, the loop's
      // own workspace, template, task and agent are read by nothing. Every run
      // a pass creates is the member's own, so the sentence names the members
      // and says the guards are theirs rather than claiming a set the members
      // do not use.
      const worst =
        Number.isInteger(passes) && passes > 0 ? passes * body.length : null;
      return (
        <p className="mb-3.5 text-sm leading-normal text-ink-muted">
          Repeats{" "}
          <strong className="font-semibold text-ink">
            {body.length} block{body.length === 1 ? "" : "s"}
          </strong>{" "}
          each pass, in this order:{" "}
          {body.map((member, index) => (
            <span key={member.id}>
              {index > 0 && ", then "}
              <strong className="font-semibold text-ink">
                {blockLabel(member)}
              </strong>
            </span>
          ))}
          . Each is a whole run in its own workspace, under its own guards, with
          no approval. At most {passCap}, so{" "}
          {worst === null ? (
            <strong className="font-semibold text-danger">
              an unstated number of runs
            </strong>
          ) : (
            <strong className="font-semibold text-warn">
              up to {worst} run{worst === 1 ? "" : "s"}
            </strong>
          )}
          . It stops when {reporter} reports the work complete, when a pass does
          not complete, after the pass cap{spentBetween}
          {board}.
        </p>
      );
    }

    return (
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        Repeats in {where}, each pass a whole run under {guards}
        {asAgent ? <>, as {asAgent}</> : null}. It stops when {reporter} reports
        the work complete, when a pass does not complete,{" "}
        {capped ? "after " : "or after "}
        {passCap}
        {spentBetween}
        {board}.
      </p>
    );
  }

  return (
    <p className="mb-3.5 text-sm leading-normal text-ink-muted">
      Runs in {where}, under {guards}
      {asAgent ? <>, as {asAgent}</> : null}.
    </p>
  );
}

function BlockPanel({
  block,
  blocks,
  links,
  templates,
  templateName,
  agents,
  agentsLoaded,
  ambientLine,
  mounts,
  foldersFor,
  board,
  onChange,
  onRemove,
}: {
  block: BlockDraft;
  /** The whole graph: a loop's section is read out of it, in its order. */
  blocks: readonly BlockDraft[];
  /** Its links, which are what say what a loop repeats and in what order. */
  links: readonly LinkDraft[];
  templates: RunTemplateDTO[];
  templateName: (id: string) => string | null;
  agents: AgentDTO[];
  agentsLoaded: boolean;
  ambientLine: string | null;
  mounts: WorkspaceMountDTO[];
  /**
   * The folders of one workspace. A function rather than a list, because a loop
   * block names two workspaces: the one it runs in and the one whose board it
   * counts, and those are not required to be the same.
   */
  foldersFor: (mountId: string) => WorkspaceFolderDTO[];
  /** What this block's board condition counts today, or null when it sets none. */
  board: LoopBoardReadingDTO | null;
  onChange: (patch: Partial<BlockDraft>) => void;
  onRemove: () => void;
}) {
  const mount = mounts.find((m) => m.id === block.mountId);
  const folders = foldersFor(block.mountId);
  /** Whether the board condition is on, which is the project picker's answer. */
  const boardOn = block.stopWhenTasksMountId !== "";
  const thresholds = block.stopWhenTasksThresholds;

  /**
   * Every project this loop may be pointed at: each mount's root, and each
   * folder under it.
   *
   * Off the workspace scan rather than off the board's own rows, which is the
   * one place this parts company with `places` in `src/app/tasks/page.tsx`:
   * that list is derived from the tasks that exist, and a loop is most often
   * pointed at a project whose backlog is filled *between* passes — or by the
   * schedule that starts it. A project with nothing on it today would otherwise
   * be the one project unpickable.
   */
  const projects = mounts.flatMap((m) => [
    {
      key: projectKey(m.id, ""),
      label: projectLabel(m.label, ""),
      available: m.available,
    },
    ...foldersFor(m.id).map((f) => ({
      key: projectKey(m.id, f.path),
      label: projectLabel(m.label, f.path),
      available: m.available,
    })),
  ]);
  const projectValue = boardOn
    ? projectKey(block.stopWhenTasksMountId, block.stopWhenTasksFolder)
    : NO_PROJECT;
  // A saved condition may name a folder the scan no longer lists — deleted, or
  // past the per-mount cap. Kept as an option rather than dropped, because a
  // `<select>` with no matching value draws its first one, and that would be
  // this panel silently repointing a loop at a different backlog.
  if (boardOn && !projects.some((p) => p.key === projectValue)) {
    projects.unshift({
      key: projectValue,
      label: projectLabel(
        block.stopWhenTasksMountId,
        block.stopWhenTasksFolder,
      ),
      available: true,
    });
  }

  /** The first choice no threshold has taken, or null when all five are. */
  const unusedPriority =
    Object.keys(THRESHOLD_PRIORITY_LABEL).find(
      (p) => !thresholds.some((t) => t.priority === p),
    ) ?? null;

  const patchThreshold = (i: number, patch: Partial<ThresholdDraft>) =>
    onChange({
      stopWhenTasksThresholds: thresholds.map((t, j) =>
        j === i ? { ...t, ...patch } : t,
      ),
    });
  const removeThreshold = (i: number) =>
    onChange({
      stopWhenTasksThresholds: thresholds.filter((_, j) => j !== i),
    });
  const addThreshold = () => {
    if (unusedPriority === null) return;
    onChange({
      stopWhenTasksThresholds: [
        ...thresholds,
        { priority: unusedPriority, atMost: "0" },
      ],
    });
  };

  /**
   * What the picked project holds right now, beside the picker.
   *
   * The figure the thresholds below are compared against, so somebody typing
   * one can see what it means today rather than saving a guess and finding out
   * a pass later. Every priority, because the row under it can name any of
   * them. The server's own reading — see `boards` in the editor above.
   *
   * With the condition off, or before the first check has answered, the row
   * says *when* the condition is read instead: that it is read before the first
   * pass is what lets it stop a loop that has not started, and it is the fact
   * that says what turning this on buys.
   */
  const WHEN_COUNTED =
    "Counted before every pass, including the first — a backlog already clear starts no run";
  const boardCountLine = !boardOn
    ? WHEN_COUNTED
    : board?.error
      ? board.error
      : board?.counts
        ? `${board.counts.total} ${block.stopWhenTasksStatuses
            .split(",")
            .join(" or ")} now — ` +
          Object.entries(board.counts.byPriority)
            .map(([priority, n]) => `${n} ${priority}`)
            .join(", ")
        : WHEN_COUNTED;
  const missingTemplate =
    block.templateId !== "" && templateName(block.templateId) === null;
  const agent = agents.find((a) => a.id === block.agentId) ?? null;
  // Only once the registry has answered — see `agentsLoaded`.
  const missingAgent = block.agentId !== "" && agentsLoaded && agent === null;
  const orchestrator = block.kind === "orchestrator";
  // A loop block is a **region**: a frame round the blocks it repeats. It holds
  // the two caps and the board condition, and nothing that describes a run —
  // `draftToGraph` sends none of those fields for a loop, and `normalizeNode`
  // refuses each of them by name, so the controls below that still offer them
  // are inert. Removing those controls is the canvas run's; leaving them
  // costs a graph nothing, because what they set is dropped before the wire.
  const loop = block.kind === "loop";
  // A merge block holds none of the fields below the kind picker: no guards,
  // because it starts no agent; no workspace or folder, because it works in
  // whichever repository each branch came from; and no task, because what it
  // lands is whatever the blocks in front of it left behind.
  const merge = block.kind === "merge";

  // The section in the order a pass will create it, which is the order the
  // statement reads out and the rows below number. Empty on every kind but a
  // loop, and on a loop with no “repeats” link yet — which is a graph the
  // server refuses, so what this surface draws for it is a loop mid-assembly
  // rather than a loop that repeats itself. That mode is gone.
  const body = sectionOf(block.id, blocks, links)
    .map((id) => blocks.find((b) => b.id === id))
    .filter((b): b is BlockDraft => b !== undefined);

  const guards: ReactNode = missingTemplate ? (
    <strong className="font-semibold text-danger">
      a template that has been deleted
    </strong>
  ) : block.templateId === "" ? (
    <strong className="font-semibold text-ink">
      the default guard set in Settings
    </strong>
  ) : (
    <>
      the guards of{" "}
      <strong className="font-semibold text-ink">
        {templateName(block.templateId)}
      </strong>
    </>
  );

  // `break-words` because a folder is the one value in this sentence a browser
  // will not break on its own: it has no spaces, and `/` is not a break
  // opportunity, so a deep path is a single unbreakable run that pushes the
  // sentence past a 390px viewport and takes the page sideways with it.
  const where: ReactNode = (
    <strong className="mono break-words font-semibold text-ink">
      {mount?.label ?? (block.mountId || "no workspace")}
      {block.folder ? ` / ${block.folder}` : " — the whole workspace"}
    </strong>
  );

  // Null on a block that names none, which is the ordinary block: a sentence
  // saying "and as no agent" would put a permanent phrase on every graph in the
  // app to describe the absence of an option most of them never take.
  const asAgent: ReactNode | null =
    block.agentId === "" ? null : missingAgent ? (
      <strong className="font-semibold text-danger">
        an agent that has been deleted
      </strong>
    ) : agent && !agent.usable ? (
      <strong className="font-semibold text-danger">
        {agent.name}, which Claude Code will not register
      </strong>
    ) : (
      <strong className="font-semibold text-ink">
        {agent?.name ?? "a saved agent"}
      </strong>
    );

  return (
    <>
      <BlockStatement
        block={block}
        body={body}
        guards={guards}
        where={where}
        asAgent={asAgent}
      />

      <ListGroup className="mb-4">
        <ListRow label="Name" htmlFor={`${block.id}-name`}>
          <div className={ROW_CONTROL}>
            <Input
              id={`${block.id}-name`}
              value={block.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Update dependencies"
            />
          </div>
        </ListRow>

        <ListRow label="Block" htmlFor={`${block.id}-kind`}>
          <div className={ROW_CONTROL}>
            <Select
              id={`${block.id}-kind`}
              value={block.kind}
              onChange={(e) =>
                onChange({ kind: e.target.value as WorkflowNodeKind })
              }
            >
              {(Object.keys(KIND_LABEL) as WorkflowNodeKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </Select>
          </div>
        </ListRow>
      </ListGroup>

      {/* Three named groups from here down, in a fixed order: what the block
          does, where it runs and under what, and what its child is started as.
          Thirteen rows under one card title read as a form to fill in; three
          questions read as a block to check. The agent group stays the third
          rather than becoming a row of the second — an agent holds no tool list
          and no permission mode, so a row inside the guards group would claim
          it bounds something. */}
      {orchestrator && (
        <ListGroup
          className="mb-4"
          label="What it does"
          footnote={
            <span className="text-warn">
              What this block decides on starts with no approval — this number is
              the whole of what you are agreeing to
            </span>
          }
        >
          <ListRow label="Most runs it may start" htmlFor={`${block.id}-fanout`}>
            <div className={ROW_CONTROL_NARROW}>
              <Input
                id={`${block.id}-fanout`}
                type="number"
                min={1}
                max={MAX_FAN_OUT}
                className="tabular-nums"
                value={block.fanOut}
                onChange={(e) => onChange({ fanOut: e.target.value })}
              />
            </div>
          </ListRow>
        </ListGroup>
      )}

      {loop && (
        /* Read-only, and that is the change this group exists to record: what a
           loop repeats is said once, on the canvas, by the “repeats” link and
           the links after it. A control here would be a second way to set one
           fact — which is what this group was, beside an order it could not
           set and did not show. */
        <ListGroup
          className="mb-4"
          label="What it repeats"
          footnote={
            body.length === 0
              ? "Draw a “repeats” link from this block to the one each pass starts at"
              : "Link the section along with ordinary links; what comes after the loop is linked from this block"
          }
        >
          {body.length === 0 ? (
            <ListRow label="Its own task">
              <span className="text-sm text-ink-faint">
                Every pass is one run of this block
              </span>
            </ListRow>
          ) : (
            body.map((member, index) => (
              <ListRow
                key={member.id}
                label={blockLabel(member)}
                description={`${KIND_LABEL[member.kind]} · ${index === 0 ? "each pass starts here" : "once per pass"}`}
              >
                {/* Which members end the loop, not which one. DONE is every run
                    member of a pass reporting it, so naming the last of them as
                    the one that counts would be telling the operator to read an
                    exit condition that is not the one the loop uses — and with
                    a section that forks there is no last one to name. */}
                <span className="text-sm text-ink-faint">
                  {member.kind === "run" ? "its DONE counts" : ""}
                </span>
              </ListRow>
            ))
          )}
        </ListGroup>
      )}

      {loop && (
        <ListGroup
          className="mb-4"
          label="How often"
          footnote={
            <span className="text-warn">
              Each pass is a whole run, with its own work cycles and its own
              spend — the pass cap is the whole of what you are agreeing to
            </span>
          }
        >
          <ListRow label="Most passes" htmlFor={`${block.id}-passes`}>
            <div className={ROW_CONTROL_NARROW}>
              <Input
                id={`${block.id}-passes`}
                type="number"
                min={1}
                max={MAX_LOOP_PASSES}
                className="tabular-nums"
                value={block.maxPasses}
                onChange={(e) => onChange({ maxPasses: e.target.value })}
              />
            </div>
          </ListRow>

          {/* On the row for the guards picker's reason: it is a fact about what
              this control does, and only a row's description reaches it. */}
          <ListRow
            label="Spending limit across passes"
            htmlFor={`${block.id}-loopcost`}
            description="Checked between passes; it never widens the limit for the whole workflow"
          >
            <div className={ROW_CONTROL}>
              <Input
                id={`${block.id}-loopcost`}
                type="number"
                min={0}
                step="0.5"
                placeholder="off"
                unit="USD"
                className="tabular-nums"
                value={block.maxLoopCostUSD}
                onChange={(e) => onChange({ maxLoopCostUSD: e.target.value })}
              />
            </div>
          </ListRow>

          {/* The fifth ending, and the only one that is a fact about something
              outside this graph. Off unless a project is picked, so a saved
              graph that says nothing here keeps the four it already had. One
              control and not two: the board names a project by the pair, and an
              operator picking a workspace and then a folder under it is being
              asked to assemble a name the board already has a word for. */}
          <ListRow
            label="Stop when a project's board is clear"
            htmlFor={`${block.id}-boardproject`}
            description={boardCountLine}
          >
            <div className={ROW_CONTROL}>
              <Select
                id={`${block.id}-boardproject`}
                value={projectValue}
                onChange={(e) => {
                  const pair = projectPair(e.target.value);
                  onChange({
                    stopWhenTasksMountId: pair.mountId,
                    stopWhenTasksFolder: pair.folder,
                  });
                }}
              >
                <option value={NO_PROJECT}>
                  Off — the caps are the only ending
                </option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key} disabled={!p.available}>
                    {p.label}
                    {p.available ? "" : "  (not mounted)"}
                  </option>
                ))}
              </Select>
            </div>
          </ListRow>

          {boardOn && (
            <>
              {/* Off by default, and the row says what that costs rather than
                  what the switch does: the board groups a project by its own
                  folder, so `…/app` and `…/app/docs` are two backlogs there and
                  stay two here unless somebody says otherwise. */}
              <ListRow
                label="Count folders under it"
                description={
                  block.stopWhenTasksIncludeSubfolders
                    ? "One project, counting every folder beneath it"
                    : "The board counts this folder's own tasks; anything filed under it is a different project"
                }
              >
                <Switch
                  checked={block.stopWhenTasksIncludeSubfolders}
                  onChange={(checked) =>
                    onChange({ stopWhenTasksIncludeSubfolders: checked })
                  }
                  label="Count folders under it"
                />
              </ListRow>

              {/* The rule about `claimed` rides the row rather than the
                  group's footnote, because it is a fact about what is in this
                  picker and only a row's description is wired to the control. */}
              <ListRow
                label="Which tasks count"
                htmlFor={`${block.id}-boardstatuses`}
                description={
                  block.stopWhenTasksStatuses === "open"
                    ? "A claim is a record of which run holds a task, never a lease"
                    : "A claim has no clock on it, so one task left claimed by a run that died holds this loop open for every pass it is allowed"
                }
              >
                <div className={ROW_CONTROL}>
                  <Select
                    id={`${block.id}-boardstatuses`}
                    value={block.stopWhenTasksStatuses}
                    onChange={(e) =>
                      onChange({ stopWhenTasksStatuses: e.target.value })
                    }
                  >
                    <option value="open">Open</option>
                    <option value="open,claimed">Open and claimed</option>
                  </Select>
                </div>
              </ListRow>

              {/* Not a `ListRow`: a threshold is three controls and a word,
                  not a label and a value, and in a row's shrink-to-fit control
                  column the three squeeze each other — measured at 1280, the
                  number field came out at 40px of its 96 and clipped its own
                  digits. A full-width row inside the same box lets the priority
                  picker take the slack instead. `GroupLabel`'s note says the
                  contents of a group are not always rows. */}
              {thresholds.map((threshold, i) => (
                <div
                  key={i}
                  className="flex min-h-[var(--control-h-lg)] max-md:min-h-11 flex-wrap items-center gap-2 px-3.5 py-2.5"
                >
                  {/* Any one of them ends the loop, and the words say so: every
                      row after the first is another way for the same loop to
                      stop, never a second condition it also has to meet. */}
                  <label
                    htmlFor={`${block.id}-boardatmost-${i}`}
                    // One width for both words, or the rows break in different
                    // places: “or at” leaves room the wider “Stop at” does not,
                    // so on a phone one row wrapped before its picker and the
                    // next after it. It also lines the numbers up, which is the
                    // whole of what a column of them is for.
                    className="mb-0 block w-14 shrink-0 text-sm font-normal text-ink"
                  >
                    {i === 0 ? "Stop at" : "or at"}
                  </label>
                  <div className="w-20 shrink-0">
                    <Input
                      id={`${block.id}-boardatmost-${i}`}
                      type="number"
                      min={0}
                      className="tabular-nums"
                      value={threshold.atMost}
                      onChange={(e) =>
                        patchThreshold(i, { atMost: e.target.value })
                      }
                    />
                  </div>
                  {/* `max-md:min-w-40` is what sends this to a line of its own
                      on a phone, by `ListRow`'s mechanism: flex line breaking
                      clamps an item's hypothetical size by its min-width, so a
                      select that cannot have 160px wraps and the label and the
                      number stay where they are. Measured at 390 without it,
                      the select got 76px and drew “Any pr” — a control that
                      clips the word it exists to state. Above the breakpoint
                      the floor never binds and nothing moves. */}
                  <div className="min-w-0 flex-1 max-md:min-w-40">
                    <Select
                      aria-label="Which tasks this number counts"
                      value={threshold.priority}
                      onChange={(e) =>
                        patchThreshold(i, { priority: e.target.value })
                      }
                    >
                      {Object.entries(THRESHOLD_PRIORITY_LABEL).map(
                        ([value, label]) => (
                          <option
                            key={value}
                            value={value}
                            // A priority already spoken for is disabled rather
                            // than merged: two numbers for one priority is an
                            // "or" in which the larger silently decides, which
                            // is a line the operator wrote that never fires.
                            disabled={
                              value !== threshold.priority &&
                              thresholds.some((t) => t.priority === value)
                            }
                          >
                            {label}
                          </option>
                        ),
                      )}
                    </Select>
                  </div>
                  {thresholds.length > 1 && (
                    <div className="shrink-0">
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => removeThreshold(i)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {thresholds.length < MAX_LOOP_BOARD_THRESHOLDS &&
                unusedPriority !== null && (
                  <div className="flex min-h-[var(--control-h-lg)] max-md:min-h-11 items-center px-3.5 py-2.5">
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={addThreshold}
                    >
                      Add a number
                    </Button>
                  </div>
                )}

            </>
          )}
        </ListGroup>
      )}

      {merge && (
        <ListGroup
          className="mb-4"
          label="What it does"
          footnote={
            <>
              Each branch goes onto the target its own run recorded, not one
              named here. Your own checkout must be clean and on that branch, or
              this block refuses that repository.
            </>
          }
        >
          <ListRow label="How to land" htmlFor={`${block.id}-strategy`}>
            <div className={ROW_CONTROL}>
              <Select
                id={`${block.id}-strategy`}
                value={block.mergeStrategy}
                onChange={(e) =>
                  onChange({ mergeStrategy: e.target.value as MergeStrategyDTO })
                }
              >
                <option value="merge">Merge commit</option>
                <option value="squash">Squash</option>
              </Select>
            </div>
          </ListRow>

          {/* The off state says what the *switch* withholds, not what the
              block will do — `BlockStatement` above already prints "A
              conflicting branch is reported and left alone." for this block,
              and the row repeating it verbatim spent a description saying
              nothing the panel had not said one paragraph earlier. */}
          <ListRow
            label="Let Claude resolve a conflict"
            htmlFor={`${block.id}-autoresolve`}
            description={
              block.mergeAutoResolve
                ? "Saving this is the authorisation, and it is billed"
                : "Off, so this block authorises no spending"
            }
          >
            <Switch
              id={`${block.id}-autoresolve`}
              checked={block.mergeAutoResolve}
              onChange={(next) => onChange({ mergeAutoResolve: next })}
            />
          </ListRow>
        </ListGroup>
      )}

      {!merge && (
        <>
          {/* The task is the rest of "what it does", so it sits with the caps
              that bound it rather than at the foot of the panel — a run block,
              which has no caps, has these two and nothing else under that
              heading. Label above the control rather than beside it, which is
              the same exception the run form and Settings make: a nine-line
              text region has nothing to align a right edge against, which is
              also why neither is a row of a `ListGroup`. */}
          {/* The other three kinds take this heading from the `ListGroup` of
              caps above. A run block has none, so without it the panel went
              from the name and the kind straight to two unlabelled text
              regions, and the first heading a reader met was `Where it runs` —
              which made the task read as part of that question rather than as
              the whole of this one. It is the bare label rather than an empty
              `ListGroup`, which would draw a rounded box with a hairline round
              nothing above the two fields. */}
          {/* A loop's two groups above are named for its section and its caps,
              so unlike an orchestrator it still owes the task below a heading
              of its own. */}
          {!orchestrator && <GroupLabel>What it does</GroupLabel>}

          <Field
            label={
              orchestrator ? "What to decide" : loop ? "Task to repeat" : "Task"
            }
            htmlFor={`${block.id}-task`}
            // How the loop *ends*, and it belongs on the field that decides it:
            // `reported_done` is set by the agent printing DONE on a line of its
            // own, so a task that never asks for it can only stop on a cap.
            //
            // A loop repeating a *section* reads none of this: every run of a
            // pass is a member's own, so the field is still here — the section
            // can be cleared again — and the hint says what it is worth now
            // rather than a sentence about passes that is no longer true.
            hint={
              loop && body.length > 0
                ? "Not read while this block repeats a section — each block in it has its own task"
                : loop
                  ? "Every pass gets this same text — ask for DONE when the work is complete, which is what ends the loop"
                  : undefined
            }
          >
            <Textarea
              id={`${block.id}-task`}
              value={block.task}
              onChange={(e) => onChange({ task: e.target.value })}
              placeholder={
                orchestrator
                  ? "What this block should look at, and what makes a piece of work worth starting."
                  : "What this block asks the agent to do."
              }
            />
          </Field>

          <Field
            label={
              orchestrator
                ? "Standing instructions for the runs it starts"
                : loop
                  ? "Standing instructions for every pass"
                  : "Standing instructions"
            }
            htmlFor={`${block.id}-prompt`}
            hint="Replaces the template's own prompt"
          >
            <Textarea
              id={`${block.id}-prompt`}
              value={block.promptOverride}
              onChange={(e) => onChange({ promptOverride: e.target.value })}
              className="min-h-[64px]"
            />
          </Field>

          {/* One group rather than two, because "under what" and "where" are
              one question a press of Run is approved against, and the guards
              picker alone was a labelled box holding a single row.

              The conditional sentences ride the *row's* description rather than
              the group's footnote, because that is the one `ListRow` wires to
              the control as `aria-describedby` — a footnote is an unlabelled
              paragraph, so a screen reader hears the picker and not what is
              wrong with what is in it. The standing explanation stays a
              footnote, where it belongs to the group. */}
          <ListGroup
            className="mb-4"
            label="Where it runs, and under what"
            footnote={
              missingTemplate
                ? undefined
                : block.templateId === ""
                  ? "Budget, permission mode and isolation come from Settings"
                  : "Budget, permission mode and isolation come from that template"
            }
          >
            <ListRow
              label={
                orchestrator
                  ? "Guards for the runs it starts"
                  : loop
                    ? "Guards for each pass"
                    : "Guards"
              }
              htmlFor={`${block.id}-template`}
              description={
                missingTemplate ? (
                  <span role="alert" className="text-danger">
                    That template has been deleted, so Save will refuse this
                    graph — pick another
                  </span>
                ) : undefined
              }
            >
              <div className={ROW_CONTROL}>
                <Select
                  id={`${block.id}-template`}
                  value={block.templateId}
                  aria-invalid={missingTemplate || undefined}
                  onChange={(e) => onChange({ templateId: e.target.value })}
                >
                  <option value="">Guards from Settings</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {missingTemplate && (
                    <option value={block.templateId}>
                      {block.templateId} (deleted)
                    </option>
                  )}
                </Select>
              </div>
            </ListRow>

            <ListRow label="Workspace" htmlFor={`${block.id}-mount`}>
              <div className={ROW_CONTROL}>
                <Select
                  id={`${block.id}-mount`}
                  value={block.mountId}
                  // The folder belongs to the mount, so it cannot survive the
                  // mount changing under it.
                  onChange={(e) =>
                    onChange({ mountId: e.target.value, folder: "" })
                  }
                >
                  {mounts.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.label}
                      {m.available ? "" : "  (not mounted)"}
                    </option>
                  ))}
                </Select>
              </div>
            </ListRow>

            {/* On the row, not in a footnote: this is a fact about what is in
                the picker, and only a row's description reaches the control. */}
            <ListRow
              label="Folder"
              htmlFor={`${block.id}-folder`}
              description={
                orchestrator ? (
                  "Where it looks; the runs it starts must be in this workspace"
                ) : block.folder === "" ? (
                  <span className="text-warn">
                    The whole workspace — no other run in it can start meanwhile
                  </span>
                ) : undefined
              }
            >
              <div className={ROW_CONTROL}>
                <Select
                  id={`${block.id}-folder`}
                  value={block.folder}
                  onChange={(e) => onChange({ folder: e.target.value })}
                  disabled={!mount}
                >
                  <option value="">
                    {mount ? `${mount.label} — the whole workspace` : "—"}
                  </option>
                  {folders.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path}
                      {f.isGitRepo ? "  (git)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
            </ListRow>
          </ListGroup>

          {/* A group of its own rather than a row in the guards one, because an
              agent is not a guard: it holds no tool list and no permission
              mode, so a row inside that group would claim it bounds something.
              Shown when there is something to offer — or when this block
              already names one, so a registry that has emptied out cannot hide
              the control that is about to refuse the save. */}
          {(agents.length > 0 || block.agentId !== "") && (
            <ListGroup
              className="mb-4"
              label="What it is started as"
              footnote={
                ambientLine ? (
                  <>
                    {ambientLine}. An agent changes what this block&rsquo;s child
                    is, never what it may do.
                  </>
                ) : (
                  "An agent changes what this block's child is, never what it may do"
                )
              }
            >
              <ListRow
                label={
                  orchestrator
                    ? "This turn is"
                    : loop
                      ? "Each pass is"
                      : "This run is"
                }
                htmlFor={`${block.id}-agent`}
                description={
                  missingAgent ? (
                    <span role="alert" className="text-danger">
                      That agent has been deleted, so Save will refuse this
                      graph — pick another, or none
                    </span>
                  ) : agent && !agent.usable ? (
                    <span role="alert" className="text-danger">
                      {agent.name} is missing its description or its prompt, so
                      Claude Code will not register it and the spawn would fail
                    </span>
                  ) : agent ? (
                    agent.description
                  ) : orchestrator ? (
                    "What this block's own deciding turn is started as — the runs it starts name their own"
                  ) : undefined
                }
              >
                <div className={ROW_CONTROL}>
                  <Select
                    id={`${block.id}-agent`}
                    value={block.agentId}
                    aria-invalid={missingAgent || undefined}
                    onChange={(e) => onChange({ agentId: e.target.value })}
                  >
                    <option value="">No agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.usable ? "" : "  (incomplete)"}
                      </option>
                    ))}
                    {/* An id the registry no longer has still selects
                        something, so the control cannot read as "none" while
                        the graph is about to be refused for naming one. */}
                    {missingAgent && (
                      <option value={block.agentId}>
                        {block.agentId} (deleted)
                      </option>
                    )}
                  </Select>
                </div>
              </ListRow>
            </ListGroup>
          )}

        </>
      )}

      <ButtonRow className="mt-4 border-t border-line pt-3.5">
        <Button variant="ghost" size="compact" onClick={onRemove}>
          Remove block
        </Button>
        <span className="max-md:hidden text-xs text-ink-faint">or press Delete</span>
      </ButtonRow>
    </>
  );
}

function LinkPanel({
  link,
  fromName,
  toName,
  fromIsLoop,
  insideSection,
  onChange,
  onRemove,
}: {
  link: LinkDraft;
  fromName: string;
  toName: string;
  /** Whether a “repeats” link may leave this source at all. */
  fromIsLoop: boolean;
  /** The loop that repeats both ends of this link, or undefined. */
  insideSection: string | undefined;
  onChange: (patch: Partial<LinkDraft>) => void;
  onRemove: () => void;
}) {
  const id = linkKey(link).replace(/[^A-Za-z0-9_-]/g, "-");

  if (link.edge === "repeats") {
    return (
      <>
        <p className="mb-3.5 text-sm leading-normal text-ink-muted">
          <strong className="font-semibold text-ink">{fromName}</strong> repeats{" "}
          <strong className="font-semibold text-ink">{toName}</strong> and
          everything linked after it, once per pass.{" "}
          <span className="text-warn">
            Nothing waits for this link — it says what is inside the loop, not
            what starts after it.
          </span>
        </p>
        <RemoveLinkRow onRemove={onRemove} />
      </>
    );
  }

  // Inside a section the condition is not a choice, and this panel states it
  // rather than offering a control something downstream overrules: a pass has
  // to land what it produced, so a member that did not finish is not something
  // the rest of the section carries on from.
  //
  // The branch is not stated, because it is not the same for every link: a
  // section may fork, and two links carrying one block's branch is refused at
  // Save. `connect` gives the first way out of a block its branch and each
  // later one its own, so what this says is what that link actually does.
  if (insideSection !== undefined) {
    const conforms = link.edge === "on-success";
    return (
      <>
        <p className="mb-3.5 text-sm leading-normal text-ink-muted">
          <strong className="font-semibold text-ink">{toName}</strong> starts
          after <strong className="font-semibold text-ink">{fromName}</strong>{" "}
          inside the section{" "}
          <strong className="font-semibold text-ink">{insideSection}</strong>{" "}
          repeats, only if it completes.{" "}
          {link.continueBranch
            ? `${toName} commits onto ${fromName}'s branch.`
            : `${toName} cuts its own branch, and the section's merge block lands it.`}
          {!conforms && (
            <span className="text-warn">
              {" "}
              This one says otherwise, so the graph is refused. Remove it and
              draw it again.
            </span>
          )}
        </p>
        <RemoveLinkRow onRemove={onRemove} />
      </>
    );
  }

  return (
    <>
      <p className="mb-3.5 text-sm leading-normal text-ink-muted">
        <strong className="font-semibold text-ink">{toName}</strong> starts after{" "}
        <strong className="font-semibold text-ink">{fromName}</strong>
        {link.edge === ""
          ? ", once you have said when."
          : link.edge === "on-success"
            ? ", only if it completes."
            : ", once it finishes either way."}
        {link.continueBranch &&
          ` ${toName} commits onto ${fromName}'s branch rather than cutting its own.`}
      </p>

      <ListGroup className="mb-4">
        <ListRow
          label="Condition"
          htmlFor={`${id}-edge`}
          // On the row rather than in a footnote, so it reaches the picker it
          // is about — see the guards group in `BlockPanel`.
          description={
            link.edge === "" ? (
              <span className="text-warn">
                Neither answer is a safe default, so this one is yours to make —
                until it is answered, Save refuses this graph
              </span>
            ) : undefined
          }
        >
          <div className={ROW_CONTROL}>
            <Select
              id={`${id}-edge`}
              value={link.edge}
              aria-invalid={link.edge === "" || undefined}
              onChange={(e) =>
                onChange({ edge: e.target.value as LinkDraft["edge"] })
              }
            >
              {/* Declaration order, which puts the unanswered state first —
                  the same walk the kind picker above takes over `KIND_LABEL`. */}
              {(Object.keys(EDGE_OPTION_LABEL) as Array<LinkDraft["edge"]>)
                // Containment is offered only where it means something: every
                // other kind of block starts one run and has no passes to
                // repeat anything in, and the server refuses it by name.
                .filter((edge) => edge !== "repeats" || fromIsLoop)
                .map((edge) => (
                  <option key={edge} value={edge}>
                    {EDGE_OPTION_LABEL[edge]}
                  </option>
                ))}
            </Select>
          </div>
        </ListRow>

        <ListRow label="Carry on its branch" htmlFor={`${id}-branch`}>
          <Switch
            id={`${id}-branch`}
            checked={link.continueBranch}
            onChange={(next) => onChange({ continueBranch: next })}
          />
        </ListRow>
      </ListGroup>

      <RemoveLinkRow onRemove={onRemove} />
    </>
  );
}

/** The one control every link panel carries, however much else it states. */
function RemoveLinkRow({ onRemove }: { onRemove: () => void }) {
  return (
    <ButtonRow className="mt-4 border-t border-line pt-3.5">
      <Button variant="ghost" size="compact" onClick={onRemove}>
        Remove link
      </Button>
      <span className="max-md:hidden text-xs text-ink-faint">or press Delete</span>
    </ButtonRow>
  );
}
