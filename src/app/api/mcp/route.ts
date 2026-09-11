import { NextResponse } from "next/server";
import {
  appendMessage,
  chatOwnsRun,
  createProposal,
  createProposalReplacing,
  createQuestions,
  listProposals,
  MAX_OPEN_QUESTIONS,
  MAX_PENDING_PROPOSALS,
  MAX_QUESTION_CHOICES,
  normalizeChoices,
  pendingProposals,
  pendingQuestions,
  proposalByReference,
  proposalDeps,
  subjectForCapability,
  type CapabilitySubject,
  type ChatProposalRow,
  type ProposalDependency,
  type ProposalInput,
  type QuestionInput,
} from "@/lib/chat";
import {
  currentKnowledge,
  emitBlockRuns,
  folderRefusal,
  instanceOwnsRun,
  lastRunAt,
  listWorkflows,
  liveBlocksOf,
  liveRunsOf,
  normalizeWorkflowInput,
} from "@/lib/workflows";
import {
  createTask,
  currentTaskKnowledge,
  getTask,
  listTasks,
  normalizeTaskInput,
  runLinksForTasks,
  taskForRun,
  taskListItemDTO,
  taskRefusal,
  tasksForRun,
  updateTask,
  TASK_ORIGINS,
  TASK_STATUSES,
  type TaskActor,
  type TaskOrigin,
  type TaskStatus,
} from "@/lib/tasks";
import {
  addTaskComment,
  listTaskComments,
  MAX_TOOL_TASK_COMMENTS,
  type TaskComment,
} from "@/lib/taskComments";
import { completeTaskWithValidation } from "@/lib/validation";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  normalizeTemplateInput,
  updateTemplate,
} from "@/lib/templates";
import {
  agentRefusal,
  currentAgentKnowledge,
  listAgents,
  listAmbientAgents,
} from "@/lib/agents";
import {
  activeRuns,
  currentSnapshot,
  DEPENDENCY_EDGES,
  describeFolder,
  getRun,
  listRuns,
  providerRecordsSpend,
  resolveWorkspaceFolder,
  runEvents,
  type DependencyEdge,
} from "@/lib/orchestrator";
import { diffAsText, runDiff } from "@/lib/diff";
import { rivalContinuation } from "@/lib/proposalContinuation";
import { chatGuards, getSettings } from "@/lib/settings";
import { enabledModels, modelRefusal } from "@/lib/modelCatalogue";
import {
  MAX_REMOTES_READ,
  folderKey,
  githubRemotes,
  scanWorkspace,
} from "@/lib/workspace";
import { mountById } from "@/lib/config";
import { fmtUSD } from "@/lib/format";
import { auditMutation, sourceAddress } from "../../../lib/requestLog";
import { opsLog } from "../../../lib/ops";

/**
 * What one `get_run_diff` may return.
 *
 * Smaller than the reviewer's budget on purpose: a review is one call about one
 * diff, where this is a turn that may look at several runs and still has to
 * think afterwards — and `settings.chatTurnBudgetUSD` is what pays for it.
 */
const MAX_DIFF_TEXT_BYTES = 60_000;

/**
 * What a chat may call a proposal, so another one can point at it.
 *
 * The same shape a workflow node id and an emitted spec id take, and for the
 * same reason: it travels in messages and in refusals a person reads.
 */
const SPEC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tool surface the orchestrator chat calls back into.
 *
 * MCP over streamable HTTP, spoken by hand rather than through the SDK: the
 * subset a `-p` child actually uses is `initialize`, `tools/list` and
 * `tools/call`, and adding a dependency to the image — which pins the CLI for
 * exactly this kind of reverse-engineered contract — buys less than it costs.
 * Responses are plain JSON rather than SSE, which the transport permits for a
 * single reply and which is all a request/response tool call needs.
 *
 * **Why these tools live in this process.** `createRun`'s folder claim is a
 * synchronous check-then-insert, atomic only because one Node event-loop turn
 * runs to completion; a stdio MCP server would be a second process doing
 * check-then-insert against the same SQLite file, which silently permits the
 * two-agents-in-one-directory collision the claim exists to prevent. See the
 * note at the top of `db.ts`.
 *
 * **Why this route authenticates itself.** `middleware.ts` runs in the edge
 * runtime and cannot reach SQLite or module state, so it cannot check a
 * per-chat credential — the path is exempted there and the check happens here.
 * The credential is *not* `UF_AUTH_TOKEN`: it is a capability minted for one
 * chat turn and revoked when that turn's child exits, so a copy of it recovered
 * afterwards opens nothing. Every tool below is scoped to the chat it names.
 *
 * **The tool list depends on who is asking.** A capability speaks for a chat or
 * for one orchestrator block of one workflow instance, and the two are offered
 * different tools rather than one list with guards inside it: a chat proposes
 * and saves templates and cannot emit, a block emits and cannot do either. The
 * split is in `toolsFor` and the check is repeated in `callTool`, because a tool
 * absent from a list is not a tool absent from the wire.
 *
 * Note what is absent from both: nothing here stops, resumes or reopens a run,
 * nothing here presses Run on a workflow, nothing here writes to a folder, and
 * nothing here sets a budget, a permission mode or an isolation choice. A chat's
 * most is a `chat_proposals` row, inert until a person approves it — of a run,
 * of a run ordered behind another one, or of a whole workflow, and approving
 * that last one *saves* a graph rather than starting it, so the press of Run
 * stays the operator's. A block's most is a list of run specs, which start —
 * under the guards the block's *saved* template supplies, in the mount that
 * block was pointed at, up to the number a person agreed to when they saved the
 * graph.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Tools both kinds of caller get: everything that only reads.
 *
 * `list_agents` is deliberately in here rather than in `CHAT_TOOLS`, and the
 * placement *is* the decision: both subjects can name an agent — a chat on a
 * proposal the operator then approves, a block on a run it emits — so both have
 * to be able to see what exists before they name one, and the alternative is a
 * block guessing at names out of its system prompt. It grants neither of them
 * anything: an agent holds no tool list and no permission mode, so what this
 * list can move is who a run *is* and never what a run may do. Being here is
 * also what makes the two guards in `callTool` say the right
 * thing about it — they refuse the tools of the *other* subject, and a shared
 * tool is in neither list.
 */
const SHARED_TOOLS = [
  {
    name: "list_folders",
    description:
      "List every workspace mount and the project folders in it, with which " +
      "runs are already working there and, for git repositories, the GitHub " +
      "repo they point at. Folder paths for propose_run must come from here. " +
      "Naming the GitHub repo costs a git call per folder, so at most " +
      `${MAX_REMOTES_READ} are identified per call. Every folder this call ` +
      "did not look at carries repoUnread, and repoLookups counts them: a " +
      'null "repo" WITHOUT repoUnread means the folder is genuinely not a ' +
      "GitHub repository, and one WITH it means nobody asked yet. To ask, " +
      "call again with the nextOffset from repoLookups, or pass folders to " +
      "identify only the ones you need.",
    inputSchema: {
      type: "object",
      properties: {
        folders: {
          type: "array",
          items: { type: "string" },
          description:
            'Folders to identify, each as "mountId:folder" — e.g. ' +
            '"w1:acme/web" for the folder listed as mountId w1, folder ' +
            `acme/web. Omit to identify the next ${MAX_REMOTES_READ} in ` +
            "listing order.",
        },
        offset: {
          type: "number",
          description:
            "How many git folders to skip before identifying any. Pass the " +
            "nextOffset from a previous call to reach the ones it left out.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_templates",
    description:
      "List saved run templates, with the guards each one supplies — budget, " +
      "work-cycle limit, permission mode, isolation — and the default guard " +
      "set a proposal that names no template runs under.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_runs",
    description:
      "List recent runs with their status, folder and spend, so work already " +
      "in flight is not proposed a second time. A run whose status is " +
      "needs-review is not in flight: it is finished, holds nothing, and is " +
      "waiting on a person, so proposing work that depends on it parks that " +
      "work on the same question.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_run",
    description:
      "Everything known about one run: its task, how it ended, what it spent, " +
      "the tail of its log, and a summary of the files it changed. Read this " +
      "before proposing follow-up work on a run that already happened.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "id from list_runs." },
        events: {
          type: "number",
          description: "How many recent log entries to include (default 20).",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run_diff",
    description:
      "The patch a run produced, truncated at a file boundary if it is large " +
      "— the file list is always complete and the omitted files are named. " +
      "Available for your own runs: in a chat, the runs this conversation " +
      "proposed; in a workflow block, the runs of this instance. For any other " +
      "run, get_run reports what it changed as a file summary, and you can read " +
      "its folder directly.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "id from list_runs." },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_usage",
    description:
      "How much of the 5-hour and weekly windows is spent, the current burn " +
      "rate, and how many runs are working or queued. Use it to say whether " +
      "now is a good time to start work, not to decide any run's guards.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_workflows",
    description:
      "Saved workflows: re-runnable graphs of blocks the operator starts with " +
      "one press of Run. Read before proposing a new one — the work may " +
      "already be a workflow, and a graph running right now is worth " +
      "mentioning rather than duplicating.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_agents",
    description:
      "Saved agents: roles a run can be started AS. Naming one replaces the " +
      "run's own system prompt with the agent's, so the run does the work as " +
      "that agent rather than handing part of it to one. Read this before " +
      "naming any — the operator writes @name in their message and this is " +
      "what turns that into the agent to start the run as. An agent carries a " +
      "description and a prompt and nothing else: it changes who the run is, " +
      "never what the run is allowed to do, so naming one sets no budget, no " +
      "permission mode and no isolation choice. It also reports the agent " +
      "definitions on this machine that this app did not save, which reach " +
      "every run either way and cannot be named here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    // The board, and the sentence that has to survive both callers reading it:
    // a task is a *brief*, not a run. Nothing on this list is queued, holds a
    // folder or costs anything, and reading it starts nothing — which is what
    // makes it safe to hand a block that emits runs without approval.
    name: "list_tasks",
    description:
      "The operator's backlog: work somebody wrote down, which nothing has " +
      "started. A task is a brief and not a run — it claims no folder, spends " +
      "nothing and is running nowhere — so this says what is worth doing, " +
      "never what is happening. Read it before proposing or emitting work: " +
      "the thing being asked for may already be on the board, and a run named " +
      "for the task it does is one the operator can follow. Bodies are " +
      "clipped; call get_task for a whole brief.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "claimed", "done", "dropped"],
          description:
            "Only tasks in this state. Omit for the whole board. 'open' is " +
            "what is waiting for somebody, 'claimed' is what a run already " +
            "holds — proposing a second run for one of those is how two " +
            "agents end up with the same brief.",
        },
        mountId: {
          type: "string",
          description:
            "Only tasks filed against this mount, exactly as list_folders " +
            "gives it. Send it with folder to narrow to one project.",
        },
        folder: {
          type: "string",
          description:
            "Only tasks filed against this folder within that mount. Needs " +
            "mountId beside it; alone it narrows nothing.",
        },
        origin: {
          type: "string",
          enum: ["operator", "chat", "block", "run"],
          description:
            "Who filed it. 'operator' is what a person wrote down themselves.",
        },
        offset: {
          type: "number",
          description: "Skip this many. The reply says how many are left.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description:
      "One task's whole brief, unclipped, with what it is filed against and " +
      "which runs were started for it. Call it before working from a task " +
      "list_tasks showed you: the list clips the body, and the body is the " +
      "whole of what the task says.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "An id from list_tasks." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

/**
 * Everything a work cycle gets, and the whole of it.
 *
 * **Four tools, and what is absent is the design.** A run does not get
 * `SHARED_TOOLS`: not `list_runs`, not `get_run_diff`, not `list_folders`, and
 * deliberately not `list_tasks` — a work cycle is an unattended agent that was
 * pointed at one folder and given one brief, and the whole backlog is neither
 * its business nor something it can act on. `list_my_tasks` is the narrower
 * question it can actually answer from: what am I holding, and what is already
 * written down where I am working.
 *
 * Nothing here starts a run, approves anything, reads another run's work or
 * moves a task this run does not hold. The one rule that needs enforcing rather
 * than describing — a run completes only what it holds — is enforced in
 * `tasks.ts` against the row's own `claimed_by_run_id`, compared with the run id
 * off **the capability token**. No tool below takes a run id, and that is not an
 * omission: a `runId` argument would be a work cycle able to close every task on
 * the board by guessing an id out of a list.
 *
 * `comment_on_task` is the fourth and the one that takes a *task* id without
 * being held to the same rule, which is a smaller claim than it looks: a note
 * moves nothing, its author is recorded from the token, and the worst a
 * misdirected one can do is put a sentence signed by this run on a task it was
 * not working. `complete_task` is where an id out of a list closes work nobody
 * did, and that one is still checked against `claimed_by_run_id`.
 */
const RUN_TOOLS = [
  {
    name: "list_my_tasks",
    description:
      "The task this run was started for, and what else is already open in " +
      "the folder you are working in. Not the whole board. Read it before you " +
      "call complete_task, so you close the thing you were given rather than " +
      "one you read about, and before create_task, so you do not write down " +
      "something already on the board.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "complete_task",
    description:
      "Mark a task this run holds as done. You can complete only a task " +
      "already recorded against this run — the one list_my_tasks returns as " +
      "held — and naming any other is refused. Call it when the work the task " +
      "asked for is actually finished, not when you have decided to stop: a " +
      "task marked done is one nobody looks at again. If you could not finish " +
      "it, leave it and say why in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "An id from list_my_tasks, from the tasks you hold.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    // The point of the whole surface: a run that found a second problem writes
    // it down instead of widening its own change. The description says that
    // rather than leaving the model to infer it, because the failure it
    // prevents — a diff that fixed four things nobody asked for — is the one
    // that costs a reviewer the most and never looks like an error.
    name: "create_task",
    description:
      "Write something down on the operator's board for later. Use it for the " +
      "thing you found that needs fixing and is not what you were asked to " +
      "do: file it and carry on with your own work rather than widening it. " +
      "It starts nothing, costs nothing and claims no folder — a task is a " +
      "brief the operator or a later run picks up as a separate decision. It " +
      "files as open and can do nothing else to a task. Filed against the " +
      "folder this run is working in, and under the task you were given, " +
      "unless you say otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short specific label, e.g. 'Fix flaky auth test'.",
        },
        body: {
          type: "string",
          description:
            "The brief: what to do, where, and what done looks like. Written " +
            "for somebody with nothing else to go on — this may be handed to " +
            "an agent months from now that cannot see your work or read this " +
            "conversation. Name files and symbols rather than 'the thing " +
            "above'.",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Omit for normal.",
        },
        parentTaskId: {
          type: "string",
          description:
            "The task this was found while working on. Omit to file it under " +
            "the task this run was started for, which is almost always right.",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    // The half of the board a run could not reach before: the operator writes a
    // note on the task and the run reads it out of `list_my_tasks`, which is why
    // this rides a tool call rather than the appended system prompt. A thread
    // injected into that prompt would rewrite the cached prefix every cycle.
    //
    // It moves nothing, and the description has to say so: a model handed the
    // one write on this surface that is not `create_task` will otherwise read it
    // as a way of closing something without calling `complete_task`.
    name: "comment_on_task",
    description:
      "Write a note on a task: an answer to something the operator asked " +
      "there, what you found, or why the brief is harder than it reads. It " +
      "moves nothing — it cannot close, claim, drop or re-prioritise a task, " +
      "and it does not mark the task as touched. Use complete_task to finish " +
      "the task you hold. Notes are permanent and cannot be edited or deleted, " +
      "and yours is recorded as written by this run.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "An id from list_my_tasks — one you hold, or one open in this " +
            "folder that your work has something to do with.",
        },
        body: {
          type: "string",
          description:
            "What you have to say, written for somebody who cannot see your " +
            "work: name files and symbols rather than 'the change above'. If " +
            "it is a new piece of work rather than a note about this one, call " +
            "create_task instead.",
        },
      },
      required: ["taskId", "body"],
      additionalProperties: false,
    },
  },
];

/** Tools only the orchestrator chat gets. None of them starts anything. */
const CHAT_TOOLS = [
  {
    // The one write on this surface that is not a proposal and not a template,
    // and it is here rather than in SHARED_TOOLS for a reason about *who is
    // reading*: a chat turn is a conversation with an operator at the keyboard,
    // so a task it filed is one somebody sees within the minute. A block's turn
    // has nobody watching, and a backlog it wrote to unattended is a board the
    // operator finds already full of an agent's own idea of the work.
    //
    // It cannot close anything, and the schema is where that is enforced twice:
    // there is no status field here, and `normalizeTaskInput` refuses one by
    // name if a model sends it anyway. Which actor may move a task to which
    // status is `taskTransitionRefusal` and nothing on this route may become a
    // second answer to it — see docs/agent/taskboard.md.
    name: "create_task",
    description:
      "Write something down on the operator's board. It starts nothing, " +
      "claims no folder and costs nothing: a task is a brief somebody — the " +
      "operator, a later run — picks up as a separate decision. Use it for " +
      "work worth doing that this conversation is not proposing now: the " +
      "thing found while looking at something else, the follow-up a proposal " +
      "leaves behind. It files a task as open and can do nothing else to one: " +
      "it cannot mark a task done, claimed or dropped, and closing work is " +
      "the operator's press or the run that did it. If a task should be " +
      "closed, say so and let them.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short specific label, e.g. 'Fix flaky auth test'.",
        },
        body: {
          type: "string",
          description:
            "The brief: what to do, where, and what done looks like. Written " +
            "for somebody with nothing else to go on — this may be handed to " +
            "an agent months from now with none of this conversation.",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Omit for normal.",
        },
        mountId: {
          type: "string",
          description:
            "The mount this is filed against, exactly as list_folders gives " +
            "it. Send folder with it.",
        },
        folder: {
          type: "string",
          description:
            "The folder within that mount. Needs mountId beside it. File it " +
            "against a project wherever you know one — a task nobody can " +
            "place is one nobody picks up.",
        },
        parentTaskId: {
          type: "string",
          description: "An id from list_tasks this is filed under.",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    // Beside `create_task` and here for its reason: a chat turn has an operator
    // at the keyboard, so a note it wrote is one somebody sees within the
    // minute. A block is refused this for the same reason it is refused
    // `create_task` — see `subjectRefusal`.
    //
    // It is the way a chat says something about a task without replacing it. The
    // description says what it cannot do because the alternative is a model
    // reading the one write beside `create_task` as a way around
    // `taskTransitionRefusal`: this cannot close, claim, drop or re-prioritise
    // anything, and it does not even mark the task as moved.
    name: "comment_on_task",
    description:
      "Write a note on a task already on the board: what you found out about " +
      "it, why it is harder than it reads, the decision this conversation took " +
      "about it. It moves nothing — it cannot mark a task done, claimed or " +
      "dropped, cannot change its priority and does not count as the task " +
      "being touched. Use it for something worth saying about an existing " +
      "brief; if it is a new piece of work, call create_task. Notes are " +
      "permanent and cannot be edited or deleted, and yours is recorded as the " +
      "chat's rather than the operator's.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "An id from list_tasks or get_task.",
        },
        body: {
          type: "string",
          description:
            "What you have to say, written for somebody with none of this " +
            "conversation: name files, ids and decisions rather than 'the " +
            "thing above'.",
        },
      },
      required: ["taskId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "list_proposals",
    description:
      "The proposals already made in this conversation and what became of " +
      "them, so the same work is not proposed twice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_template",
    description:
      "Save a reusable task prompt as a template, or rewrite an existing " +
      "one's. It writes three things and no fourth: the name, the prompt, and " +
      "the model runs from it start on. The guards — budget, work-cycle " +
      "limit, permission mode, whether the run gets its own checkout — are " +
      "the operator's default set on a new template and are left exactly as " +
      "they are on an existing one, and nothing on this tool can change them. " +
      "The model is not one of them: it decides what a run costs and never " +
      "what it may do.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description: "Omit to create. Given, rewrites that template.",
        },
        name: {
          type: "string",
          description: "Required when creating. Must be unique.",
        },
        prompt: {
          type: "string",
          description:
            "The standing instructions every run from this template starts " +
            "with. The per-run task is appended below it.",
        },
        model: {
          type: "string",
          description:
            "The model runs from this template start on. Pick one of the " +
            "listed ids, or \"inherit\". Omit it and an existing template " +
            "keeps whatever model it already names while a new one names " +
            "none and falls back to the operator's default — which is the " +
            "right answer unless the operator asked for a model or the work " +
            "is plainly cheap or plainly hard. Send \"\" or \"inherit\" to " +
            "clear one. It moves what runs from this template cost and never " +
            "what they may do.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    // The description below is the whole of what the model is told about
    // asking, and it is long for `systemPrompt()`'s stated reason: the
    // tool-calling half of the orchestrator's instructions lives here, where it
    // cannot drift from the schema, and is deliberately not repeated in the
    // prompt. The sentence that must never be cut is the second one. A model
    // that reads this as "returns the operator's answer" calls it, gets a
    // receipt, calls it again, and spends the turn's whole budget asking the
    // same question in a loop — which is what a tool that *could* block would
    // do to the silence bound anyway.
    name: "ask_operator",
    description:
      "Ask the operator something you cannot find out by reading, and end " +
      "your turn. This does NOT return their answer: it records the question, " +
      "and whatever the operator says next in this conversation is the answer " +
      "— it reaches you as their next message, with each question quoted above " +
      "the answer to it. So call it once, say in your " +
      "reply what you asked and why, and stop — calling it again or waiting " +
      "spends this turn and tells you nothing. Ask only what the repository " +
      "cannot tell you: which of two jobs matters more, what \"done\" means " +
      "here, whether a risk is acceptable, which of several folders they meant. " +
      "Never ask what a file, `git log`, `gh` or `list_folders` would answer, " +
      "and never ask for permission to propose — the operator approves every " +
      "proposal by hand already, so asking first costs a turn and changes " +
      "nothing. Put everything you need in this one call and keep it to a " +
      `couple of questions (at most ${MAX_OPEN_QUESTIONS}); each one costs the ` +
      "operator a read and costs you a whole turn. Offer concrete choices " +
      "whenever the answer is a choice, and say in your reply what you would " +
      "propose under each one — an operator picking between proposals answers " +
      "in one click, where an operator answering a quiz has to imagine what " +
      "you would do with it.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description:
            "The questions, in the order the operator should read them.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description:
                  "One question, in full. It is shown on its own, so it has " +
                  "to carry its own context: name the file, the run or the " +
                  "folder it is about rather than saying \"the second one\".",
              },
              choices: {
                type: "array",
                items: { type: "string" },
                description:
                  "Concrete answers to pick from, two or more, each short " +
                  "enough to read on a button. Omit for a question with no " +
                  "shortlist. Do not put \"something else\" in here — that is " +
                  "allowText.",
              },
              allowText: {
                type: "boolean",
                description:
                  "Whether the operator may type instead of picking. True by " +
                  "default. Set it false only when an answer outside the " +
                  "choices would be meaningless to you, because a question " +
                  "nobody can answer in their own words is one they will " +
                  "answer by ignoring.",
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_run",
    description:
      "Propose one run for the operator to approve. This does NOT start " +
      "anything: it records a proposal that a person approves or rejects by " +
      "hand. Guards come from the template — or from the operator's default " +
      "guard set when no template is named — and cannot be set here. The " +
      "model can be, and is not one of them: it moves what the run costs and " +
      "never what it may do.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description:
            "id from list_templates. Omit to use the operator's default " +
            "guard set, which is the right choice for one-off work.",
        },
        taskId: {
          type: "string",
          description:
            "id from list_tasks: the task on the board this run is for. It " +
            "is a record of what prompted the run and changes nothing about " +
            "it — no guard, no folder, no prompt — so name it whenever the " +
            "work is on the board and leave it out otherwise. It also does " +
            "nothing to the task: approving this does not claim it and the " +
            "run finishing does not close it. An id that is not on the board " +
            "is refused rather than ignored.",
        },
        promptOverride: {
          type: "string",
          description:
            "Standing instructions replacing the template's own prompt, for " +
            "this run only. Use when the template nearly fits. It does not " +
            "replace the task, which is still required and is still appended " +
            "below it — and because it is standing text rather than this " +
            "run's brief, a batch of related proposals normally carries the " +
            "same override word for word.",
        },
        agentId: {
          type: "string",
          description:
            "id from list_agents: the saved agent this run is STARTED AS, so " +
            "the agent's prompt becomes the run's own. Name one when the " +
            "operator writes @something in their message, or when a saved " +
            "agent plainly fits the whole job. It changes who the run is and " +
            "never what the run may do — the guards are still the template's, " +
            "or the default set. Omit it for the ordinary run.",
        },
        model: {
          type: "string",
          description:
            "The model this run is started on. Pick one of the listed ids, " +
            "or \"inherit\". Omit it and the run takes the template's model, " +
            "or the operator's default when the template names none — which " +
            "is the right answer unless the operator asked for a model or " +
            "the job is plainly cheap or plainly hard. It moves what the run " +
            "COSTS and never what it may do, so it is not a way to widen " +
            "anything: the budget, the work-cycle limit, the permission mode " +
            "and the isolation choice are unaffected and are still not " +
            "settable here. The list is the operator's own — anything not on " +
            "it is refused, because an id this machine does not have is a " +
            "run that fails when it starts.",
        },
        title: {
          type: "string",
          description: "Short specific label, e.g. 'Fix #412 flaky auth test'.",
        },
        task: {
          type: "string",
          description:
            "The full brief for the agent: what to do, the issue number and " +
            "URL if there is one, and what done looks like.",
        },
        mountId: {
          type: "string",
          description:
            "Mount from list_folders. Omit to use the template's own folder.",
        },
        folder: {
          type: "string",
          description:
            "Path within the mount, exactly as list_folders gives it. Required " +
            "when mountId is given; \"\" means the mount root.",
        },
        id: {
          type: "string",
          description:
            "Your own label for this proposal, so another one can say it runs " +
            "after it. Only needed when something depends on this. Letters, " +
            "digits, hyphens, underscores; unique among this chat's undecided " +
            "proposals.",
        },
        dependsOn: {
          type: "array",
          description:
            "Proposals this one starts after — by the id you gave them, in " +
            "this chat. Use it when two runs would edit the same files, or " +
            "when one reviews or builds on another. Both must be approved in " +
            "the same click, or the earlier one must already have started.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "The id you gave another proposal in this chat.",
              },
              edge: {
                type: "string",
                enum: ["on-success", "on-finish"],
                description:
                  "There is no default: pick the one you mean. on-success " +
                  "starts only if that run completed — which ends a chain " +
                  "the operator meant to run regardless. on-finish starts " +
                  "once it is out of the way either way — including after " +
                  "it crashed, so anything it left half-done is what this " +
                  "run opens on. Use on-finish for work that is worth doing " +
                  "whether or not the first run got there, and on-success " +
                  "for work that reads, reviews or builds on what the first " +
                  "run produced.",
              },
              continueBranch: {
                type: "boolean",
                description:
                  "Carry on that run's branch instead of cutting a fresh one, " +
                  "so this agent starts with its commits already there. " +
                  "Prefer it with an on-success edge: on an on-finish edge " +
                  "the commits already there may be half of a run that " +
                  "crashed. It needs both runs in a checkout of their own, " +
                  "which is a guard you do not set — check the template's " +
                  "isolation, or the default guard set's, in list_templates " +
                  "before you set this. Only one proposal may continue any " +
                  "given run.",
              },
            },
            required: ["id", "edge"],
            additionalProperties: false,
          },
        },
        supersedes: {
          type: "string",
          description:
            "A proposal in this conversation that this one replaces — the id " +
            "you gave it, or the proposalId that came back when you made it. " +
            "Use it when a card you already wrote is still waiting and turned " +
            "out to be wrong: the old card is marked replaced, this one takes " +
            "its place, and the operator decides once instead of rejecting one " +
            "card and reading another. Give this one no id of its own and it " +
            "inherits the old one's, so anything already ordered behind that " +
            "label still is. It may name a workflow proposal as well as a run. " +
            "Only a proposal still waiting can be replaced: if the operator " +
            "approved or rejected it while you were writing this, the whole " +
            "call is refused and nothing is proposed — say what happened and " +
            "propose the correction as a new run if it is still worth doing.",
        },
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_workflow",
    description:
      "Propose a saved workflow — a re-runnable graph of blocks — for the " +
      "operator to approve. This starts NOTHING and creates no run: approving " +
      "it saves the workflow, and a person then presses Run on it. Use it for " +
      "work that repeats or has a shape worth keeping; use propose_run for a " +
      "one-off. Guards come from each block's template, or the operator's " +
      "default guard set, and cannot be set here. The workflow is saved with " +
      "no workflow-wide budget, which the operator adds before scheduling it.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "What the workflow is called. Must be unique.",
        },
        summary: {
          type: "string",
          description:
            "One line on what the graph does, shown on the approval card.",
        },
        blocks: {
          type: "array",
          description: "The blocks, in the order they make sense to read.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Your own label, unique in this graph; dependsOn names it. " +
                  "Letters, digits, hyphens, underscores.",
              },
              name: { type: "string", description: "What this step is called." },
              kind: {
                type: "string",
                enum: ["run", "orchestrator", "merge"],
                description:
                  "run (default) is a fixed task. orchestrator is a short turn " +
                  "that decides, when the workflow gets there, which runs to " +
                  "start next — they start with no approval, so it needs " +
                  "fanOut. merge lands the branches the blocks in front of it " +
                  "left, and takes no task, folder or template.",
              },
              templateId: {
                type: "string",
                description:
                  "id from list_templates, supplying every guard. Omit for the " +
                  "operator's default guard set.",
              },
              mountId: {
                type: "string",
                description: "Mount from list_folders. Omit on a merge block.",
              },
              folder: {
                type: "string",
                description:
                  "Path within the mount, exactly as list_folders gives it. " +
                  "\"\" is the mount root. Omit on a merge block.",
              },
              task: {
                type: "string",
                description:
                  "A run block's brief, or an orchestrator block's brief for " +
                  "what to decide. Omit on a merge block.",
              },
              promptOverride: {
                type: "string",
                description:
                  "Standing instructions replacing the template's prompt for " +
                  "this block. The task is appended below it.",
              },
              agentId: {
                type: "string",
                description:
                  "id from list_agents: the saved agent this block's own child " +
                  "is STARTED AS. It changes who that child is and never what " +
                  "the block may do. Refused on a merge block, which starts no " +
                  "child at all, so there would be nothing for the agent to be.",
              },
              fanOut: {
                type: "number",
                description:
                  "Required on an orchestrator block: the most runs it may " +
                  "ever start. Its runs start with nobody looking, so this is " +
                  "the number the operator is agreeing to. Ignored on any " +
                  "other kind.",
              },
              mergeStrategy: {
                type: "string",
                enum: ["merge", "squash"],
                description: "Required on a merge block, ignored on any other.",
              },
              mergeAutoResolve: {
                type: "boolean",
                description:
                  "Let a merge block pay a model to reconcile a conflict. " +
                  "Costs money on its own, so leave it out unless asked.",
              },
              dependsOn: {
                type: "array",
                description: "Blocks in this graph that must settle first.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "An id from this graph." },
                    edge: {
                      type: "string",
                      enum: ["on-success", "on-finish"],
                      description:
                        "on-success starts only if that block completed; " +
                        "on-finish starts once it is out of the way.",
                    },
                    continueBranch: {
                      type: "boolean",
                      description:
                        "Carry on that block's branch rather than cutting a " +
                        "fresh one. Both ends must be run blocks whose guards " +
                        "give them a checkout of their own.",
                    },
                  },
                  required: ["id", "edge"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "name"],
            additionalProperties: false,
          },
        },
        supersedes: {
          type: "string",
          description:
            "A proposal in this conversation that this one replaces — the id " +
            "you gave it, or the proposalId that came back. Use it to correct " +
            "a graph that is still waiting rather than leaving two cards for " +
            "one job. It may name a run proposal as well as a workflow. Only a " +
            "proposal still waiting can be replaced: if the operator decided it " +
            "while you were writing this, the whole call is refused and nothing " +
            "is proposed.",
        },
      },
      required: ["name", "blocks"],
      additionalProperties: false,
    },
  },
];

/**
 * The one tool an orchestrator block gets that writes anything.
 *
 * Five fields per run and no sixth. There is no template id, no budget, no
 * permission mode, no isolation choice and no model on this schema, and their
 * absence is the whole reason auto-start is defensible: the block's guards were
 * chosen by a person when the graph was saved, and a field here that could name
 * different ones would be a route to `--permission-mode` reached by a model with
 * nobody reading the result. The description says so outright, because a model
 * that believes it can set guards writes a task explaining what guards it wants.
 *
 * The fifth is `agent`, and it is on the other side of that line rather than an
 * exception to it: a saved agent is a description and a prompt, the registry
 * refuses a tool list at the door and has no column for a permission mode, so
 * naming one decides *who the run is* exactly as the task text beside it decides
 * what the work is. `planEmission` refuses a name this install does not have,
 * for the reason every other door refuses a deleted agent by name — and since
 * `--agent` takes a name, a misspelling let through here would be a run that
 * fails at the spawn rather than one that quietly starts as nobody.
 */
const BLOCK_TOOLS = [
  {
    name: "emit_runs",
    description:
      "Start these runs. This is NOT a proposal: what you emit is created and " +
      "queued as soon as this turn ends, with no approval step. Guards — " +
      "budget, work-cycle limit, permission mode, isolation — come from the " +
      "block's own template and cannot be set here. Call it once, with the " +
      "whole list; an empty list is a valid answer meaning there is nothing " +
      "worth doing.",
    inputSchema: {
      type: "object",
      properties: {
        runs: {
          type: "array",
          description: "The runs to start, at most this block's fan-out limit.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Your own label for this run, unique in this list. dependsOn " +
                  "entries name it. Letters, digits, hyphens, underscores.",
              },
              title: {
                type: "string",
                description: "Short specific label, e.g. 'Fix flaky auth test'.",
              },
              task: {
                type: "string",
                description:
                  "The full brief for the agent: what to do, where, and what " +
                  "done looks like. It cannot ask you a follow-up question.",
              },
              taskId: {
                type: "string",
                description:
                  "id from list_tasks: the task on the board this run is " +
                  "for. A record of what prompted it and nothing more — it " +
                  "sets no guard, picks no folder and does not change the " +
                  "brief above. It also moves nothing on the board: emitting " +
                  "this does not claim the task and the run ending does not " +
                  "close it. An id that is not on the board is refused by " +
                  "name and the whole emission is refused with it.",
              },
              folder: {
                type: "string",
                description:
                  "Path within this block's own workspace, exactly as " +
                  "list_folders gives it. A folder outside it is refused. " +
                  "\"\" is the workspace root.",
              },
              agent: {
                type: "string",
                description:
                  "Optional: the name of a saved agent to START THIS RUN AS, " +
                  "exactly as your instructions list it — the agent's prompt " +
                  "becomes that run's own. It changes who the run is and never " +
                  "what the run may do; the guards are still the block's. A " +
                  "name this install does not have is refused; omit it for the " +
                  "ordinary run.",
              },
              dependsOn: {
                type: "array",
                description:
                  "Runs in THIS list that must settle first. Use it when two " +
                  "of them would edit the same files.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "An id from this list." },
                    edge: {
                      type: "string",
                      enum: ["on-success", "on-finish"],
                      description:
                        "on-success starts only if that run completed; " +
                        "on-finish starts once it is out of the way.",
                    },
                  },
                  required: ["id", "edge"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "title", "task", "folder"],
            additionalProperties: false,
          },
        },
      },
      required: ["runs"],
      additionalProperties: false,
    },
  },
];

/**
 * What this caller may see and call. See the note at the top of the file.
 *
 * A work cycle gets `RUN_TOOLS` and **not** `SHARED_TOOLS`, which is the one
 * asymmetry here: the two orchestrator subjects are deciding what work to start
 * and need to see the install to do it, where a run is already doing one piece
 * of work in one folder. `RUN_TOOLS`' docblock carries what that leaves out.
 */
/**
 * What `complete_task` says when a claim is checked before it is honoured.
 *
 * Swapped in rather than appended to the constant, so an install with the check
 * off sends the byte-identical description it always did — the appended
 * prompt's price rule one surface along, for the same reason: a cached prefix
 * that gains a sentence about a feature that is not on is paid for by every
 * cycle of every run.
 *
 * It states the mechanism and not a promise about the answer. The last two
 * sentences are the ones that earn their tokens: commit before calling, because
 * the branch is what gets read and uncommitted work is invisible to it, and
 * there is nothing to poll — a model told "this is being checked" and not told
 * to stop looking will call `list_my_tasks` in a loop until its budget runs out.
 */
const CHECKED_COMPLETE_TASK =
  "Mark a task this run holds as done. You can complete only a task already " +
  "recorded against this run — the one list_my_tasks returns as held — and " +
  "naming any other is refused. Call it when the work the task asked for is " +
  "actually finished, not when you have decided to stop. What you have " +
  "committed to this run's branch is then read against what the task asks " +
  "for, and the task closes only if that reading finds the work there; if " +
  "something is missing you will be told what, in your next turn, and the " +
  "task stays yours. So commit your work before you call this — anything " +
  "uncommitted is not on the branch and cannot be seen. Do not call this " +
  "again to find out what happened, and do not wait for it. If you could not " +
  "finish the task, leave it and say why in your reply.";

function toolsFor(subject: CapabilitySubject) {
  if (subject.kind === "run") {
    return getSettings().validateTaskCompletion
      ? RUN_TOOLS.map((tool) =>
          tool.name === "complete_task"
            ? { ...tool, description: CHECKED_COMPLETE_TASK }
            : tool,
        )
      : [...RUN_TOOLS];
  }
  return subject.kind === "chat"
    ? [...SHARED_TOOLS, ...CHAT_TOOLS]
    : [...SHARED_TOOLS, ...BLOCK_TOOLS];
}

/** The shape `withModelChoices` needs, which every tool above satisfies. */
type ToolSpec = {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
};

/**
 * A `model` argument as "named none" or a name.
 *
 * `"inherit"` is the sentinel both tool descriptions have always offered and
 * neither handler had ever read: `String("inherit").trim() || null` is the
 * string, so a model that followed the instruction got `--model inherit` on the
 * argv and a spawn the CLI refuses. Now that the enum publishes the value there
 * is one place it stops being one.
 */
function modelArgument(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return !value || value === "inherit" ? null : value;
}

/**
 * The enabled model ids onto the schema of every tool that takes one.
 *
 * Injected at `tools/list` rather than written into the static schemas above,
 * because the list is the operator's and moves without a deploy. It is an
 * `enum` rather than a longer sentence for the reason the sentence failed: a
 * `model` described only in prose left the orchestrator picking an id out of
 * memory, and an id this machine does not have is a run that dies at its first
 * spawn. A schema a model cannot read wrong beats a description it can.
 *
 * `"inherit"` leads the list. It is the only member that is not an id, means
 * exactly what omitting the argument means, and is what the handlers turn back
 * into "named none" — a plain `--model inherit` is a spawn the CLI refuses.
 *
 * An empty catalogue injects nothing: with no list there is nothing to refuse,
 * and an enum holding only `"inherit"` would say the opposite in the one place
 * a model is most likely to believe it.
 */
function withModelChoices(tools: ToolSpec[], enabledIds: string[]): ToolSpec[] {
  if (enabledIds.length === 0) return tools;
  return tools.map((tool) => {
    const model = tool.inputSchema.properties.model;
    if (model === undefined) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          model: { ...(model as object), enum: ["inherit", ...enabledIds] },
        },
      },
    };
  });
}

/**
 * Why this subject may not call this tool.
 *
 * Every sentence names something the caller *can* do instead, `agentRefusal`'s
 * rule, because a model told only "no" reaches for the next tool on the list.
 * Split out from `callTool` so the check there can be one exhaustive membership
 * test against `toolsFor` rather than a pair of hand-maintained lists — the
 * shape that let a run subject, added later, fall through both of them.
 */
function subjectRefusal(subject: CapabilitySubject, name: string): string {
  if (subject.kind === "block") {
    // `ask_operator` is the one of these with no alternative to name, and
    // pointing a block at `emit_runs` would be worse than saying nothing: a
    // block that wanted an answer would emit a run whose task is the question.
    // A block runs with nobody looking, which is the whole difference between
    // it and a chat — what it does with an unanswerable question is decide.
    if (name === "ask_operator") {
      return (
        "ask_operator is not available to an orchestrator block: there is " +
        "nobody watching this workflow to answer. Decide with what you can " +
        "read, and say what you assumed in your reply."
      );
    }
    // `create_task` needs its own sentence for `ask_operator`'s reason rather
    // than its own: pointing a block at `emit_runs` would answer a request to
    // *write something down for later* with the one tool that starts work now,
    // which is the opposite of what was asked. The board stays readable from
    // here, and naming that is what stops a block reading this as "the taskboard
    // is not yours".
    if (name === "create_task") {
      return (
        "create_task is not available to an orchestrator block: nobody is " +
        "watching this workflow, and a backlog written unattended is one the " +
        "operator meets already full. You can read the board with list_tasks " +
        "and name a task on a run you emit; filing a new one belongs to a chat " +
        "turn or the operator."
      );
    }
    // `create_task`'s refusal one field along, and refused on its own ground
    // rather than by omission: a note is permanent, it is attributed, and a
    // block's turn is unattended, so a thread it wrote to is one the operator
    // meets already answered by something nobody was reading. Naming what a
    // block *can* still do with the board is what stops this reading as "the
    // taskboard is not yours".
    if (name === "comment_on_task") {
      return (
        "comment_on_task is not available to an orchestrator block: a note is " +
        "permanent and cannot be edited or deleted, and nobody is watching " +
        "this workflow to read one written unattended. You can read the board " +
        "with list_tasks and get_task, and name a task on a run you emit — the " +
        "run that does the work can write on it."
      );
    }
    return `${name} is not available to an orchestrator block. Use emit_runs.`;
  }

  if (subject.kind === "chat") {
    return (
      `${name} is not available in a chat. Use propose_run, which the operator ` +
      "approves before anything starts."
    );
  }

  // A work cycle, and the sentence has to do two things at once: refuse, and
  // stop the model concluding that the thing it wanted is impossible here. Both
  // of the tools it is most likely to reach for have a real answer — write it
  // down, or say it in the reply that the operator reads — and neither is
  // "start something", which is the reading this surface must never leave.
  if (name === "list_tasks" || name === "get_task") {
    return (
      `${name} is not available to a work cycle: a run sees the task it holds ` +
      "and what is open in the folder it is working in, not the whole board. " +
      "Call list_my_tasks."
    );
  }
  return (
    `${name} is not available to a work cycle. A run can list the tasks it ` +
    "holds, complete one of those, write a note on one and file a new one — it " +
    "cannot start work, approve anything or touch another run. Anything else " +
    "belongs in your reply, which the operator reads."
  );
}

/**
 * The capability check, and why it stands outside the audited handler.
 *
 * `middleware.ts` exempts this path from the shared-secret gate, so a request
 * reaching here has passed nothing yet — this check *is* the authentication for
 * the whole tool surface, and every answer other than the 401 below is given
 * with a subject in hand. What it must not do is answer that 401 from inside
 * `auditMutation`: the wrapper records every request it wraps and then evicts
 * everything past the 20,000-row cap, so auditing a credential-free refusal
 * hands any caller who can reach this path a lever on the audit table itself —
 * twenty thousand correctly-refused requests, and every line naming a run that
 * was started, a setting that was changed or a sign-in that failed is gone.
 *
 * Only the handler that already has a subject is wrapped, which keeps the case
 * the table exists for: a real capability whose tool call is refused — a
 * deleted template, a folder it may not have — still leaves a line, because
 * that is the burst somebody comes looking for afterwards.
 */
export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const subject = subjectForCapability(bearer);
  if (!subject) {
    // On stdout rather than in `request_log`, which is the whole point: the
    // table is capped and evicts its oldest line on every insert, so the one
    // record a credential-free caller may write must be the one they cannot
    // use to push anything out. Leaving no trace at all was not an option
    // either — this is the path an unauthenticated caller reaches, so somebody
    // hammering it is exactly what an operator needs to be able to see.
    opsLog("warn", "mcp.unauthorized", { address: sourceAddress(req.headers) });
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  return auditMutation((request: Request) => postHandler(request, subject))(req);
}

async function postHandler(req: Request, subject: CapabilitySubject) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // A batch is legal on the wire even though the CLI does not send one.
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of batch) {
    const reply = await handle(msg, subject);
    if (reply) replies.push(reply);
  }

  // Every message was a notification. 202 with no body is what the transport
  // asks for, and answering `{}` instead makes some clients wait for a result
  // that is never coming.
  if (replies.length === 0) return new Response(null, { status: 202 });

  return NextResponse.json(Array.isArray(body) ? replies : replies[0]);
}

/**
 * The transport's other verbs. Neither is needed: there is no server stream.
 *
 * Neither is audited, and DELETE is the one that used to be: a 405 answered
 * without reading the request mutates nothing, so it has nothing to tell an
 * audit — and since it is answered before any credential is looked at, the row
 * it wrote was a free line against the 20,000-row cap for anybody who could
 * reach this path.
 */
export async function GET() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "No server stream" } },
    { status: 405 },
  );
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}

async function handle(
  msg: JsonRpcRequest,
  subject: CapabilitySubject,
): Promise<object | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");

  // A notification has no id and takes no reply, whatever it asks for —
  // `notifications/initialized` is the one the CLI actually sends.
  if (msg.id === undefined || msg.id === null) return null;

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize": {
      // Echo a protocol version the client asked for when we recognise its
      // shape, rather than insisting on ours: this file speaks a subset that
      // has not changed across these revisions, and refusing a newer client
      // over a version string would break the feature on a CLI bump.
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "usagefoundry", version: "0.1.0" },
      });
    }

    case "ping":
      return ok({});

    case "tools/list":
      return ok({
        tools: withModelChoices(
          toolsFor(subject),
          enabledModels(getSettings().modelCatalogue).map((entry) => entry.id),
        ),
      });

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(await callTool(name, args, subject));
      } catch (err) {
        // A tool that throws is reported as tool output, not as a protocol
        // error: the model can read and act on the former and only sees a
        // dropped turn from the latter.
        return ok(text(`Error: ${err instanceof Error ? err.message : String(err)}`, true));
      }
    }

    default:
      return fail(-32601, `Unknown method: ${method}`);
  }
}

function text(body: string, isError = false) {
  return { content: [{ type: "text", text: body }], isError };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  subject: CapabilitySubject,
) {
  // Checked here as well as in `toolsFor`, because a list is what a caller is
  // *offered* and this is what it may *do*. A chat that has read a block's
  // schema from somewhere must still not be able to start runs, a block must
  // not be able to write a proposal into a stranger's thread, and a work cycle
  // must reach neither.
  //
  // **One membership test against the same list `tools/list` published**, rather
  // than a refusal per pair of subjects. The pairwise shape it replaces was
  // correct for two subjects and quietly wrong for three: it keyed everything on
  // "is this a chat", so a work cycle asking for a chat tool was told it was an
  // orchestrator block, and a work cycle asking for a *block* tool passed the
  // guard entirely and reached the switch below. Deriving the gate from
  // `toolsFor` is what makes a fourth subject safe by construction.
  //
  // A name in *no* list falls through to the switch's "Unknown tool" instead of
  // being refused as somebody else's: a model that mistyped a tool needs to know
  // it does not exist, not that it belongs to a subject it has never heard of.
  const knownSomewhere = [
    ...SHARED_TOOLS,
    ...CHAT_TOOLS,
    ...BLOCK_TOOLS,
    ...RUN_TOOLS,
  ].some((t) => t.name === name);
  if (knownSomewhere && !toolsFor(subject).some((t) => t.name === name)) {
    return text(subjectRefusal(subject, name), true);
  }
  const chatId = subject.kind === "chat" ? subject.chatId : null;

  switch (name) {
    case "list_folders": {
      const { mounts, folders } = await scanWorkspace();
      // Narrowed at the boundary rather than passed through: these arrive off a
      // model's tool call, so a `folders` holding a number is a thing that
      // happens and must not become a key that matches nothing in silence.
      const lookup = await githubRemotes(folders, {
        folders: Array.isArray(args.folders)
          ? args.folders.filter((f): f is string => typeof f === "string")
          : null,
        offset: Number(args.offset) || 0,
      });
      const looked = new Set(lookup.read);
      const nextOffset = lookup.offset + lookup.read.length;
      return text(
        JSON.stringify(
          {
            mounts: mounts.map((m) => ({
              mountId: m.id,
              label: m.label,
              // The absolute path, because `Read`, `Grep` and `git log` all
              // need one to reach a mount that is not the child's cwd — and
              // every mount is already `--add-dir`ed into this child, so
              // naming it grants nothing that was not already granted.
              path: m.path,
              available: m.available,
              error: m.error,
              truncated: m.truncated,
            })),
            folders: folders.map((f) => ({
              mountId: f.mountId,
              folder: f.path,
              isGitRepo: f.isGitRepo,
              repo: lookup.repos[folderKey(f)] ?? null,
              // Said on the folder rather than left to be inferred, for the
              // reason a shortened diff says it is shortened: a missing `repo`
              // that means "not looked at" and one that means "not GitHub" are
              // different sentences, and only the total used to distinguish
              // them. A count tells a model how many folders it is missing and
              // never which — and the folder it is missing is the one it then
              // reports to the operator as a repository it cannot identify.
              ...(f.isGitRepo && !looked.has(folderKey(f))
                ? { repoUnread: true }
                : {}),
              busyRunId: f.busyRunId,
              parkedRunId: f.parkedRunId,
              queuedCount: f.queuedCount,
            })),
            repoLookups: {
              gitRepos: lookup.gitRepos,
              matching: lookup.matching,
              read: lookup.read.length,
              offset: lookup.offset,
              notRead: lookup.notRead,
              // The offset that reaches what this call left out, or null when
              // it left out nothing after it. Handed over as a number the next
              // call can pass back, because a cap a caller cannot get past is
              // indistinguishable from a workspace that stops there.
              nextOffset: nextOffset < lookup.matching ? nextOffset : null,
              // A key that named no folder is reported rather than dropped: it
              // is the one case where reading nothing is a typo and not an
              // answer, and it would otherwise render as "not a repository".
              ...(lookup.unmatched.length
                ? { unmatched: lookup.unmatched }
                : {}),
            },
          },
          null,
          1,
        ),
      );
    }

    case "list_templates": {
      // The default guard set is reported alongside, because it is what a
      // proposal naming no template runs under — a model shown only the
      // templates would read an empty list as "nothing can be proposed", which
      // is what this tool used to say and no longer true.
      return text(
        JSON.stringify(
          {
            templates: listTemplates().map((t) => ({
              templateId: t.id,
              name: t.name,
              prompt: t.prompt,
              mountId: t.mountId,
              folder: t.folder,
              isolate: t.isolate,
              permissionMode: t.permissionMode,
              budget: t.budget,
            })),
            guardsWhenNoTemplateNamed: chatGuards(),
          },
          null,
          1,
        ),
      );
    }

    case "list_agents": {
      // Both handles, each named for the caller that takes it: the chat's
      // proposal tools take an `agentId` like every other identifier they
      // speak in, and `emit_runs` takes the `name`, because a block's turn
      // names the agent a run it is creating will be started as — and a name is
      // both the key `--agents` uses and the word `--agent` takes. Reporting
      // only one would leave whichever caller wanted the other guessing at it.
      //
      // `usable: false` is reported rather than the row being hidden, because
      // the two failures read alike from here and only one of them is the
      // operator's to fix: an agent missing its description or its prompt is
      // one the CLI will not register, so a run started as it dies at the
      // spawn. Every door refuses it by name.
      return text(
        JSON.stringify(
          {
            agents: listAgents().map((a) => ({
              agentId: a.id,
              name: a.name,
              description: a.description,
              model: a.model,
              usable: a.usable,
            })),
            // Declared rather than merged into the list above: these reach
            // every child this app spawns whatever is named here, and they
            // cannot be named — they have no row and so no id. A model that
            // saw one list would offer the operator an agent nothing can
            // select.
            alsoOnThisMachine: listAmbientAgents().map((a) => ({
              name: a.name,
              description: a.description,
              scope: a.scope,
            })),
            note:
              "Naming an agent starts the run AS that agent — its prompt " +
              "becomes the run's own — and sets no guard. Budget, work-cycle " +
              "limit, permission mode and isolation all come from the template " +
              "a proposal or block names, or from the operator's default guard " +
              "set. The agents under alsoOnThisMachine are in play for every " +
              "run whether or not one is named, and cannot be named here.",
          },
          null,
          1,
        ),
      );
    }

    case "list_runs": {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return text(
        JSON.stringify(
          listRuns(limit).map((r) => {
            const { mountId, relPath } = describeFolder(r.folder);
            return {
              runId: r.id,
              status: r.status,
              mountId,
              folder: relPath,
              branch: r.worktree_branch,
              iterations: r.iterations,
              // `null`, not `"$0.00"`, for a provider that reports no cost:
              // this answer is read by a model, which will reason from a
              // number far more readily than a person skims one. JSON null is
              // the shape this file already uses for a field with no reading.
              spent: providerRecordsSpend(r.provider) ? fmtUSD(r.spent_usd) : null,
              stopReason: r.stop_reason,
              task: r.prompt.slice(0, 200),
            };
          }),
          null,
          1,
        ),
      );
    }

    case "get_run":
      return getRunDetail(args);

    case "get_run_diff":
      return getRunPatch(args, subject);

    case "get_usage":
      return usageReport();

    case "list_workflows":
      return workflowReport();

    case "list_proposals": {
      const proposals = listProposals(chatId!);
      if (proposals.length === 0) {
        return text("Nothing has been proposed in this conversation yet.");
      }
      // The replaced-by link, read backwards. Both directions are reported
      // because the model reads this list to decide what is left to do, and
      // one direction alone answers half of that: `supersededBy` says a card
      // it wrote is no longer the live one, and `supersedes` says the card in
      // front of it already *is* the correction — without which the ordinary
      // reading of a `superseded` row is "that work never happened", and the
      // work gets proposed a third time.
      const replaced = new Map(
        proposals.flatMap((p) => (p.superseded_by ? [[p.superseded_by, p.id]] : [])),
      );
      return text(
        JSON.stringify(
          proposals.map((p) => ({
            proposalId: p.id,
            // The chat's own label, which is what a dependsOn names — reported
            // back because a turn that resumes a conversation has the thread
            // but not necessarily the labels it used two turns ago.
            id: p.spec_id,
            kind: p.kind,
            title: p.title,
            status: p.status,
            templateId: p.template_id,
            runId: p.run_id,
            workflowId: p.workflow_id,
            dependsOn: proposalDeps(p).map((d) => `${d.specId} (${d.edge})`),
            // By proposalId in both directions, never by label: a replacement
            // usually inherits the one it replaced, so a label here would name
            // both rows and say nothing about which is which.
            supersededBy: p.superseded_by,
            supersedes: replaced.get(p.id) ?? null,
            error: p.error,
            task: p.task.slice(0, 200),
          })),
          null,
          1,
        ),
      );
    }

    case "list_tasks":
      return listTasksTool(args);

    case "get_task":
      return getTaskTool(args);

    // Shared by name between a chat and a work cycle and by nothing else: the
    // two schemas differ, the two origins differ, and what a run files is placed
    // and parented from the token rather than from the call. Narrowed rather
    // than asserted, `emit_runs`' rule — `subject.kind` is what decides.
    case "create_task":
      return subject.kind === "run"
        ? createTaskForRun(args, subject.runId)
        : createTaskTool(args, chatId!);

    // Shared by name between a chat and a work cycle, and the only difference
    // between the two callers is the author the row records — which is taken
    // from the subject here and can be taken from nowhere else. `block` never
    // reaches this line: the gate above refuses a tool that is not on its list.
    case "comment_on_task":
      return subject.kind === "run"
        ? commentOnTask(args, { kind: "run", runId: subject.runId })
        : commentOnTask(args, { kind: "chat" }, chatId!);

    // Narrowed rather than asserted, for `emit_runs`' reason: the gate above
    // proves the tool is on this subject's list, and the union is what makes the
    // run id unmixable with a chat id or an instance id. The run id these two
    // act on comes from here and from nowhere else — no argument supplies one.
    case "list_my_tasks":
    case "complete_task": {
      if (subject.kind !== "run") return text(subjectRefusal(subject, name), true);
      return name === "list_my_tasks"
        ? listMyTasks(subject.runId)
        : await completeTaskForRun(args, subject.runId);
    }

    case "ask_operator":
      return askOperator(args, chatId!);

    case "save_template":
      return saveTemplate(args, chatId!);

    case "propose_run":
      return proposeRun(args, chatId!);

    case "propose_workflow":
      return proposeWorkflow(args, chatId!);

    case "emit_runs": {
      // Narrowed rather than asserted: `subject.kind` is what decides, and the
      // union is what makes the two ids unmixable.
      if (subject.kind !== "block") {
        return text("emit_runs is not available here.", true);
      }
      const outcome = emitBlockRuns(
        subject.instanceId,
        subject.nodeId,
        args.runs,
      );
      if (!outcome.ok) return text(outcome.reason, true);
      return text(
        outcome.accepted === 0
          ? "Recorded that there is nothing to start. No runs will be created, " +
            "and any block set to start after this one will be stopped rather " +
            "than run with nothing to work on."
          : `Accepted ${outcome.accepted} run(s). They are created and queued ` +
            "when this turn ends — there is no approval step. You cannot emit " +
            "again; say anything else you would have started in your reply.",
      );
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

/**
 * One run, as much as is worth reading in a tool result.
 *
 * The log is tailed rather than sent whole for the reason the run page tails
 * it: a run that worked for a day has tens of thousands of events, and a tool
 * result that large is spend with no information in it. `dropped` is reported
 * for the same reason a shortened diff says so.
 *
 * The diff is a *summary* here — file names and line counts — with the patch
 * itself behind `get_run_diff`. Splitting them is what keeps "what did this run
 * touch" cheap enough to ask about several runs in a row.
 */
async function getRunDetail(args: Record<string, unknown>) {
  const runId = String(args.runId ?? "").trim();
  const run = getRun(runId);
  if (!run) return text(`No run with id "${runId}". Call list_runs.`, true);

  const limit = Math.min(Math.max(Number(args.events) || 20, 1), 100);
  const { events, dropped } = runEvents(runId, 0, limit);
  const { mountId, relPath } = describeFolder(run.folder);
  const diff = await runDiff(runId);

  return text(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        mountId,
        folder: relPath,
        isolated: run.isolation === "worktree",
        branch: run.worktree_branch,
        baseBranch: run.worktree_base_branch,
        createdAt: new Date(run.created_at).toISOString(),
        iterations: run.iterations,
        // See `list_runs`: unknown is null here rather than a formatted zero.
        spent: providerRecordsSpend(run.provider) ? fmtUSD(run.spent_usd) : null,
        stopReason: run.stop_reason,
        landedAt: run.landed_at ? new Date(run.landed_at).toISOString() : null,
        task: run.prompt,
        changed: {
          kind: diff.kind,
          reason: diff.reason,
          filesChanged: diff.filesChanged,
          added: diff.added,
          deleted: diff.deleted,
          files: diff.files
            .slice(0, 50)
            .map((f) => `${f.status} ${f.path} (+${f.added ?? "?"} −${f.deleted ?? "?"})`),
          filesOmittedFromThisList: Math.max(0, diff.files.length - 50),
          caveat: diff.caveat,
        },
        recentLog: events.map((e) => ({
          at: new Date(e.ts).toISOString(),
          kind: e.kind,
          detail: clip(JSON.stringify(e.payload)),
        })),
        logEntriesOlderThanThese: dropped,
      },
      null,
      1,
    ),
  );
}

/**
 * One log entry's payload, bounded.
 *
 * An `assistant` event carries a whole model turn and a `tool` event carries a
 * tool's entire input, so a hundred of them unbounded is a tool result larger
 * than the conversation asking for it — and this is the one tool a model is
 * told to call repeatedly. Truncated with the size named rather than silently:
 * the same rule the diff follows.
 */
function clip(s: string, max = 600): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}… [${s.length - max} more characters]`;
}

/**
 * The patch, bounded — and saying so when it is, for `diffAsText`'s reason.
 *
 * Scoped to the caller's own runs, which is the one tool here that is. The
 * refusal names what to do instead rather than stopping at "no": a chat and a
 * block both have `--add-dir` on every mount, so the legitimate caller can read
 * the checkout itself, and a model told only that it may not is one that stops
 * looking. What the scope removes is the *stolen* token's reach — a work-cycle
 * agent is confined to the folder it was started in, and this was the one tool
 * that handed it source from every other repository. See `chatOwnsRun`.
 */
async function getRunPatch(
  args: Record<string, unknown>,
  subject: CapabilitySubject,
) {
  const runId = String(args.runId ?? "").trim();
  if (!getRun(runId)) return text(`No run with id "${runId}". Call list_runs.`, true);

  // Exhaustive over the union rather than "chat or else", which is what the
  // third subject makes worth writing out: a work cycle is never offered this
  // tool — `callTool`'s gate refuses it first — and `false` is the answer that
  // stays correct if one ever reached here, since another run's patch is exactly
  // what this surface must not hand it and its own is not something it needs a
  // tool to read.
  const mine =
    subject.kind === "chat"
      ? chatOwnsRun(subject.chatId, runId)
      : subject.kind === "block"
        ? instanceOwnsRun(subject.instanceId, runId)
        : false;
  if (!mine) {
    return text(
      `The patch for run ${runId} is not available here: ${
        subject.kind === "chat"
          ? "this conversation did not start that run"
          : subject.kind === "block"
            ? "that run is not part of this workflow instance"
            : "a work cycle does not read another run's work"
      }. get_run still reports its status, its spend, its log and the files it ` +
        "changed, and its folder is one you can read directly.",
      true,
    );
  }

  const diff = await runDiff(runId);
  if (diff.files.length === 0) {
    return text(diff.reason ?? "This run changed nothing.");
  }

  const { text: body, shown, truncated } = diffAsText(diff, MAX_DIFF_TEXT_BYTES);
  return text(
    `${shown} of ${diff.files.length} changed files, ` +
      `+${diff.added} −${diff.deleted}${truncated ? " (truncated)" : ""}` +
      `${diff.caveat ? `\n${diff.caveat}` : ""}\n${body}`,
  );
}

/**
 * The windows, as the dashboard reads them.
 *
 * `guardFraction` alongside `fraction` rather than instead of it: the guard
 * charges unpriced models a fallback rate and the display does not, so a chat
 * told only the displayed number would confidently say there is room in a
 * window that will refuse the next run. Both, named, is the honest answer.
 *
 * Every number here is for talking about *timing*. Nothing downstream reads it:
 * a proposal's guards come from a template or from settings, and `evaluateBudget`
 * re-reads the windows itself before every work cycle.
 */
async function usageReport() {
  const snapshot = await currentSnapshot();
  const active = activeRuns();

  const window = (w: typeof snapshot.session) => ({
    startsAt: new Date(w.startsAt).toISOString(),
    endsAt: new Date(w.endsAt).toISOString(),
    spent: fmtUSD(w.costUSD),
    ceiling: w.limit === null ? null : fmtUSD(w.limit),
    fraction: w.fraction,
    guardFraction: w.guardFraction,
  });

  return text(
    JSON.stringify(
      {
        now: new Date(snapshot.now).toISOString(),
        session: window(snapshot.session),
        weekly: window(snapshot.weekly),
        burnCostPerHour: fmtUSD(snapshot.burnCostPerHour),
        projectedExhaustionAt: snapshot.projectedExhaustionAt
          ? new Date(snapshot.projectedExhaustionAt).toISOString()
          : null,
        running: active.filter((r) => r.status === "running").length,
        queued: active.filter((r) => r.status === "queued").length,
        paused: active.filter((r) => r.status === "paused").length,
        // A null ceiling is not zero and not "unlimited" — it is a number
        // Anthropic does not publish and the operator has not supplied, so
        // every fraction above it is null too. Said outright, because a model
        // reading null as 0% would report a fresh window on a spent one.
        note:
          snapshot.session.limit === null || snapshot.weekly.limit === null
            ? "A null ceiling means the operator has set none for that window, " +
              "so its fraction is unknown rather than zero."
            : null,
      },
      null,
      1,
    ),
  );
}

/**
 * The saved workflows, as much of each as is worth reading before proposing.
 *
 * The blocks are summarised rather than dumped: a graph's node ids, prompt
 * overrides and edge conditions are what the editor needs and not what a
 * decision to propose a *new* one turns on. What that decision does turn on is
 * whether this work already has a workflow, whether one is running right now,
 * and — for a graph the chat is about to extend or imitate — which guard set
 * each step uses.
 *
 * `liveRuns`/`liveBlocks` are reported for `list_runs`' reason: work already in
 * flight is worth mentioning rather than duplicating.
 */
function workflowReport() {
  const workflows = listWorkflows();
  if (workflows.length === 0) {
    return text(
      "No workflows are saved. propose_workflow proposes one; the operator " +
        "approves it, which saves it, and then presses Run themselves.",
    );
  }
  return text(
    JSON.stringify(
      workflows.map((w) => {
        const last = lastRunAt(w.id);
        return {
          workflowId: w.id,
          name: w.name,
          lastRunAt: last === null ? null : new Date(last).toISOString(),
          liveRuns: liveRunsOf(w.id).length,
          liveBlocks: liveBlocksOf(w.id),
          instanceBudget: w.instanceBudget,
          blocks: w.graph.nodes.map((n) => ({
            id: n.id,
            name: n.name,
            kind: n.kind,
            templateId: n.templateId,
            mountId: n.mountId || null,
            folder: n.kind === "merge" ? null : n.folder,
            fanOut: n.fanOut,
            after: w.graph.edges
              .filter((e) => e.to === n.id)
              .map((e) => `${e.from} (${e.edge})`),
          })),
        };
      }),
      null,
      1,
    ),
  );
}

/**
 * Record one workflow proposal, refusing anything that could not be saved.
 *
 * The graph goes through the *same* `normalizeWorkflowInput` and the same
 * `folderRefusal` the save route and the editor's validate route call, with the
 * same `currentKnowledge()` — a second set of rules about what a workflow may
 * be would be a second set to keep in step, confidently wrong about what
 * approval would do the day one of them changed. It is checked here as well as
 * at approval for `proposeRun`'s reason: a proposal that cannot be approved is
 * otherwise discovered by a person clicking Approve, which is the wrong moment
 * and the wrong person.
 *
 * The normalized graph is what is stored, so what the card describes and what
 * approval saves are one object rather than two readings of the model's text.
 *
 * There is no `instanceBudget` argument and no column that could carry one:
 * that is a limit on billed spend, and this route has never let a model set
 * one. The workflow is saved without it and the card says what that costs —
 * it can be run by hand and cannot be scheduled until the operator sets one.
 */
function proposeWorkflow(args: Record<string, unknown>, chatId: string) {
  const name = String(args.name ?? "").trim();
  if (!name) return text("A workflow needs a name.", true);

  const blocks = Array.isArray(args.blocks) ? args.blocks : null;
  if (!blocks || blocks.length === 0) {
    return text("A workflow needs at least one block of work.", true);
  }

  // The tool takes each block's own `dependsOn`, which is the shape `emit_runs`
  // already uses; a graph is `{nodes, edges}`. Converted here rather than asked
  // for in edge form, so a model that has written one has written the other.
  const edges: Array<Record<string, unknown>> = [];
  for (const entry of blocks) {
    const b = (entry ?? {}) as Record<string, unknown>;
    const to = String(b.id ?? "");

    // `""` is the mount root, and `normalizeWorkflowInput` is right to treat it
    // as a real answer — the editor's picker offers it, and choosing it is a
    // decision. An *omitted* field is not that decision, and reading one as the
    // other would silently put a block on the whole workspace, which is the one
    // selection that blocks every other run in the tree. So it is required
    // here, exactly as `propose_run` requires a folder beside a mountId.
    if (String(b.kind ?? "run") !== "merge" && b.folder === undefined) {
      return text(
        `“${String(b.name ?? to)}” names no folder. Pass it exactly as ` +
          'list_folders gives it, or "" if you really mean the whole ' +
          "workspace, which blocks every other run under it.",
        true,
      );
    }

    for (const raw of Array.isArray(b.dependsOn) ? b.dependsOn : []) {
      const d = (raw ?? {}) as Record<string, unknown>;
      edges.push({
        from: String(d.id ?? ""),
        to,
        edge: String(d.edge ?? ""),
        continueBranch: d.continueBranch === true,
      });
    }
  }

  const known = currentKnowledge();
  const parsed = normalizeWorkflowInput(
    { name, graph: { nodes: blocks, edges }, instanceBudget: null },
    known,
  );
  if (!parsed.ok) return text(parsed.error, true);

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return text(missing, true);

  // The card this one replaces, on `proposeRun`'s reasoning and with its rules:
  // refused by name, freeing the label it held, and counting against nothing.
  // Cross-kind on purpose — what is being recorded is only that this card
  // replaced that one, and a run the operator asked to see as a workflow is
  // exactly the correction this argument is for.
  const supersedesRef = String(args.supersedes ?? "").trim() || null;
  let superseded: ChatProposalRow | null = null;
  if (supersedesRef !== null) {
    const found = supersedeTarget(listProposals(chatId), supersedesRef);
    if (!found.ok) return text(found.message, true);
    superseded = found.target;
  }

  const pending = pendingProposals(chatId).filter((p) => p.id !== superseded?.id);
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return text(pendingLimitMessage(pending.length), true);
  }

  const input: ProposalInput = {
    kind: "workflow",
    templateId: null,
    title: name,
    task: String(args.summary ?? "").trim() || `A workflow of ${parsed.value.graph.nodes.length} block(s).`,
    promptOverride: null,
    mountId: null,
    folder: null,
    graph: JSON.stringify(parsed.value.graph),
    // This tool has no id argument of its own, so the only label a workflow
    // proposal ever carries is one `createProposalReplacing` hands over from
    // the card it replaced — for `proposeRun`'s reason: a sibling's dependsOn
    // resolves against the label, and a correction must not be what breaks a
    // chain nobody touched. It then resolves to a proposal that saves a graph
    // rather than starting a run, so the sibling is refused by name at the
    // click rather than started with no dependency at all, which is the
    // direction that fails safe.
    specId: null,
  };

  const written = superseded
    ? createProposalReplacing(chatId, input, superseded.id)
    : { ok: true as const, proposal: createProposal(chatId, input) };
  if (!written.ok) {
    return text(
      `${written.reason} You named "${supersedesRef}", and nothing was ` +
        "proposed — not this workflow, and no change to that one.",
      true,
    );
  }
  const proposal = written.proposal;

  const deciding = parsed.value.graph.nodes.filter(
    (n) => n.kind === "orchestrator",
  );
  return text(
    `Proposed the workflow “${name}” (id ${proposal.id}) with ` +
      `${parsed.value.graph.nodes.length} block(s). Approving it **saves** the ` +
      "workflow; it starts nothing, and the operator presses Run on it " +
      "themselves." +
      (superseded
        ? ` It replaces “${superseded.title}”, which is no longer waiting.`
        : "") +
      (deciding.length > 0
        ? ` ${deciding.length} block(s) decide what to run and may start up to ` +
          `${deciding.reduce((n, d) => n + (d.fanOut ?? 0), 0)} run(s) between ` +
          "them with no approval, which the card says."
        : "") +
      " It is saved with no workflow-wide budget, so it can be run by hand and " +
      "cannot be scheduled until the operator sets one.",
  );
}

/**
 * Record what the chat wants to know, and tell it plainly that it is done.
 *
 * The tool result is the second place — after the description — where "this
 * turn is over" has to be unmissable, and it is the one the model reads
 * *after* deciding to call. It says what was recorded, that no answer is
 * coming here, and what to do instead, because a receipt that only confirms
 * the write reads as a step in a sequence rather than as the end of one.
 *
 * Nothing is appended to the thread. `save_template` does, because a template
 * write leaves nothing behind for the operator to act on; a question leaves a
 * row of its own that the chat payload carries, and the answer message quotes
 * the question back — so it survives even the replay a lost session falls back
 * to, without a system message saying twice what the row already says.
 */
/**
 * The board, filtered and paginated, for either subject.
 *
 * `listTasks`' own page cap is what bounds this rather than a number of this
 * route's own — the board's cap is written once beside its DTO, and a second
 * one here would be a tool answering with a different amount than the page for
 * the same query. What this adds is a *narrower row than the page draws*: the
 * clipped body and the fields a model needs to pick one, and none of the
 * timestamps, folder splits or three run-id records that only a board renders.
 * The reason is the turn rather than the wire — a full board of a hundred rows
 * with every column is a tool result the size of the conversation asking for it.
 *
 * Narrowed at the boundary, `list_folders`' rule: every value here arrives off a
 * model's tool call, so a `status` holding a number must be refused rather than
 * become a filter that silently matches nothing. `listTasks` takes closed
 * vocabularies and an unparseable one is dropped by it — which is the one thing
 * a filter may not do quietly, so each is checked by name first.
 */
function listTasksTool(args: Record<string, unknown>) {
  for (const [field, allowed] of [
    ["status", TASK_STATUSES],
    ["origin", TASK_ORIGINS],
  ] as const) {
    const raw = args[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
      return text(
        `${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(raw)}. ` +
          "Leave it out for the whole board.",
        true,
      );
    }
  }

  const mountId = String(args.mountId ?? "").trim() || null;
  const folder = String(args.folder ?? "").trim() || null;
  // Said rather than silently ignored: `listTasks` narrows on the pair, so a
  // folder without its mount filters nothing and a model that sent one would
  // read a whole board back as "everything in that folder".
  if (folder && !mountId) {
    return text(
      "folder needs mountId beside it — a folder path alone does not say " +
        "which mount it is on and narrows nothing. Call list_folders for both.",
      true,
    );
  }

  const page = listTasks({
    status: (args.status as TaskStatus | undefined) ?? null,
    origin: (args.origin as TaskOrigin | undefined) ?? null,
    mountId,
    folder,
    offset: Number(args.offset) || 0,
  });

  return text(
    JSON.stringify(
      {
        tasks: page.tasks.map((t) => {
          // Projected off the board's own list DTO rather than off the row, so
          // the clip a model reads is the clip the operator reads — one rule,
          // in `taskListItemDTO`, rather than a second copy of it here that
          // could disagree about where a brief is cut.
          const row = taskListItemDTO(t);
          return {
            taskId: row.id,
            title: row.title,
            // A clip and not the brief. `get_task` returns the whole of it and
            // the description says so, because a model that works from this
            // field writes a run against two hundred characters and an
            // ellipsis — the same failure the board's own editor guards.
            bodyPreview: row.body,
            // Said rather than left to be spotted from the ellipsis, the rule
            // `list_folders` follows for a repo it did not look at: a model
            // that cannot tell a clipped brief from a short one writes a run
            // against the clip.
            bodyClipped: row.body.length < t.body.length,
            status: row.status,
            priority: row.priority,
            origin: row.origin,
            mountId: row.mountId,
            folder: row.folder,
            // Which run holds it, because proposing a second run for a task an
            // agent is already working is the expensive mistake this board's
            // own doc names: two agents, one brief, one folder, nothing saying
            // so.
            claimedByRunId: row.claimedByRunId,
          };
        }),
        // The three figures the existing list tools answer with, for their
        // reason: a page that did not say what it left out reads as the whole
        // board, and a model then reports a backlog it only saw the top of.
        offset: page.offset,
        returned: page.tasks.length,
        totalMatching: page.total,
      },
      null,
      1,
    ),
  );
}

/**
 * One task, whole — the brief unclipped, and the runs started for it.
 *
 * Refused by name where the id is not there, `taskRefusal`'s wording, so a
 * model that mistyped an id is told which tool has the right ones rather than
 * being handed an empty object it reads as an empty task.
 */
function getTaskTool(args: Record<string, unknown>) {
  const taskId = String(args.taskId ?? "").trim();
  const task = taskId ? getTask(taskId) : null;
  if (!task) {
    // `taskRefusal`'s wording rather than one of this route's, so an id that is
    // not there reads the same here as it does when a proposal or an emission
    // names it. The board is read again on the miss path only.
    return text(taskRefusal(taskId, currentTaskKnowledge()) ?? "", true);
  }

  const links = runLinksForTasks([task.id]).get(task.id);
  const thread = listTaskComments(task.id, MAX_TOOL_TASK_COMMENTS);
  return text(
    JSON.stringify(
      {
        taskId: task.id,
        title: task.title,
        body: task.body,
        // The thread, because this is the unclipped door and a note the
        // operator wrote on a task is part of what the task asks for. Oldest
        // first with the oldest dropped when it does not fit — `listTaskComments`
        // carries why that end and not the other.
        comments: thread.comments.map(toolComment),
        commentsShown: thread.comments.length,
        commentsTotal: thread.total,
        status: task.status,
        priority: task.priority,
        origin: task.origin,
        mountId: task.mountId,
        folder: task.folder,
        parentTaskId: task.parentTaskId,
        createdByRunId: task.createdByRunId,
        claimedByRunId: task.claimedByRunId,
        completedByRunId: task.completedByRunId,
        // Runs started *for* this task, which is the link a `taskId` on a
        // proposal or an emission writes. Reported so a model can see the work
        // has been tried before proposing it again — and capped and counted
        // separately for the reason the diff names its omissions.
        runsStartedForIt: links?.runIds ?? [],
        runsStartedForItTotal: links?.runCount ?? 0,
        createdAt: new Date(task.createdAt).toISOString(),
        updatedAt: new Date(task.updatedAt).toISOString(),
      },
      null,
      1,
    ),
  );
}

/**
 * One note as a tool result carries it.
 *
 * `author` rather than a run id, because that pairing is the whole of what the
 * column records and a model handed a bare id would attribute a note to whoever
 * it guessed. The body is **whole** and not clipped, which is the one place this
 * departs from `bodyPreview` beside it: a work cycle has no `get_task`, so there
 * is no second call that would return the rest, and a clipped note is an
 * instruction it can never finish reading.
 */
function toolComment(comment: TaskComment) {
  return {
    author: comment.author,
    authorRunId: comment.authorRunId,
    body: comment.body,
    at: new Date(comment.createdAt).toISOString(),
  };
}

/**
 * Write a note on a task, as whichever subject is asking.
 *
 * **The author is the subject's and never the call's**, which is this tool's
 * whole authorisation and the reason both callers go through one function: two
 * handlers would be two places an actor is assembled, and the one that got it
 * wrong would produce a thread saying the operator wrote what a model did.
 * `normalizeTaskCommentInput` refuses an `author` off the wire by name for the
 * same reason.
 *
 * **It moves nothing**, and nothing here may make it: no `updateTask`, and in
 * particular no touch of `tasks.updated_at`, which the board sorts on — a note
 * that reordered the board would read as a move on every surface drawing it.
 * `taskTransitionRefusal` stays the whole of the board's authority model and
 * this is not a second answer to it.
 *
 * A task that is not there is refused in `taskRefusal`'s wording rather than one
 * written here, so a mistyped id reads the same as it does at `get_task`, at a
 * proposal and at an emission.
 */
function commentOnTask(
  args: Record<string, unknown>,
  actor: TaskActor,
  chatId?: string,
) {
  const taskId = String(args.taskId ?? "").trim();
  const written = addTaskComment(taskId, args, actor);

  if (!written.ok) {
    if (written.kind === "missing") {
      return text(taskRefusal(taskId, currentTaskKnowledge()) ?? "", true);
    }
    return text(written.error, true);
  }

  const task = getTask(taskId);
  if (chatId) {
    // On the thread, `create_task`'s rule: the operator's transcript is where
    // anything the chat wrote outside the conversation has to appear, or a task
    // that grew a note has no trace on the page that grew it.
    appendMessage(
      chatId,
      "system",
      `The chat wrote a note on the task “${task?.title ?? taskId}”. Nothing ` +
        "about the task itself changed.",
    );
  }

  return text(
    `Written on “${task?.title ?? taskId}”. The note is permanent and cannot ` +
      "be edited or deleted. Nothing about the task changed — it has the same " +
      "status, the same priority and the same owner it had before.",
  );
}

/**
 * File a task on the operator's board.
 *
 * **The one write on this surface that is not a proposal**, and what makes it
 * defensible is the same property the two proposal tools have: it starts
 * nothing. A row in `tasks` claims no folder, consumes no concurrency slot,
 * spawns nothing and is invisible to every guard — so there is nothing here for
 * an approval step to hold back, and asking for one would only teach an operator
 * to click through a dialog that never mattered.
 *
 * It files as `open` and can reach no other status. That is enforced twice and
 * neither is decoration: there is no `status` on the schema, and
 * `normalizeTaskInput` refuses one **by name** if a model sends it regardless —
 * the same door the operator's own POST goes through. Which actor may move a
 * task to which status is `taskTransitionRefusal`, and this route deliberately
 * is not a second answer to it: a chat turn that could write `done` would be a
 * model closing the operator's work on its own say-so, from a surface whose
 * whole design is that a person decides whether anything happens.
 */
function createTaskTool(args: Record<string, unknown>, chatId: string) {
  const parsed = normalizeTaskInput(args, {
    // Stated here rather than read off the body, `OPERATOR`'s rule on the
    // task routes: a field that could name a different origin would be a model
    // filing work as though the operator had written it down themselves.
    origin: "chat",
    // Null because a chat turn is not a run. `createdByRunId` records the run
    // that filed a task and there is none here — the chat is a conversation,
    // and `chatId` is not a run id however much a column would take it.
    createdByRunId: null,
  });
  if (!parsed.ok) return text(parsed.error, true);

  const created = createTask(parsed.value);
  // A parent id that is not on the board arrives here, not above: only the
  // write knows whether the row it would be filed under exists. Said back
  // rather than dropped, `agentRefusal`'s rule.
  if (!created.ok) return text(created.error, true);
  const task = created.task;
  // On the thread, for `save_template`'s reason: the operator's transcript is
  // where anything the chat wrote outside the conversation has to appear, or a
  // board that grew a row has no trace on the page that grew it.
  appendMessage(
    chatId,
    "system",
    `The chat filed a task on the board: “${task.title}”. It is open and ` +
      "nothing is running for it.",
  );
  return text(
    `Filed “${task.title}” (id ${task.id}) on the board as open. Nothing is ` +
      "running for it and nothing will until somebody starts it — name this " +
      "id as taskId on a propose_run to link a run to it. You cannot close it; " +
      "that is the operator's press or the run that does the work.",
  );
}

/* ------------------------------------------------------------------ */
/* The board, as one work cycle sees it                                */
/* ------------------------------------------------------------------ */

/**
 * Where a run is working: the folder it reads the board for, and the pair it may
 * file a task against.
 *
 * `runs.folder` and not `runs.work_dir`: an isolated run works in a checkout
 * under `.uf-worktrees` that exists for the length of the run, and a task filed
 * against it would name a directory nobody can find afterwards. The folder is
 * the project, which is what a backlog is about.
 *
 * **The read's folder and the write's pair are separate answers, and collapsing
 * them is a bug.** `folder` is a string compared against `tasks.folder`, which
 * needs no mount; `filing` is the `mount_id`/`folder` pair `normalizeTaskInput`
 * proves, and that door refuses **half a pair** by design. `describeFolder`
 * returns a null `mountId` for a path under no configured mount — a mount the
 * operator renamed or removed while a run was in flight, which is a thing that
 * happens — so passing its `mountId` through beside a non-null folder would
 * refuse every `create_task` that run made, for a reason the model can do
 * nothing about and over a field it never named. An unplaced task is still a
 * task and the brief is the part that matters, so filing drops **both** when the
 * mount cannot be identified while the read keeps the folder.
 *
 * All three are null when the run is gone — a run deleted mid-cycle — and
 * callers treat that as "no folder" rather than throwing: a token whose run row
 * has vanished is still a token that must not reach another run's work, and
 * every rule keyed on the run id is unaffected by this.
 */
function runFolder(runId: string): {
  folder: string | null;
  filing: { mountId: string; folder: string } | null;
} {
  const run = getRun(runId);
  if (!run?.folder) return { folder: null, filing: null };
  const mountId = describeFolder(run.folder).mountId;
  return {
    folder: run.folder,
    filing: mountId ? { mountId, folder: run.folder } : null,
  };
}

/**
 * What this run holds and what is open beside it.
 *
 * Deliberately two lists rather than one board: `held` is what this run may
 * complete, `openInFolder` is what it should read before filing. Naming them
 * apart in the payload is what stops a model completing something it merely saw
 * — the ids are in the same shape, and a single flat list is an invitation.
 */
function listMyTasks(runId: string) {
  const { folder } = runFolder(runId);
  const mine = tasksForRun(runId, folder);

  return text(
    JSON.stringify(
      {
        // `taskListItemDTO`'s clip, for its reason: one rule about where a brief
        // is cut, read by the operator's board and by this tool alike.
        held: mine.held.map((t) => {
          const row = taskListItemDTO(t);
          // The thread on `held` and deliberately not on `openInFolder`: a note
          // is what the operator said about the task *this run is doing*, and
          // it is the only way one reaches a cycle — the appended system prompt
          // is frozen against the cached prefix and cannot carry a thread that
          // changes between cycles. Notes on a task the run may not act on
          // would be tokens spent on somebody else's conversation.
          //
          // One query per held row rather than one for the set. `held` is
          // capped at `MAX_RUN_TASKS` and this is a tool call rather than a
          // ten-second poll, so the N+1 the board's own listing refuses is
          // bounded here at twenty reads nothing repeats.
          const thread = listTaskComments(t.id, MAX_TOOL_TASK_COMMENTS);
          return {
            taskId: row.id,
            title: row.title,
            bodyPreview: row.body,
            bodyClipped: row.body.length < t.body.length,
            status: row.status,
            priority: row.priority,
            comments: thread.comments.map(toolComment),
            commentsShown: thread.comments.length,
            commentsTotal: thread.total,
          };
        }),
        openInFolder: mine.openInFolder.map((t) => {
          const row = taskListItemDTO(t);
          return {
            taskId: row.id,
            title: row.title,
            bodyPreview: row.body,
            bodyClipped: row.body.length < t.body.length,
            priority: row.priority,
          };
        }),
        // Said rather than left to be inferred from a list that stops, the rule
        // every other list tool here follows: a run shown twenty of sixty files
        // the duplicate it read the list to avoid.
        openInFolderShown: mine.openInFolder.length,
        openInFolderTotal: mine.openInFolderTotal,
        folder,
        // The sentence the shape cannot carry. A model reading two arrays of
        // ids will reach for the nearest one, and only one of them is closeable.
        note:
          "complete_task works on held only. Nothing here can close, claim or " +
          "drop anything in openInFolder — comment_on_task if one of those " +
          "needs a note, or create_task if it is work of its own.",
      },
      null,
      1,
    ),
  );
}

/**
 * Close a task this run holds.
 *
 * **The run id is the token's, never the call's**, which is the whole of the
 * authorisation here and the one line in this file not to change without reading
 * `docs/agent/security.md`. `updateTask` compares it against the row's own
 * `claimed_by_run_id` through `taskTransitionRefusal`; this route adds no second
 * answer to that rule and must not — a work cycle that could complete a task it
 * does not hold could close the whole board, and every refusal below is that
 * function's sentence rather than one written here.
 */
/**
 * Close a task this run holds, or start the check that decides whether it may
 * be closed.
 *
 * **The authority is unchanged and that is deliberate.** `updateTask` with this
 * run as the actor is still the only door, so `taskTransitionRefusal` is still
 * the whole of the board’s authority model: a validation can *delay* a close
 * this run could have made and can never make one it could not. The refusals
 * below are the same two, in the same words, whether or not the check is on.
 *
 * **What the model is told when the check starts is a fact and not a
 * promise.** It is not told that a verdict will re-open anything, and it is not
 * told to wait: it is told the task is not closed yet, and what to do about a
 * reading it disagrees with. A tool result that said "this will be confirmed
 * shortly" would have the model call `list_my_tasks` in a loop to find out.
 */
async function completeTaskForRun(args: Record<string, unknown>, runId: string) {
  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return text(
      "complete_task needs the taskId of a task this run holds. list_my_tasks " +
        "returns them under held.",
      true,
    );
  }

  const outcome = await completeTaskWithValidation(taskId, runId);

  if (outcome.kind === "refused") {
    // `missing` and `refused` are told apart by `tasks.ts` and both are the
    // model's own error to read: an id that is not there is a mistyped id, and a
    // refusal names the run that actually holds the task.
    return text(outcome.error, true);
  }

  if (outcome.kind === "checking") {
    return text(
      `“${outcome.task.title}” is **not closed yet**. What this run has ` +
        "committed to its branch is being read against what the task asks for, " +
        "and the task closes by itself if that reading finds everything there.\n\n" +
        "Two things follow. Anything you have changed but not committed is not " +
        "on the branch and cannot be seen, so commit it now if it is part of " +
        "the work. And if the reading comes back saying something is missing, " +
        "you will be told what, and the task stays yours — you do not need to " +
        "call this tool again to find out.",
    );
  }

  return text(
    `Marked “${outcome.task.title}” done. It is recorded as completed by this run. ` +
      (outcome.note
        ? `It was closed without being checked, because ${outcome.note}. `
        : "") +
      "If it turns out not to be finished, say so in your reply — you cannot " +
      "re-open it, and only the operator can.",
  );
}

/**
 * File a task a run found while doing something else.
 *
 * Three of the four fields that place it are taken from the token rather than
 * from the call, and none of them is on the schema: the origin, the run that
 * filed it, and the folder. The fourth, `parentTaskId`, defaults to the task
 * this run was started for — the trail back to what was being done when the
 * thing was noticed, which is the whole reason the column exists.
 *
 * The parent is dropped rather than refused when the task it names is gone. A
 * run whose brief the operator deleted mid-flight would otherwise have every
 * `create_task` refused by `createTask`'s dangling-parent check, which is the
 * one path where the thing worth keeping — the new brief — is lost to the state
 * of a row it is only annotated with.
 */
function createTaskForRun(args: Record<string, unknown>, runId: string) {
  const { filing } = runFolder(runId);
  const named = String(args.parentTaskId ?? "").trim();
  const inherited = taskForRun(runId);
  const parent = named || inherited?.id || null;

  const parsed = normalizeTaskInput(
    {
      ...args,
      // Never off the call: a run has no `list_folders` and no way to name a
      // folder it was not pointed at, and a folder off the wire would be one
      // more place `resolveWorkspaceFolder` has to be re-proved from. Both or
      // neither — `runFolder` carries why.
      mountId: filing?.mountId ?? null,
      folder: filing?.folder ?? null,
      parentTaskId: parent && getTask(parent) ? parent : null,
    },
    {
      // Stated here rather than read off the body, `createTaskTool`'s rule: an
      // origin that could arrive in a call is a run able to file work as though
      // a person had written it down.
      origin: "run",
      createdByRunId: runId,
    },
  );
  if (!parsed.ok) return text(parsed.error, true);

  const created = createTask(parsed.value);
  if (!created.ok) return text(created.error, true);

  // Says where it landed rather than asserting a folder, because a run under a
  // mount the operator has since removed files an unplaced task and a message
  // claiming otherwise would send the model looking for it on a project board.
  return text(
    `Filed “${created.task.title}” (id ${created.task.id}) on the board as ` +
      (created.task.folder
        ? `open, against ${created.task.folder}. `
        : "open, against no project — this run's folder is under no mount the " +
          "app currently has, so the brief is on the board unplaced. ") +
      "Nothing is running for it and nothing will until somebody starts it — " +
      "carry on with the work you were given, and say in your reply that you " +
      "filed it.",
  );
}

function askOperator(args: Record<string, unknown>, chatId: string) {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  if (raw.length === 0) {
    return text(
      "ask_operator needs at least one question. If you know what to do, " +
        "propose it instead — the operator approves every proposal by hand.",
      true,
    );
  }

  // Bounded against what is *already* open as well as against this call: a
  // turn may call this twice, and a chat whose last turn asked five questions
  // the operator has not read yet does not need five more.
  const open = pendingQuestions(chatId);
  if (open.length + raw.length > MAX_OPEN_QUESTIONS) {
    return text(
      `That would leave ${open.length + raw.length} questions waiting, and the ` +
        `limit is ${MAX_OPEN_QUESTIONS}${
          open.length > 0 ? ` (${open.length} of them already asked)` : ""
        }. A list that long is a form rather than a question, and a form gets ` +
        "skimmed. Ask the ones that change what you would propose, and say the " +
        "rest in your reply.",
      true,
    );
  }

  const questions: QuestionInput[] = [];
  for (const entry of raw) {
    const q = (entry ?? {}) as Record<string, unknown>;
    const question = String(q.question ?? "").trim();
    if (!question) return text("Every question needs its text.", true);

    // Normalized first, so every refusal below counts what would actually be
    // rendered rather than what arrived: twenty distinct choices and twenty
    // copies of one are different mistakes and get different sentences.
    const choices = normalizeChoices(q.choices);
    const allowText = q.allowText !== false;

    if (choices.length > MAX_QUESTION_CHOICES) {
      return text(
        `"${question}" offers ${choices.length} choices, and the most that can ` +
          `be shown is ${MAX_QUESTION_CHOICES}. Past that it is a search rather ` +
          "than a decision — narrow it, or ask it in the open.",
        true,
      );
    }
    // One choice is not a choice, and the operator has no way to say so — it
    // reads as a decision already taken. Refused rather than quietly turned
    // into free text, because which of the two the model meant is not
    // something this route can know.
    if (choices.length === 1) {
      return text(
        `"${question}" offers one choice, which is not a choice. Offer at ` +
          "least two, or omit choices and let the operator answer in their " +
          "own words.",
        true,
      );
    }
    // The unanswerable question, and the one this route exists to catch: no
    // choices and no typing is a card with nothing on it to press, holding one
    // of the operator's five slots until some later message supersedes it. It
    // is reachable without the model meaning any of it — `choices` sent as a
    // bare string normalizes to none, which is exactly the arrival shape
    // `normalizeChoices` is built to survive — so it is refused by name rather
    // than by turning `allowText` back on, which would answer a different
    // question from the one that was asked.
    if (choices.length === 0 && !allowText) {
      return text(
        `"${question}" offers no choices and does not allow a typed answer, so ` +
          "there is no way to answer it. Offer at least two choices, or leave " +
          "allowText true.",
        true,
      );
    }

    questions.push({
      question,
      choices,
      // True unless the model says otherwise, including when it offers
      // choices: a question the operator cannot answer in their own words is
      // one they answer by ignoring, and a superseded question teaches the
      // model nothing about what it got wrong.
      allowText,
    });
  }

  createQuestions(chatId, questions);

  return text(
    `Recorded ${questions.length} question${questions.length === 1 ? "" : "s"} ` +
      "for the operator. Your turn ends here. Nothing returns their answer to " +
      "you: it arrives as their next message in this conversation, with each " +
      "question quoted above the answer to it. Finish your reply now — say " +
      "what you asked, why it changes what you would propose, and what you " +
      "would propose under each answer — and do NOT call this again.",
  );
}

/**
 * What a `supersedes` argument names, refusing it by name where it names
 * nothing. Shared by both proposal tools, because the argument is shared.
 *
 * Refused rather than dropped, which is `agentId`'s rule and matters more here:
 * a supersede the model believes it made and this route quietly ignored is the
 * corrected card written *beside* the wrong one, which is two cards for one job
 * and the exact outcome the argument exists to remove. The sentence names both
 * spellings, because the model holds two — its own label and the proposalId
 * that came back — and a refusal that names one sends it to guess the other.
 */
function supersedeTarget(
  proposals: readonly ChatProposalRow[],
  reference: string,
): { ok: true; target: ChatProposalRow } | { ok: false; message: string } {
  const target = proposalByReference(proposals, reference);
  if (target) return { ok: true, target };
  return {
    ok: false,
    message:
      `Nothing in this conversation is called "${reference}", so there is ` +
      "nothing to replace and nothing was proposed. Call list_proposals: " +
      "supersedes takes either the id you gave a proposal or the proposalId " +
      "that came back when you made it.",
  };
}

/** One sentence, shared by both proposal tools, because the limit is shared. */
function pendingLimitMessage(count: number): string {
  return (
    `This chat already has ${count} proposals waiting for approval, which is ` +
    `the limit (${MAX_PENDING_PROPOSALS}). A list that long stops getting read ` +
    "before it gets approved. Tell the operator what you would propose next " +
    "and ask them to approve or reject these first, or narrow what you are " +
    "proposing."
  );
}

/**
 * Write a template's name, prompt and model, and nothing else.
 *
 * The guards are read off the existing row or off `chatGuards()` and written
 * straight back, so there is no argument on this tool that could move one. That
 * is the same division `planProposal` enforces at approval time, applied here
 * because a template the chat could arm would be a route to `--permission-mode`
 * that outlives the conversation — worse than a proposal, which at least gets
 * looked at once before it runs.
 *
 * The model is the third thing rather than a hole in that division, on the
 * ground `agents.ts` states and `planProposal` restates: it moves cost rather
 * than capability, and every cost guard already covers it because the run's
 * spend lands on its own `result` event whatever model produced it. What it can
 * outlive the conversation as is a template that costs more or less than it
 * did, which is why the write is said in the thread rather than only returned.
 *
 * The write is recorded in the thread rather than left to the model to mention.
 * A proposal has a card; this has nothing, and rewriting a prompt the operator
 * wrote and tested is not something they should find out about by reading a
 * template weeks later and wondering when it changed.
 */
function saveTemplate(args: Record<string, unknown>, chatId: string) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return text("A template needs a prompt.", true);

  const templateId = String(args.templateId ?? "").trim();
  const existing = templateId ? getTemplate(templateId) : null;
  if (templateId && !existing) {
    return text(
      `No template with id "${templateId}". Call list_templates, or omit ` +
        "templateId to create a new one.",
      true,
    );
  }

  const name = String(args.name ?? "").trim() || existing?.name || "";
  const guards = existing ?? chatGuards();

  // Refused in the model's own turn, `agentRefusal`'s rule: this is the moment
  // it can act on the sentence, and a template that names a model no door will
  // accept is a run refused weeks later with nothing on the page to explain it.
  //
  // Only what the *argument* names. A model carried off the row is a field this
  // tool is preserving rather than writing — the update replaces the template
  // wholesale, so every untouched field passes through here — and refusing a
  // prompt rewrite over a model somebody else chose and an operator has since
  // switched off would be this check deciding something it was told not to.
  // That one is the run door's to refuse, in front of the person starting it.
  const model =
    args.model === undefined ? (existing?.model ?? null) : modelArgument(args.model);
  if (args.model !== undefined) {
    const refusal = modelRefusal(getSettings().modelCatalogue, model);
    if (refusal) return text(refusal, true);
  }
  const input = {
    name,
    prompt,
    mountId: existing?.mountId ?? null,
    folder: existing?.folder ?? null,
    isolate: guards.isolate,
    permissionMode: guards.permissionMode,
    // Carried from the row rather than taken from an argument, and named here
    // for the reason every other field on this object is: the update replaces
    // the template wholesale, so a field this list forgets is a field the chat
    // silently deletes. There is deliberately no argument for it — which agent
    // a template names is one of the facts a person chose, and this tool may
    // write a prompt and nothing else.
    agentId: existing?.agentId ?? null,
    // The one field on this object an argument may move, and the sentence
    // above is why it can: a model decides what a run from this template
    // costs, which every cost guard already covers, and never what it may do.
    // Omitted leaves the row's own answer alone — this update replaces the
    // template wholesale, so a forgotten field is one the chat silently
    // deletes — and the empty string is a real answer that clears it, since
    // `normalizeTemplateInput` reads blank as "names no model".
    model,
    budget: guards.budget,
  };

  // Re-read through the same normaliser the form uses, so a prompt or name this
  // tool accepts is exactly one the operator could have typed.
  const normalized = normalizeTemplateInput(input, {
    agents: currentAgentKnowledge(),
  });
  if (!normalized.ok) return text(normalized.error, true);

  try {
    const saved = existing
      ? updateTemplate(existing.id, normalized.value)
      : createTemplate(normalized.value);
    if (!saved) return text("That template was deleted while saving.", true);
    // Said in the thread as well as the prompt, because it is the second saved
    // value this tool writes and the one the operator would otherwise meet on a
    // bill: a template that quietly changed price weeks ago is a fact nothing
    // else on the page reports. Said outside the guard sentence, which stays
    // exactly as true — the same separation the proposal card makes.
    const onModel = saved.model
      ? ` It runs on ${saved.model}.`
      : " It names no model, so runs from it use your default.";
    appendMessage(
      chatId,
      "system",
      existing
        ? `The chat rewrote the prompt of the “${saved.name}” template.${onModel} ` +
          "Its guards are unchanged."
        : `The chat saved a new template, “${saved.name}”, under your default ` +
          `guard set.${onModel}`,
    );
    return text(
      `${existing ? "Rewrote" : "Saved"} template “${saved.name}” (id ${saved.id}). ` +
        `Model: ${saved.model ?? "none, so the operator's default applies"}. ` +
        `Its guards are unchanged: ${saved.permissionMode}, ` +
        `${saved.isolate ? "own checkout" : "the operator's own folder"}, ` +
        `${saved.budget.maxIterations ?? "no"} work-cycle limit.`,
    );
  } catch (err) {
    // A duplicate name arrives here as the sentence the form would show.
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Record one proposal, refusing anything that could not later be approved.
 *
 * Deliberately stricter than it has to be. `planProposal` and `createRun` both
 * check these again at approval time and only those checks guard anything —
 * but a proposal that cannot be approved is discovered by a person clicking
 * Approve on a list of twenty, which is the wrong moment and the wrong person.
 * The same reasoning `normalizeTemplateInput` gives for validating at the form.
 */
function proposeRun(args: Record<string, unknown>, chatId: string) {
  const templateId = String(args.templateId ?? "").trim();
  const template = templateId ? getTemplate(templateId) : null;
  if (templateId && !template) {
    return text(
      `No template with id "${templateId}". Call list_templates and use an id ` +
        "from it, or omit templateId to use the operator's default guard set.",
      true,
    );
  }

  // The agent, refused here as well as at approval for the reason the template
  // above it is: a proposal that cannot be approved is otherwise discovered by
  // a person clicking Approve on a list of twenty. It is the same
  // `agentRefusal` the run door, the template door and every workflow door use,
  // so an agent that has gone is one sentence wherever it is named — and it is
  // a refusal rather than a silent drop, because a run proposed "as the
  // reviewer" and started as nobody is bit-for-bit a run that was never given
  // one.
  const agentId = String(args.agentId ?? "").trim() || null;
  if (agentId !== null) {
    const refusal = agentRefusal(agentId, currentAgentKnowledge());
    if (refusal) return text(`${refusal} Call list_agents for the ids.`, true);
  }

  const title = String(args.title ?? "").trim();
  if (!title) return text("A proposal needs a title.", true);

  const task = String(args.task ?? "").trim();
  if (!task) {
    return text(
      "A proposal needs a task. It is the whole brief the agent gets besides " +
        "the template's own prompt.",
      true,
    );
  }

  // Null means "whatever the template says". "" is a real answer — the mount
  // root — so the two are never collapsed. See the same note in planProposal.
  const hasMount = args.mountId !== undefined && args.mountId !== null && args.mountId !== "";
  let mountId: string | null = null;
  let folder: string | null = null;

  if (hasMount) {
    mountId = String(args.mountId);
    if (!mountById(mountId)) {
      return text(
        `No workspace mount called "${mountId}". Call list_folders for the ids.`,
        true,
      );
    }
    folder = String(args.folder ?? "");
    try {
      resolveWorkspaceFolder(folder, mountId);
    } catch (err) {
      return text(
        `That folder cannot be used: ${err instanceof Error ? err.message : String(err)}. ` +
          "Use a folder exactly as list_folders gives it.",
        true,
      );
    }
  } else if (!template) {
    return text(
      "A proposal with no template has to name where it runs. Pass mountId " +
        "and folder from list_folders.",
      true,
    );
  } else if (template.mountId === null) {
    return text(
      `The "${template.name}" template does not name a folder, so this ` +
        "proposal has to. Pass mountId and folder from list_folders.",
      true,
    );
  }

  // The chat's own label, and what it says this run starts after. Checked here
  // rather than only at approval for the reason everything else in this
  // function is: a chain that cannot be wired is otherwise discovered by a
  // person clicking Approve on a list of twenty, and what they are shown then
  // is one proposal failing over a label they never saw.
  const proposals = listProposals(chatId);
  const labels = new Map<string, ChatProposalRow>();
  for (const p of proposals) {
    if (!p.spec_id) continue;
    // A replaced card does not hold its label: the replacement inherits it, and
    // the two can share a `created_at` — so insert order decides this on a uuid
    // tiebreak, and losing it refuses an edge onto a card that is still
    // waiting. `approveRunBatch` carries the same line for the same reason.
    if (p.status === "superseded" && labels.has(p.spec_id)) continue;
    labels.set(p.spec_id, p);
  }

  // The card this one replaces, resolved before anything below reads a label or
  // counts what is waiting: it frees the label it holds and it does not add a
  // card to the panel. The write itself is `createProposalReplacing`, at the
  // bottom, and only there is its status decided — everything here is read.
  const supersedesRef = String(args.supersedes ?? "").trim() || null;
  let superseded: ChatProposalRow | null = null;
  if (supersedesRef !== null) {
    const found = supersedeTarget(proposals, supersedesRef);
    if (!found.ok) return text(found.message, true);
    superseded = found.target;
  }

  // The limit counts cards waiting for a decision, and a replacement does not
  // add one — the same transaction that writes it decides the one it replaces.
  // Counting it would make a chat at the ceiling unable to correct its own
  // cards, and the refusal would tell it to propose fewer, which is the one
  // thing it was already doing.
  const pending = pendingProposals(chatId).filter((p) => p.id !== superseded?.id);
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return text(pendingLimitMessage(pending.length), true);
  }

  const ownSpecId = String(args.id ?? "").trim() || null;
  if (ownSpecId !== null) {
    if (!SPEC_ID.test(ownSpecId)) {
      return text(
        `"${ownSpecId}" is not a usable id. An id is 1–64 letters, digits, ` +
          "hyphens or underscores.",
        true,
      );
    }
    // Only against what is still undecided: a label reused after the first one
    // has become a run is unambiguous, because a dependency resolves against
    // the batch first and only then against what already started. The card
    // being replaced is undecided as this is read and decided by the time the
    // row is written, so it is excluded here — otherwise re-proposing the same
    // work under the same label, which is the ordinary correction, refuses
    // itself.
    const holder = labels.get(ownSpecId);
    if (holder && holder.id !== superseded?.id && holder.status === "pending") {
      return text(
        "Another proposal waiting for approval in this chat is already " +
          `labelled "${ownSpecId}". Give this one a different id.`,
        true,
      );
    }
  }

  // What the row will end up labelled: a replacement that names no label of its
  // own inherits the one it replaces, so an edge a sibling already wrote
  // against that label still points at a card the operator can approve. The
  // *write* of it is `createProposalReplacing`'s, which is the only caller-proof
  // place for it; this is the same value, read here because the checks below
  // need to know the label before the row exists.
  const specId = ownSpecId ?? superseded?.spec_id ?? null;

  const dependsOn: ProposalDependency[] = [];
  for (const raw of Array.isArray(args.dependsOn) ? args.dependsOn : []) {
    const d = (raw ?? {}) as Record<string, unknown>;
    const on = String(d.id ?? "").trim();
    if (specId !== null && on === specId) {
      return text("A proposal cannot start after itself.", true);
    }
    const target = labels.get(on);
    if (!target) {
      return text(
        `This is set to start after "${on}", which is not a proposal in this ` +
          "chat. Give the earlier proposal an id and name that one, or call " +
          "list_proposals for the ids already used.",
        true,
      );
    }
    // The card this call is replacing, named as something to wait for. Refused
    // here rather than left to approval, where it arrives as "superseded and
    // never became a run" about a row this same call decided: the label either
    // belongs to this proposal by inheritance — which is starting after itself
    // — or belongs to a card that is about to stop existing as a run.
    if (superseded && target.id === superseded.id) {
      return text(
        `This replaces "${on}", so it cannot also start after it. Drop it from ` +
          "dependsOn, or propose the two separately.",
        true,
      );
    }
    if (target.status === "rejected" || target.status === "failed") {
      return text(
        `"${on}" was ${target.status} and never became a run, so nothing can ` +
          "start after it.",
        true,
      );
    }
    // A card that was replaced never becomes a run of its own, so an edge onto
    // it is one the operator's click would fail by name. The replacement
    // usually inherits the label, in which case `labels` resolved to the
    // replacement and this never fires; what reaches here is an edge onto a
    // label the correction deliberately dropped.
    if (target.status === "superseded") {
      return text(
        `"${on}" was replaced by another proposal and never became a run, so ` +
          "nothing can start after it. Name the proposal that replaced it — " +
          "call list_proposals for its id.",
        true,
      );
    }
    if (dependsOn.some((existing) => existing.specId === on)) {
      return text(
        `"${on}" is named twice, so it is unclear which condition applies.`,
        true,
      );
    }
    const edge = String(d.edge ?? "");
    if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
      return text(
        `Starting after "${on}" needs a condition: ${DEPENDENCY_EDGES.join(" or ")}.`,
        true,
      );
    }
    dependsOn.push({
      specId: on,
      edge: edge as DependencyEdge,
      // `=== true` for the reason `POST /api/runs` reads it that way: it
      // decides which branch a billed agent commits to, so anything else off
      // the wire must fail safe.
      continueBranch: d.continueBranch === true,
    });
  }

  // Carrying a branch on needs a checkout at both ends, and at most one of
  // them. `admitDependencies` refuses both of these as well, but it does so
  // when the operator clicks and in terms of run ids they have never seen —
  // and the second one is not even a mistake the model can see it made, since
  // isolation is on a guard set it never chose.
  const continuing = dependsOn.filter((d) => d.continueBranch);
  if (continuing.length > 1) {
    return text(
      `This is set to carry on the branch of both "${continuing[0].specId}" and ` +
        `"${continuing[1].specId}". A run can only continue one branch.`,
      true,
    );
  }
  if (continuing.length === 1) {
    const predecessor = labels.get(continuing[0].specId)!;
    const flat = [
      { label: "This proposal", guards: template ?? chatGuards() },
      {
        label: `"${continuing[0].specId}"`,
        guards: predecessor.template_id
          ? (getTemplate(predecessor.template_id) ?? chatGuards())
          : chatGuards(),
      },
    ].find((end) => !end.guards.isolate);
    if (flat) {
      return text(
        `${flat.label} works directly in the folder rather than in a checkout ` +
          "of its own, so there is no branch to carry on. Both runs need guards " +
          "that isolate — a template that does, or ask the operator to change " +
          "the default guard set.",
        true,
      );
    }
    // The third condition `admitDependencies` refuses, and the one it is worst
    // at refusing: a rival is another *proposal*, so what the operator is shown
    // at the click is two run ids for two cards, and — since a proposal that
    // fails to start is terminal — one of the cards is gone. Asked here after
    // the guard check above, because with no branch at either end there is
    // nothing for a rival to be claiming.
    const rival = rivalContinuation(
      continuing[0].specId,
      proposals.map((p) => ({
        specId: p.spec_id,
        title: p.title,
        status: p.status,
        dependsOn: proposalDeps(p),
      })),
    );
    if (rival) {
      const named = rival.specId ? `"${rival.specId}"` : `“${rival.title}”`;
      const instead = rival.specId
        ? `Start this one after "${rival.specId}" instead, or drop `
        : "That one carries no id, so nothing can be chained behind it: drop ";
      return text(
        `${named} is already waiting to carry on "${continuing[0].specId}"'s ` +
          `branch, and two runs cannot extend the same one. ${instead}` +
          "continueBranch so this one cuts a branch of its own.",
        true,
      );
    }
  }

  const promptOverride = String(args.promptOverride ?? "").trim() || null;

  // Checked against a list of models, unlike every version of this route before
  // `settings.modelCatalogue` existed. The objection that kept it free text was
  // that a list *this build* knows would refuse whatever ships next month, and
  // it stood for as long as the list would have been this build's; the one it
  // reads now is the operator's, and an id they have not got is a card that
  // starts a run which dies at its first spawn. What has not changed is what
  // this can refuse *for*: the model reaches `--model` and nothing else, so
  // this is validation and never a guard.
  //
  // Refused here and **not** again at the click. `docs/agent/chat.md` sorts a
  // proposal's fields by whether they decide something about the run: a model
  // switched off between the write and the press changes what the run costs,
  // which every guard on the card already measures rather than being set by,
  // and nothing about what it may do — so it sits with `task_id` on the side
  // that never refuses an approval, not with `template_id` on the side that
  // does. Refusing there would be terminal for every member of the batch.
  //
  // Blank is "named none": whitespace must not become `--model "  "`.
  const model = modelArgument(args.model);
  const modelProblem = modelRefusal(getSettings().modelCatalogue, model);
  if (modelProblem) return text(modelProblem, true);

  // The board row this run is for, refused here for the template's and the
  // agent's reason and gating nothing at the click, unlike either of them: a
  // proposal that named a task nobody can find is discovered by a person
  // reading a card, which is the wrong moment, but a task *deleted* between the
  // proposal and the press changes nothing about the run and must not refuse
  // the approval. `taskRefusal` owns the wording so a chat and a block say the
  // same thing about the same id. A closed task is accepted — see
  // docs/agent/taskboard.md.
  const taskId = String(args.taskId ?? "").trim() || null;
  const board = taskId ? currentTaskKnowledge() : null;
  if (taskId && board) {
    const problem = taskRefusal(taskId, board);
    if (problem) return text(problem, true);
  }

  const input: ProposalInput = {
    templateId: template ? template.id : null,
    agentId,
    model,
    taskId,
    title,
    task,
    promptOverride,
    mountId,
    folder,
    // Only the model's own. Null lets `createProposalReplacing` hand over the
    // label of the card being replaced, so one function decides it.
    specId: ownSpecId,
    dependsOn,
  };

  const written = superseded
    ? createProposalReplacing(chatId, input, superseded.id)
    : { ok: true as const, proposal: createProposal(chatId, input) };
  if (!written.ok) {
    return text(
      `${written.reason} You named "${supersedesRef}", and nothing was ` +
        "proposed — not this run, and no change to that one. Say what " +
        "happened; if the work is still worth doing, propose it as a new run " +
        "saying what you would have changed.",
      true,
    );
  }
  const proposal = written.proposal;

  const guards = template
    ? `template "${template.name}"${promptOverride ? ", with a prompt you rewrote" : ""}`
    : "the operator's default guard set";
  // Said outside the guard clause, because an agent bounds nothing — the same
  // separation the run page and the workflow canvas make, so this app never
  // words it as though naming one narrowed anything.
  const asAgent = agentId
    ? ` It runs as ${currentAgentKnowledge().get(agentId)?.name ?? "the agent you named"}.`
    : "";
  // Outside the guard clause for the agent's reason, and said back at all
  // because what a named model displaces is the operator's own default — so it
  // is a fact the reply should carry rather than one the operator meets on a
  // bill. Silent where none was named: the card draws no row there either.
  const onModel = model ? ` It runs on ${model}.` : "";
  // Said back for the model's reason and with the model's caveat: it is a fact
  // the operator should meet on the card rather than work out. Worded as a
  // record — "for" — because that is all it is: the approval does not claim the
  // task and the run ending does not close it, and a reply reading as though it
  // did is what would make a model stop filing the follow-up.
  const forTask = taskId
    ? ` It is recorded as being for “${board?.get(taskId)?.title ?? taskId}” on ` +
      "the board; approving it does not claim that task and finishing will not " +
      "close it."
    : "";
  const after =
    dependsOn.length === 0
      ? ""
      : ` It starts after ${dependsOn
          .map(
            (d) =>
              `"${d.specId}" (${d.edge}${d.continueBranch ? ", on its branch" : ""})`,
          )
          .join(" and ")} — say so, because both have to be approved in the ` +
        "same click unless the earlier one has already started.";
  // Said back because the operator sees one card where the model wrote two, and
  // the model's reply is the only place the *first* one is accounted for at all
  // — a reply that describes this as a new proposal reads as work added rather
  // than work corrected. The inherited label is named for `after`'s reason: it
  // is what a sibling's dependsOn resolves against.
  const replacing = superseded
    ? ` It replaces “${superseded.title}”, which is no longer waiting` +
      (ownSpecId === null && specId !== null
        ? ` and whose id "${specId}" this one now carries.`
        : ".")
    : "";
  return text(
    `Proposed "${title}" (id ${proposal.id}) under ${guards}.${asAgent}${onModel}${forTask}${replacing}${after} ` +
      "It is waiting for the operator to approve it; nothing is running.",
  );
}
