import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveWorkflowRuns, summarizeWorkflowRuns } from "./workflowRuns.ts";

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
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly thread?: Partial<typeof v2Projection.thread>;
}) {
  return deriveWorkflowRuns({
    projection: {
      thread: { ...v2Projection.thread, ...input.thread },
      runs: input.runs,
      subagents: input.subagents ?? [],
      messages: input.messages ?? [],
    },
    threads: [v2ThreadShell, ...(input.threads ?? [])],
  });
}

describe("deriveWorkflowRuns", () => {
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
      { status: "completed", pullRequestNumber: null },
      { status: "pending", pullRequestNumber: null },
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
