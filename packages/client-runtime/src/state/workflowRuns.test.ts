import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveWorkflowRuns, summarizeWorkflowRuns, visibleWorkflowRuns } from "./workflowRuns.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function run(
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: NodeId.make(`root-${id}`),
    activeAttemptId: null,
    status,
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function message(runId: string, text: string) {
  return {
    id: MessageId.make(`message-${runId}`),
    threadId: v2Projection.thread.id,
    runId: RunId.make(runId),
    nodeId: null,
    role: "user" as const,
    text,
  } as unknown as (typeof v2Projection.messages)[number];
}

function providerTurn(
  id: string,
  nodeId: string,
  usage: (typeof v2Projection.providerTurns)[number]["turnTokenUsage"],
): (typeof v2Projection.providerTurns)[number] {
  return {
    id: ProviderTurnId.make(id),
    providerThreadId: ProviderThreadId.make(`thread-${id}`),
    nodeId: NodeId.make(nodeId),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: v2Now,
    completedAt: v2Now,
    ...(usage === undefined ? {} : { turnTokenUsage: usage }),
  };
}

const completeUsage = (inputTokens: number, outputTokens: number) => ({
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  inputTokens,
  outputTokens,
  hasSubagents: false,
});

function subagent(
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: v2Projection.thread.id,
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root-run-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: `${id} task\nmore detail`,
    title: id,
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:01.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...overrides,
  };
}

function childShell(
  id: string,
  parentThreadId: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    lineage: {
      rootThreadId: v2ThreadShell.id,
      parentThreadId,
      relationshipToParent: "subagent",
    },
    ...overrides,
  };
}

function derive(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly messages?: typeof v2Projection.messages;
  readonly checkpoints?: typeof v2Projection.checkpoints;
  readonly attempts?: typeof v2Projection.attempts;
  readonly providerTurns?: typeof v2Projection.providerTurns;
  readonly projectionForThread?: Parameters<typeof deriveWorkflowRuns>[0]["projectionForThread"];
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly thread?: Partial<typeof v2Projection.thread>;
}) {
  return deriveWorkflowRuns({
    projection: {
      thread: { ...v2Projection.thread, ...input.thread },
      runs: input.runs,
      subagents: input.subagents ?? [],
      messages: input.messages ?? [],
      checkpoints: input.checkpoints ?? [],
      attempts: input.attempts ?? [],
      providerTurns: input.providerTurns ?? [],
    },
    threads: [v2ThreadShell, ...(input.threads ?? [])],
    ...(input.projectionForThread ? { projectionForThread: input.projectionForThread } : {}),
  });
}

describe("deriveWorkflowRuns", () => {
  it("sums consumption by run without counting cache or reasoning subsets twice", () => {
    const runs = derive({
      runs: [run("run-1", 1, "completed"), run("run-2", 2, "running")],
      providerTurns: [
        providerTurn("first", "root-run-1", {
          ...completeUsage(1000, 200),
          cachedInputTokens: 800,
          cacheCreationTokens: 100,
          reasoningTokens: 50,
        }),
        providerTurn("second", "root-run-1", completeUsage(500, 100)),
        providerTurn("other-run", "root-run-2", completeUsage(20, 10)),
      ],
    });
    expect(runs.map((entry) => entry.tokenUsage)).toEqual([
      { totalTokens: 1800, complete: true },
      { totalTokens: 30, complete: true },
    ]);
    expect(runs[0]?.mainTokenUsage).toEqual(runs[0]?.tokenUsage);
  });

  it("distinguishes zero consumption from unknown and partial reports", () => {
    const entry = { runs: [run("run-1", 1, "running")] };
    expect(derive(entry)[0]?.tokenUsage).toBeNull();
    expect(
      derive({
        ...entry,
        providerTurns: [
          {
            ...providerTurn("context-only", "root-run-1", undefined),
            tokenUsage: { usedTokens: 9000, updatedAt: "2026-06-20T00:00:00Z" },
          },
        ],
      })[0]?.tokenUsage,
    ).toBeNull();
    expect(
      derive({
        ...entry,
        providerTurns: [providerTurn("zero", "root-run-1", completeUsage(0, 0))],
      })[0]?.tokenUsage,
    ).toEqual({ totalTokens: 0, complete: true });
    expect(
      derive({
        ...entry,
        providerTurns: [
          providerTurn("reported", "root-run-1", completeUsage(100, 20)),
          providerTurn("missing", "root-run-1", undefined),
        ],
      })[0]?.tokenUsage,
    ).toEqual({ totalTokens: 120, complete: false });
    expect(
      derive({
        ...entry,
        providerTurns: [
          providerTurn("partial", "root-run-1", {
            usageScope: "main_agent",
            usageStatus: "partial",
            inputTokens: 25,
            hasSubagents: false,
          }),
        ],
      })[0]?.tokenUsage,
    ).toEqual({ totalTokens: 25, complete: false });
  });

  it("includes each retry attempt's root consumption without counting native agents as main usage", () => {
    const parentRun = run("run-1", 1, "completed");
    const attempt = {
      id: RunAttemptId.make("retry"),
      runId: parentRun.id,
      nativeThreadId: "retry-thread",
      attemptOrdinal: 2,
      rootNodeId: NodeId.make("retry-root"),
      providerInstanceId: parentRun.providerInstanceId,
      providerThreadId: ProviderThreadId.make("retry-thread"),
      providerTurnId: ProviderTurnId.make("retry-turn"),
      reason: "retry" as const,
      status: "completed" as const,
      startedAt: v2Now,
      completedAt: v2Now,
    };
    const [entry] = derive({
      runs: [parentRun],
      attempts: [attempt],
      subagents: [subagent("native")],
      providerTurns: [
        providerTurn("first", "root-run-1", completeUsage(100, 20)),
        providerTurn("retry-turn", "retry-root", completeUsage(200, 30)),
        providerTurn("native-turn", "native", completeUsage(400, 50)),
      ],
    });
    expect(entry?.mainTokenUsage).toEqual({ totalTokens: 350, complete: true });
    expect(entry?.tokenUsage).toEqual({ totalTokens: 800, complete: true });
  });

  it("uses only the delegated child run, not later unrelated turns", () => {
    const task = subagent("alpha", { childThreadId: ThreadId.make("child") });
    const childRun = { ...run("child-run", 1, "completed"), delegatedTaskId: task.id };
    const childProjection = {
      ...v2Projection,
      runs: [childRun, run("later", 2, "completed")],
      providerTurns: [
        providerTurn("child", "root-child-run", completeUsage(200, 50)),
        providerTurn("later", "root-later", completeUsage(9000, 1000)),
      ],
    };
    const [entry] = derive({
      runs: [run("run-1", 1, "completed")],
      subagents: [task],
      providerTurns: [providerTurn("main", "root-run-1", completeUsage(100, 20))],
      projectionForThread: (id) => (id === task.childThreadId ? childProjection : null),
    });
    expect(entry?.agents[0]?.tokenUsage).toEqual({ totalTokens: 250, complete: true });
    expect(entry?.tokenUsage).toEqual({ totalTokens: 370, complete: true });
  });

  it("rolls up nested agents once and marks totals partial when an agent has no report", () => {
    const [entry] = derive({
      runs: [run("run-1", 1, "completed")],
      subagents: [
        subagent("parent"),
        subagent("nested", { parentNodeId: NodeId.make("parent") }),
        subagent("unknown"),
      ],
      providerTurns: [
        providerTurn("main", "root-run-1", completeUsage(100, 10)),
        providerTurn("parent", "parent", completeUsage(200, 20)),
        providerTurn("nested", "nested", completeUsage(300, 30)),
      ],
    });
    expect(entry?.agents[0]?.tokenUsage).toEqual({ totalTokens: 550, complete: true });
    expect(entry?.agents[0]?.children[0]?.tokenUsage).toEqual({ totalTokens: 330, complete: true });
    expect(entry?.agents[1]?.tokenUsage).toBeNull();
    expect(entry?.tokenUsage).toEqual({ totalTokens: 660, complete: false });
  });

  it("uses authoritative workflow totals without summing their members again", () => {
    const [entry] = derive({
      runs: [run("run-1", 1, "completed")],
      subagents: [
        subagent("flow", {
          workflow: {
            phases: [],
            totalTokens: 500,
            agents: [
              { index: 0, label: "First" as never, state: "completed", totalTokens: 200 },
              { index: 1, label: "Second" as never, state: "completed", totalTokens: 300 },
            ],
          },
        }),
      ],
      providerTurns: [providerTurn("main", "root-run-1", completeUsage(100, 20))],
    });
    expect(entry?.agents[0]?.tokenUsage).toEqual({ totalTokens: 500, complete: true });
    expect(
      entry?.agents[0]?.phases[0]?.agents.map((agent) => agent.tokenUsage?.totalTokens),
    ).toEqual([200, 300]);
    expect(entry?.tokenUsage).toEqual({ totalTokens: 620, complete: true });
  });

  it("falls back to workflow member reports and marks missing members partial", () => {
    const [entry] = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("flow", {
          workflow: {
            phases: [],
            agents: [
              { index: 0, label: "First" as never, state: "completed", totalTokens: 200 },
              { index: 1, label: "Second" as never, state: "running" },
            ],
          },
        }),
      ],
      providerTurns: [providerTurn("main", "root-run-1", completeUsage(100, 20))],
    });
    expect(entry?.agents[0]?.tokenUsage).toEqual({ totalTokens: 200, complete: false });
    expect(entry?.tokenUsage).toEqual({ totalTokens: 320, complete: false });
  });

  it("shows review only for this run's ready non-empty checkpoint", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const completed = { ...run("run-1", 1, "completed"), checkpointId };
    const checkpoint: (typeof v2Projection.checkpoints)[number] = {
      id: checkpointId,
      threadId: v2Projection.thread.id,
      scopeId: CheckpointScopeId.make("scope-1"),
      runId: completed.id,
      nodeId: NodeId.make("root-run-1"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      ref: CheckpointRef.make("refs/t3/checkpoint-1"),
      status: "ready",
      files: [{ path: "app.ts", kind: "modified", additions: 1, deletions: 0 }],
      capturedAt: v2Now,
    };
    expect(derive({ runs: [completed], checkpoints: [checkpoint] })[0]?.review).toEqual({
      status: "completed",
      pullRequestNumber: null,
    });
    expect(
      derive({ runs: [completed], checkpoints: [{ ...checkpoint, files: [] }] })[0]?.review,
    ).toBeNull();
    expect(
      derive({ runs: [completed], checkpoints: [{ ...checkpoint, status: "error" }] })[0]?.review,
    ).toBeNull();
    expect(
      derive({ runs: [run("run-2", 2, "completed")], checkpoints: [checkpoint] })[0]?.review,
    ).toBeNull();
  });

  it("shows a resumed child as working even after its original task ended", () => {
    const child = childShell("resumed", v2Projection.thread.id, { status: "running" });
    const entries = derive({
      runs: [run("run-1", 1, "completed")],
      subagents: [subagent("alpha", { status: "completed", childThreadId: child.id })],
      threads: [child],
    });
    expect(entries[0]?.agents[0]?.status).toBe("running");
  });

  it("does not invent stop targets for unsupported provider-native agents", () => {
    const entries = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("native", { origin: "provider_native", driver: ProviderDriverKind.make("codex") }),
      ],
    });
    expect(entries[0]?.agents[0]?.control).toBeNull();
  });

  it("keeps strong native-task stop targets and the separate workflow stop capability", () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const entries = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("native", {
          origin: "provider_native",
          driver,
          nativeTaskRef: { driver, nativeId: "task-1", strength: "strong" },
        }),
        subagent("workflow", {
          origin: "provider_native",
          driver,
          workflow: { phases: [], agents: [] },
        }),
        subagent("waiting-workflow", {
          origin: "provider_native",
          driver,
          status: "waiting",
          workflow: { phases: [], agents: [] },
        }),
      ],
    });
    const controls = new Map(entries[0]?.agents.map((entry) => [entry.id, entry.control]));
    expect(controls.get("native")).toEqual({
      threadId: v2Projection.thread.id,
      subagentId: "native",
    });
    expect(controls.get("workflow")).toEqual({
      threadId: v2Projection.thread.id,
      subagentId: "workflow",
      workflow: true,
    });
    expect(controls.get("waiting-workflow")).toBeNull();
  });
  it("does not invent a review stage for conversations without changes or a PR", () => {
    const entries = derive({ runs: [run("run-1", 1, "completed")] });
    expect(entries[0]?.review).toBeNull();
  });

  it("keeps the owning thread and subagent identity for stopping nested agents", () => {
    const owner = ThreadId.make("nested-owner");
    const entries = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("alpha", { threadId: owner, childThreadId: ThreadId.make("nested-child") }),
      ],
    });
    expect(entries[0]?.agents[0]?.control).toEqual({
      threadId: owner,
      subagentId: NodeId.make("alpha"),
    });
  });
  it("lists every run in order with its prompt, and leaves out rolled-back runs", () => {
    const runs = derive({
      runs: [
        run("run-2", 2, "completed"),
        run("run-x", 3, "rolled_back"),
        run("run-1", 1, "completed"),
      ],
      messages: [message("run-1", "  Add rate limiting\nwith tests"), message("run-2", "Ship it")],
    });

    expect(runs.map((entry) => [entry.ordinal, entry.prompt])).toEqual([
      [1, "Add rate limiting"],
      [2, "Ship it"],
    ]);
    // A run that delegated nothing has no merge step.
    expect(runs[0]?.agents).toEqual([]);
    expect(runs[0]?.merge).toBeNull();
  });

  it("nests provider-native sub-agents under the sub-agent that started them", () => {
    const [entry] = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("beta", { startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent("alpha"),
        subagent("delta", { parentNodeId: NodeId.make("beta") }),
      ],
    });

    expect(entry?.agents.map((agent) => agent.id)).toEqual(["alpha", "beta"]);
    expect(entry?.agents[1]?.children.map((agent) => agent.id)).toEqual(["delta"]);
    expect(entry?.agents[0]?.task).toBe("alpha task");
  });

  it("follows child threads in the loaded family and marks isolated worktrees", () => {
    const childId = ThreadId.make("child");
    const [entry] = derive({
      thread: { worktreePath: "/repo" },
      runs: [run("run-1", 1, "running")],
      subagents: [subagent("alpha", { childThreadId: childId })],
      threads: [
        childShell("child", v2ThreadShell.id, { worktreePath: "/wt/alpha", branch: "t3/alpha" }),
        childShell("grandchild", childId, {
          worktreePath: "/wt/alpha",
          status: "running",
          pendingRuntimeRequest: {
            id: "request" as never,
            kind: "approval" as never,
            createdAt: v2Now,
          },
        }),
        childShell("archived", childId, { archivedAt: v2Now }),
      ],
    });

    const alpha = entry?.agents[0];
    expect(alpha?.isolated).toBe(true);
    expect(alpha?.branch).toBe("t3/alpha");
    // The grandchild shares its parent's worktree, so it is not marked isolated.
    expect(alpha?.children.map((agent) => [agent.threadId, agent.isolated, agent.status])).toEqual([
      [ThreadId.make("grandchild"), false, "waiting"],
    ]);
  });

  it("groups a workflow's agents by phase and settles queued members with the coordinator", () => {
    const [entry] = derive({
      runs: [run("run-1", 1, "completed")],
      subagents: [
        subagent("flow", {
          status: "completed",
          workflow: {
            phases: [
              { index: 0, title: "Research" as never },
              { index: 1, title: "Build" as never },
            ],
            agents: [
              { index: 1, label: "Build UI" as never, state: "queued", phaseIndex: 1 },
              { index: 0, label: "Scan code" as never, state: "completed", phaseIndex: 0 },
            ],
          },
        }),
      ],
    });

    expect(
      entry?.agents[0]?.phases.map((phase) => [
        phase.title,
        phase.agents.map((agent) => [agent.title, agent.status]),
      ]),
    ).toEqual([
      ["Research", [["Scan code", "completed"]]],
      ["Build", [["Build UI", "completed"]]],
    ]);
  });

  it("waits to merge until every agent settles, and shows the PR only on the latest run", () => {
    const pullRequest = {
      projectId: v2Projection.thread.projectId,
      repository: "acme/app",
      number: 42,
      url: "https://example.com/pr/42",
    } as never;
    const working = derive({
      thread: { linkedPullRequest: pullRequest },
      runs: [run("run-0", 1, "completed"), run("run-1", 2, "running")],
      subagents: [
        subagent("old", { runId: RunId.make("run-0"), status: "completed" }),
        subagent("alpha"),
      ],
    });
    expect(working.map((entry) => entry.merge)).toEqual(["completed", "pending"]);
    expect(working.map((entry) => entry.review)).toEqual([
      null,
      { status: "completed", pullRequestNumber: 42 },
    ]);

    const merging = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [subagent("alpha", { status: "completed" })],
    });
    expect(merging[0]?.merge).toBe("running");

    const done = derive({
      thread: { linkedPullRequest: pullRequest },
      runs: [run("run-1", 1, "completed")],
      subagents: [subagent("alpha", { status: "completed" })],
    });
    expect(done[0]?.review).toEqual({ status: "completed", pullRequestNumber: 42 });
  });
});

describe("visibleWorkflowRuns", () => {
  it("shows all history when off and the highest ordinal when on, regardless of status", () => {
    const runs = derive({
      runs: [run("first", 1, "running"), run("last", 3, "failed"), run("middle", 2, "completed")],
    });
    expect(visibleWorkflowRuns(runs, false)).toBe(runs);
    expect(visibleWorkflowRuns([...runs].reverse(), true)).toEqual([runs[2]]);
    expect(visibleWorkflowRuns(runs, false).length).toBe(3);
  });

  it("follows newly added runs without mutating the history", () => {
    const runs = derive({ runs: [run("first", 1, "completed"), run("second", 2, "running")] });
    expect(visibleWorkflowRuns(runs.slice(0, 1), true)).toEqual([runs[0]]);
    expect(visibleWorkflowRuns(runs, true)).toEqual([runs[1]]);
    expect(runs.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(visibleWorkflowRuns([], true)).toEqual([]);
  });
});

describe("summarizeWorkflowRuns", () => {
  it("counts agents at every depth", () => {
    const runs = derive({
      runs: [run("run-1", 1, "running")],
      subagents: [
        subagent("alpha"),
        subagent("beta", { status: "waiting" }),
        subagent("delta", { parentNodeId: NodeId.make("alpha"), status: "completed" }),
      ],
    });

    expect(summarizeWorkflowRuns(runs)).toEqual({ agentCount: 3, working: 1, waiting: 1 });
  });
});
