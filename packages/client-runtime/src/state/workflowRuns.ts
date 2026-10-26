import {
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One status vocabulary for every node in the workflow chart. */
export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export interface WorkflowAgent {
  readonly id: string;
  /** The thread the agent works in, when it has its own. Opening the node opens this thread. */
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly task: string | null;
  readonly driver: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly status: WorkflowStatus;
  readonly progress: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Set only when the agent works outside its parent's workspace, such as an isolated worktree. */
  readonly branch: string | null;
  readonly isolated: boolean;
  readonly children: ReadonlyArray<WorkflowAgent>;
  /** A provider-native workflow's agents, in phase order. Each phase starts after the previous. */
  readonly phases: ReadonlyArray<WorkflowPhase>;
}

export interface WorkflowPhase {
  readonly index: number;
  readonly title: string;
  readonly agents: ReadonlyArray<WorkflowAgent>;
}

export interface WorkflowRun {
  readonly id: RunId;
  readonly ordinal: number;
  readonly prompt: string;
  readonly status: WorkflowStatus;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly agents: ReadonlyArray<WorkflowAgent>;
  /** The main agent combining its agents' results. Null for a run that delegated nothing. */
  readonly merge: WorkflowStatus | null;
  readonly review: {
    readonly status: WorkflowStatus;
    readonly pullRequestNumber: number | null;
  };
}

interface Projection extends Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "messages"
> {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "worktreePath" | "linkedPullRequest"
  >;
}

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));
/** Workflow agents carry epoch milliseconds. */
const isoFromEpochMillis = (value: number | undefined) =>
  value === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(value));

export function workflowStatusIsActive(status: WorkflowStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function runStatus(status: OrchestrationV2Run["status"]): WorkflowStatus {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "pending";
    case "running":
    case "waiting":
    case "completed":
    case "failed":
      return status;
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
  }
}

function subagentStatus(status: OrchestrationV2Subagent["status"]): WorkflowStatus {
  return status === "cancelled" || status === "interrupted" ? "stopped" : status;
}

function shellStatus(shell: OrchestrationV2ThreadShell): WorkflowStatus {
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  return shell.status === "idle" ? "idle" : runStatus(shell.status);
}

function firstLine(text: string | null | undefined): string | null {
  const line = text?.trim().split("\n", 1)[0]?.trim();
  return line ? line : null;
}

interface Context {
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly visited: Set<ThreadId>;
}

function workspaceOf(
  context: Context,
  threadId: ThreadId | null,
  parentWorktreePath: string | null,
): {
  readonly branch: string | null;
  readonly isolated: boolean;
  readonly worktreePath: string | null;
} {
  const shell = threadId === null ? undefined : context.threadsById.get(threadId);
  const worktreePath = shell?.worktreePath ?? null;
  const isolated = worktreePath !== null && worktreePath !== parentWorktreePath;
  return { branch: isolated ? (shell?.branch ?? null) : null, isolated, worktreePath };
}

/** Sub-agent threads started from `threadId`, found through the loaded thread family. */
function threadChildren(
  context: Context,
  threadId: ThreadId | null,
  worktreePath: string | null,
  claimed: ReadonlySet<ThreadId>,
): ReadonlyArray<WorkflowAgent> {
  if (threadId === null || context.visited.has(threadId)) return [];
  context.visited.add(threadId);
  return (context.childrenByParent.get(threadId) ?? [])
    .filter((shell) => !claimed.has(shell.id))
    .map((shell) => shellAgent(context, shell, worktreePath));
}

function shellAgent(
  context: Context,
  shell: OrchestrationV2ThreadShell,
  parentWorktreePath: string | null,
): WorkflowAgent {
  const workspace = workspaceOf(context, shell.id, parentWorktreePath);
  return {
    id: `thread:${shell.id}`,
    threadId: shell.id,
    title: shell.title,
    task: null,
    driver: null,
    providerInstanceId: shell.providerInstanceId,
    model: shell.modelSelection.model,
    status: shellStatus(shell),
    progress: null,
    startedAt: iso(shell.latestRunStartedAt ?? null),
    completedAt: iso(shell.latestRunCompletedAt ?? null),
    branch: workspace.branch,
    isolated: workspace.isolated,
    children: threadChildren(context, shell.id, workspace.worktreePath, new Set()),
    phases: [],
  };
}

function workflowPhases(subagent: OrchestrationV2Subagent, coordinatorStatus: WorkflowStatus) {
  const agents = subagent.workflow?.agents ?? [];
  const phaseTitles = new Map(
    (subagent.workflow?.phases ?? []).map((phase) => [phase.index, phase.title]),
  );
  const byPhase = new Map<number, WorkflowAgent[]>();
  for (const agent of agents) {
    // A queued or running member of a finished coordinator ended with it.
    const settled = !workflowStatusIsActive(coordinatorStatus);
    const status: WorkflowStatus =
      agent.state === "queued"
        ? settled
          ? coordinatorStatus
          : "pending"
        : agent.state === "running" && settled
          ? coordinatorStatus
          : agent.state;
    const phaseIndex = agent.phaseIndex ?? 0;
    const member: WorkflowAgent = {
      id: `${subagent.id}:agent:${agent.index}`,
      threadId: agent.childThreadId ?? null,
      title: agent.label,
      task: firstLine(agent.prompt),
      driver: subagent.driver,
      providerInstanceId: subagent.providerInstanceId,
      model: agent.model ?? null,
      status,
      progress: null,
      startedAt: isoFromEpochMillis(agent.startedAt),
      completedAt: isoFromEpochMillis(agent.completedAt),
      branch: null,
      isolated: false,
      children: [],
      phases: [],
    };
    byPhase.set(phaseIndex, [...(byPhase.get(phaseIndex) ?? []), member]);
  }
  return [...byPhase.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, members]) => ({
      index,
      title: phaseTitles.get(index) ?? members[0]?.title ?? `Phase ${index + 1}`,
      agents: members,
    }));
}

function subagentTree(
  context: Context,
  subagent: OrchestrationV2Subagent,
  nativeChildren: ReadonlyMap<string, ReadonlyArray<OrchestrationV2Subagent>>,
  parentWorktreePath: string | null,
): WorkflowAgent {
  const status = subagentStatus(subagent.status);
  const workspace = workspaceOf(context, subagent.childThreadId, parentWorktreePath);
  const native = (nativeChildren.get(subagent.id) ?? []).map((child) =>
    subagentTree(context, child, nativeChildren, workspace.worktreePath ?? parentWorktreePath),
  );
  const claimed = new Set(
    (subagent.workflow?.agents ?? []).flatMap((agent) =>
      agent.childThreadId === undefined ? [] : [agent.childThreadId],
    ),
  );
  return {
    id: subagent.id,
    threadId: subagent.childThreadId,
    title: subagent.title?.trim() || firstLine(subagent.prompt) || "Sub-agent",
    task: firstLine(subagent.prompt),
    driver: subagent.driver,
    providerInstanceId: subagent.providerInstanceId,
    model: subagent.modelSelection?.model ?? subagent.model,
    status,
    progress: firstLine(subagent.progress),
    startedAt: iso(subagent.startedAt),
    completedAt: iso(subagent.completedAt),
    branch: workspace.branch,
    isolated: workspace.isolated,
    children: [
      ...native,
      ...threadChildren(
        context,
        subagent.childThreadId,
        workspace.worktreePath ?? parentWorktreePath,
        claimed,
      ),
    ],
    phases: subagent.workflow ? workflowPhases(subagent, status) : [],
  };
}

function mergeStatus(run: OrchestrationV2Run, agents: ReadonlyArray<WorkflowAgent>) {
  if (agents.length === 0) return null;
  if (agents.some((agent) => workflowStatusIsActive(agent.status))) return "pending";
  const status = runStatus(run.status);
  return workflowStatusIsActive(status) ? "running" : status;
}

/**
 * Every run in the thread as a workflow: the prompt, the main agent, the agents it delegated to
 * (nested through child threads in the loaded thread family), the merge, and the review state.
 * Rolled-back runs are left out, matching the rest of the thread UI.
 */
export function deriveWorkflowRuns(input: {
  readonly projection: Projection;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}): ReadonlyArray<WorkflowRun> {
  const { projection } = input;
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const thread of input.threads) {
    const parent = thread.lineage.parentThreadId;
    if (parent === null || thread.lineage.relationshipToParent !== "subagent") continue;
    if (thread.archivedAt !== null) continue;
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), thread]);
  }
  const context: Context = {
    threadsById,
    childrenByParent,
    visited: new Set([projection.thread.id]),
  };
  const messageText = new Map(projection.messages.map((message) => [message.id, message.text]));
  const subagentIds = new Set(projection.subagents.map((subagent) => subagent.id));
  const nativeChildren = new Map<string, OrchestrationV2Subagent[]>();
  for (const subagent of projection.subagents) {
    if (!subagentIds.has(subagent.parentNodeId)) continue;
    nativeChildren.set(subagent.parentNodeId, [
      ...(nativeChildren.get(subagent.parentNodeId) ?? []),
      subagent,
    ]);
  }
  const ordered = [...projection.runs]
    .filter((run) => run.status !== "rolled_back")
    .sort((left, right) => left.ordinal - right.ordinal);
  const latest = ordered.at(-1);
  const pullRequestNumber = projection.thread.linkedPullRequest?.number ?? null;
  const threadWorktreePath = projection.thread.worktreePath;

  return ordered.map((run) => {
    const agents = projection.subagents
      .filter((subagent) => subagent.runId === run.id && !subagentIds.has(subagent.parentNodeId))
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) -
            DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .map((subagent) => subagentTree(context, subagent, nativeChildren, threadWorktreePath));
    const status = runStatus(run.status);
    const review: WorkflowRun["review"] = workflowStatusIsActive(status)
      ? { status: "pending", pullRequestNumber: null }
      : status === "completed"
        ? { status: "completed", pullRequestNumber: run === latest ? pullRequestNumber : null }
        : { status, pullRequestNumber: null };
    return {
      id: run.id,
      ordinal: run.ordinal,
      prompt: firstLine(messageText.get(run.userMessageId)) ?? `Run ${run.ordinal}`,
      status,
      providerInstanceId: run.providerInstanceId,
      model: run.modelSelection.model,
      startedAt: iso(run.startedAt),
      completedAt: iso(run.completedAt),
      agents,
      merge: mergeStatus(run, agents),
      review,
    };
  });
}

/** Agents anywhere in the chart, for counts in the panel header and the toggle's live dot. */
export function summarizeWorkflowRuns(runs: ReadonlyArray<WorkflowRun>): {
  readonly agentCount: number;
  readonly working: number;
  readonly waiting: number;
} {
  let agentCount = 0;
  let working = 0;
  let waiting = 0;
  const visit = (agent: WorkflowAgent) => {
    agentCount += 1;
    if (agent.status === "waiting") waiting += 1;
    else if (workflowStatusIsActive(agent.status)) working += 1;
    agent.children.forEach(visit);
    agent.phases.forEach((phase) => phase.agents.forEach(visit));
  };
  for (const run of runs) run.agents.forEach(visit);
  return { agentCount, working, waiting };
}
