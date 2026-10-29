import {
  isProviderNativeSubagentThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  type NodeId,
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

export interface WorkflowTokenUsage {
  readonly totalTokens: number;
  readonly complete: boolean;
}

export interface WorkflowAgent {
  readonly id: string;
  readonly control: {
    readonly threadId: ThreadId;
    readonly subagentId: NodeId | null;
    readonly workflow?: boolean;
  } | null;
  /** The thread the agent works in, when it has its own. Opening the node opens this thread. */
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly task: string | null;
  readonly driver: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly tokenUsage: WorkflowTokenUsage | null;
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
  readonly mainTokenUsage: WorkflowTokenUsage | null;
  readonly tokenUsage: WorkflowTokenUsage | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly agents: ReadonlyArray<WorkflowAgent>;
  /** The main agent combining its agents' results. Null for a run that delegated nothing. */
  readonly merge: WorkflowStatus | null;
  readonly review: {
    readonly status: WorkflowStatus;
    readonly pullRequestNumber: number | null;
  } | null;
}

interface Projection extends Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "messages" | "checkpoints" | "attempts" | "providerTurns"
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

function sumTokenUsage(
  entries: ReadonlyArray<WorkflowTokenUsage | null>,
): WorkflowTokenUsage | null {
  const reported = entries.filter((entry) => entry !== null);
  if (reported.length === 0) return null;
  return {
    totalTokens: reported.reduce((total, entry) => total + entry.totalTokens, 0),
    complete: reported.length === entries.length && reported.every((entry) => entry.complete),
  };
}

function providerTokenUsage(turns: Projection["providerTurns"]): WorkflowTokenUsage | null {
  return sumTokenUsage(
    turns.map((turn) => {
      const usage = turn.turnTokenUsage;
      if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) return null;
      return {
        totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        complete: usage?.usageStatus === "complete",
      };
    }),
  );
}

function runTokenUsage(projection: Projection, run: OrchestrationV2Run) {
  const roots = new Set([
    run.rootNodeId,
    ...projection.attempts
      .filter((attempt) => attempt.runId === run.id)
      .map((attempt) => attempt.rootNodeId),
  ]);
  return providerTokenUsage(projection.providerTurns.filter((turn) => roots.has(turn.nodeId)));
}

function agentWithTokenUsage(
  agent: WorkflowAgent,
  owner: Projection,
  projectionForThread: (threadId: ThreadId) => Projection | null,
): WorkflowAgent {
  const source = owner.subagents.find((entry) => entry.id === agent.id);
  const child = agent.threadId === null ? null : projectionForThread(agent.threadId);
  const childRuns = child?.runs.filter((run) => run.status !== "rolled_back") ?? [];
  const delegatedRuns =
    source === undefined ? [] : childRuns.filter((run) => run.delegatedTaskId === source.id);
  const firstRun = [...childRuns].sort((left, right) => left.ordinal - right.ordinal)[0];
  const ownUsage =
    agent.tokenUsage ??
    (child !== null
      ? sumTokenUsage(
          (delegatedRuns.length > 0 ? delegatedRuns : firstRun ? [firstRun] : []).map((run) =>
            runTokenUsage(child, run),
          ),
        )
      : providerTokenUsage(owner.providerTurns.filter((turn) => turn.nodeId === source?.id)));
  const descendantOwner = (entry: WorkflowAgent) =>
    owner.subagents.some((subagent) => subagent.id === entry.id) ? owner : (child ?? owner);
  const children = agent.children.map((entry) =>
    agentWithTokenUsage(entry, descendantOwner(entry), projectionForThread),
  );
  const phases = agent.phases.map((phase) => ({
    ...phase,
    agents: phase.agents.map((entry) =>
      agentWithTokenUsage(entry, descendantOwner(entry), projectionForThread),
    ),
  }));
  const descendants = [...children, ...phases.flatMap((phase) => phase.agents)];
  return {
    ...agent,
    children,
    phases,
    tokenUsage:
      source?.workflow?.totalTokens !== undefined
        ? { totalTokens: source.workflow.totalTokens, complete: true }
        : sumTokenUsage([
            ...(source?.workflow !== undefined && ownUsage === null ? [] : [ownUsage]),
            ...descendants.map((entry) => entry.tokenUsage),
          ]),
  };
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
    control: isProviderNativeSubagentThread(shell)
      ? null
      : { threadId: shell.id, subagentId: null },
    threadId: shell.id,
    title: shell.title,
    task: null,
    driver: null,
    providerInstanceId: shell.providerInstanceId,
    model: shell.modelSelection.model,
    tokenUsage: null,
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
      control: null,
      threadId: agent.childThreadId ?? null,
      title: agent.label,
      task: firstLine(agent.prompt),
      driver: subagent.driver,
      providerInstanceId: subagent.providerInstanceId,
      model: agent.model ?? null,
      tokenUsage:
        agent.totalTokens === undefined ? null : { totalTokens: agent.totalTokens, complete: true },
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
  const child =
    subagent.childThreadId === null ? undefined : context.threadsById.get(subagent.childThreadId);
  const childStatus = child === undefined ? null : shellStatus(child);
  const status =
    subagent.origin === "app_owned" && childStatus !== null && workflowStatusIsActive(childStatus)
      ? childStatus
      : subagentStatus(subagent.status);
  const workspace = workspaceOf(context, subagent.childThreadId, parentWorktreePath);
  const workflow =
    subagent.origin === "provider_native" &&
    subagent.driver === "claudeAgent" &&
    subagent.workflow !== undefined;
  const canStop =
    workflow ||
    (subagent.origin === "app_owned" && subagent.childThreadId !== null) ||
    (subagent.origin === "provider_native" &&
      subagent.driver === "claudeAgent" &&
      subagent.nativeTaskRef?.strength === "strong" &&
      subagent.nativeTaskRef.nativeId !== null);
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
    control:
      canStop &&
      subagent.runId !== null &&
      (subagent.workflow === undefined || subagent.status === "running")
        ? {
            threadId: subagent.threadId,
            subagentId: subagent.id,
            ...(workflow ? { workflow: true } : {}),
          }
        : null,
    threadId: subagent.childThreadId,
    title: subagent.title?.trim() || firstLine(subagent.prompt) || "Sub-agent",
    task: firstLine(subagent.prompt),
    driver: subagent.driver,
    providerInstanceId: subagent.providerInstanceId,
    model: subagent.modelSelection?.model ?? subagent.model,
    tokenUsage: null,
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
  readonly projectionForThread?: (threadId: ThreadId) => Projection | null;
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
  const changedCheckpoints = new Set(
    projection.checkpoints
      .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.files.length > 0)
      .map((checkpoint) => checkpoint.id),
  );

  return ordered.map((run) => {
    const agents = projection.subagents
      .filter((subagent) => subagent.runId === run.id && !subagentIds.has(subagent.parentNodeId))
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) -
            DateTime.toEpochMillis(right.startedAt ?? right.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .map((subagent) =>
        agentWithTokenUsage(
          subagentTree(context, subagent, nativeChildren, threadWorktreePath),
          projection,
          input.projectionForThread ?? (() => null),
        ),
      );
    const mainTokenUsage = runTokenUsage(projection, run);
    const status = runStatus(run.status);
    const runPullRequest = run === latest ? pullRequestNumber : null;
    const hasChanges = run.checkpointId !== null && changedCheckpoints.has(run.checkpointId);
    const review: WorkflowRun["review"] =
      hasChanges || runPullRequest !== null
        ? { status: "completed", pullRequestNumber: runPullRequest }
        : null;
    return {
      id: run.id,
      ordinal: run.ordinal,
      prompt: firstLine(messageText.get(run.userMessageId)) ?? `Run ${run.ordinal}`,
      status,
      providerInstanceId: run.providerInstanceId,
      model: run.modelSelection.model,
      mainTokenUsage,
      tokenUsage: sumTokenUsage([mainTokenUsage, ...agents.map((agent) => agent.tokenUsage)]),
      startedAt: iso(run.startedAt),
      completedAt: iso(run.completedAt),
      agents,
      merge: mergeStatus(run, agents),
      review,
    };
  });
}

export function visibleWorkflowRuns(
  runs: ReadonlyArray<WorkflowRun>,
  latestRunOnly: boolean,
): ReadonlyArray<WorkflowRun> {
  if (!latestRunOnly || runs.length < 2) return runs;
  return [runs.reduce((latest, run) => (run.ordinal > latest.ordinal ? run : latest))];
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
