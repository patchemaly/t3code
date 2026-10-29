import type { WorkflowAgent, WorkflowRun } from "@t3tools/client-runtime/state/workflow-runs";
import { NodeId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  arrangeRuns,
  buildWorkflowRunGraph,
  initialViewport,
  tidyLayoutRun,
  WORKFLOW_NODE_SIZE,
  workflowGraphShapeKey,
  type RunLayout,
  type WorkflowRunGraph,
} from "./workflowGraph";
import { workflowNodeActions } from "./workflowNodeActions";

function agent(id: string, overrides: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    id,
    control: null,
    threadId: null,
    title: id,
    task: null,
    driver: null,
    providerInstanceId: null,
    model: null,
    tokenUsage: null,
    status: "running",
    progress: null,
    startedAt: null,
    completedAt: null,
    branch: null,
    isolated: false,
    children: [],
    phases: [],
    ...overrides,
  };
}

function run(
  agents: ReadonlyArray<WorkflowAgent>,
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id: RunId.make("run-1"),
    ordinal: 1,
    prompt: "Build it",
    status: "running",
    providerInstanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus",
    mainTokenUsage: null,
    tokenUsage: null,
    startedAt: null,
    completedAt: null,
    agents,
    merge: agents.length > 0 ? "pending" : null,
    review: { status: "pending", pullRequestNumber: null },
    ...overrides,
  };
}

const edgePairs = (graph: WorkflowRunGraph) =>
  graph.edges.map(
    (edge) =>
      `${edge.source.split(":").slice(1).join(":")} -> ${edge.target.split(":").slice(1).join(":")}`,
  );

function boxes(graph: WorkflowRunGraph, layout: RunLayout) {
  return graph.nodes.map((node) => {
    const point = layout.positions.get(node.id)!;
    const size = WORKFLOW_NODE_SIZE[node.kind];
    return {
      id: node.id,
      x: point.x,
      y: point.y,
      right: point.x + size.width,
      bottom: point.y + size.height,
    };
  });
}

describe("buildWorkflowRunGraph", () => {
  it("omits review nodes and edges when the run has nothing to review", () => {
    for (const agents of [[], [agent("alpha")]]) {
      const graph = buildWorkflowRunGraph(run(agents, { review: null }));
      expect(graph.nodes.some((node) => node.kind === "review")).toBe(false);
      expect(graph.edges.some((edge) => edge.target.endsWith(":review"))).toBe(false);
      expect(boxes(graph, tidyLayoutRun(graph)).every((box) => Number.isFinite(box.x))).toBe(true);
    }
  });
  it("charts a run that delegated nothing as prompt, main agent, review", () => {
    const graph = buildWorkflowRunGraph(run([]));

    expect(graph.nodes.map((node) => node.kind)).toEqual(["prompt", "main", "review"]);
    expect(edgePairs(graph)).toEqual(["prompt -> main", "main -> review"]);
    expect(graph.layout).toBe("tidy");
  });

  it("fans agents out from the router and joins their results at the merge", () => {
    const graph = buildWorkflowRunGraph(
      run([
        agent("alpha", { isolated: true, branch: "t3/alpha" }),
        agent("beta", { children: [agent("delta")] }),
      ]),
    );

    expect(edgePairs(graph)).toEqual([
      "prompt -> orchestrator",
      "orchestrator -> main",
      "main -> router",
      "agent:alpha -> worktree:alpha",
      "router -> agent:alpha",
      "worktree:alpha -> merge",
      "agent:beta -> agent:delta",
      "agent:delta -> collect:beta",
      "router -> agent:beta",
      "collect:beta -> merge",
      "merge -> review",
    ]);
    expect(graph.edges.find((edge) => edge.target.endsWith("main"))?.side).toBe(true);
    expect(
      graph.edges.filter((edge) => edge.target.endsWith("merge")).every((edge) => edge.join),
    ).toBe(true);
    expect(graph.layout).toBe("tidy");
  });

  it("hands each phase off to every agent in the next, which needs the general layout", () => {
    const graph = buildWorkflowRunGraph(
      run([
        agent("flow", {
          phases: [
            { index: 0, title: "Research", agents: [agent("a"), agent("b")] },
            { index: 1, title: "Build", agents: [agent("c")] },
          ],
        }),
      ]),
    );

    expect(edgePairs(graph).filter((pair) => pair.includes("agent:c"))).toEqual([
      "agent:a -> agent:c",
      "agent:b -> agent:c",
      "agent:c -> collect:flow",
    ]);
    expect(graph.layout).toBe("general");
  });

  it("keeps the same shape key when only statuses change", () => {
    const working = buildWorkflowRunGraph(run([agent("alpha")]));
    const done = buildWorkflowRunGraph(
      run([agent("alpha", { status: "completed" })], { status: "completed", merge: "completed" }),
    );
    const grown = buildWorkflowRunGraph(run([agent("alpha"), agent("beta")]));

    expect(workflowGraphShapeKey(done)).toBe(workflowGraphShapeKey(working));
    expect(workflowGraphShapeKey(grown)).not.toBe(workflowGraphShapeKey(working));
  });
});

describe("tidyLayoutRun", () => {
  it("places agents left to right in order, children under their parent, with no overlaps", () => {
    const graph = buildWorkflowRunGraph(
      run([
        agent("alpha", { isolated: true }),
        agent("beta", { children: [agent("delta"), agent("epsilon")] }),
        agent("gamma"),
      ]),
    );
    const layout = tidyLayoutRun(graph);
    const placed = boxes(graph, layout);
    const at = (suffix: string) => placed.find((box) => box.id.endsWith(suffix))!;

    expect(at("agent:alpha").x).toBeLessThan(at("agent:beta").x);
    expect(at("agent:beta").x).toBeLessThan(at("agent:gamma").x);
    expect(at("agent:delta").y).toBeGreaterThan(at("agent:beta").bottom);
    expect(at("collect:beta").y).toBeGreaterThan(at("agent:delta").bottom);
    expect(at("merge").y).toBeGreaterThan(at("collect:beta").bottom);
    // The orchestrator sits beside the main agent, on the same row.
    expect(at("orchestrator").right).toBeLessThan(at("main").x);
    for (const [index, box] of placed.entries()) {
      for (const other of placed.slice(index + 1)) {
        const overlaps =
          box.x < other.right &&
          other.x < box.right &&
          box.y < other.bottom &&
          other.y < box.bottom;
        expect(overlaps, `${box.id} overlaps ${other.id}`).toBe(false);
      }
    }
    for (const box of placed) {
      expect(box.right).toBeLessThanOrEqual(layout.width);
      expect(box.bottom).toBeLessThanOrEqual(layout.height);
    }
  });

  it("still places every phase's agents if the general layout is unavailable", () => {
    const graph = buildWorkflowRunGraph(
      run([
        agent("flow", {
          phases: [
            { index: 0, title: "Research", agents: [agent("a")] },
            { index: 1, title: "Build", agents: [agent("b")] },
          ],
        }),
      ]),
    );
    const layout = tidyLayoutRun(graph);

    expect(graph.nodes.every((node) => layout.positions.has(node.id))).toBe(true);
  });
});

describe("arrangeRuns", () => {
  const layout = (width: number, height: number): RunLayout => ({
    positions: new Map(),
    width,
    height,
  });

  it("puts runs side by side for top and bottom docks, and stacks them for side docks", () => {
    const runs = [
      { runId: "a", layout: layout(300, 200) },
      { runId: "b", layout: layout(400, 100) },
    ];

    expect(arrangeRuns(runs, true).map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [340, 0],
    ]);
    expect(arrangeRuns(runs, false).map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [0, 240],
    ]);
  });
});

describe("initialViewport", () => {
  const group = { x: 400, y: 0, width: 600, height: 500 };

  it("centers a run that fits at full size", () => {
    expect(initialViewport(group, { width: 1000, height: 800 })).toEqual({
      x: -200,
      y: 150,
      zoom: 1,
    });
  });

  it("shrinks a run to fit, but keeps it readable and shows a tall run from its top", () => {
    expect(initialViewport(group, { width: 1000, height: 424 }).zoom).toBe(0.8);
    const short = initialViewport(group, { width: 1000, height: 200 });
    expect(short.zoom).toBe(0.75);
    expect(short.y).toBe(12);
  });
});

describe("workflowNodeActions", () => {
  const parent = ThreadId.make("parent");
  const child = ThreadId.make("child");
  const idleThread = {
    status: "idle" as const,
    activeRunId: null,
    latestRunId: RunId.make("run-1"),
    lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
    creationSource: "web" as const,
    archivedAt: null,
    deletedAt: null,
  };

  it("runs idle app-owned agents in their child thread and stops through the owning task", () => {
    const member = agent("alpha", {
      threadId: child,
      control: { threadId: parent, subagentId: NodeId.make("alpha") },
      status: "completed",
    });
    const node = { id: "alpha", kind: "agent" as const, agent: member, phase: null };
    expect(workflowNodeActions(node, parent, idleThread)).toMatchObject({
      threadId: child,
      canRun: true,
      canStop: false,
      stopInput: { threadId: parent, subagentId: "alpha" },
    });
    expect(
      workflowNodeActions({ ...node, agent: { ...member, status: "running" } }, parent, idleThread),
    ).toMatchObject({ canRun: false, canStop: true });
  });

  it("does not stop another active run when inspecting history or a queued run", () => {
    const node = { id: "main", kind: "main" as const, run: run([]) };
    expect(
      workflowNodeActions(node, parent, {
        ...idleThread,
        status: "running",
        activeRunId: RunId.make("newer"),
        latestRunId: node.run.id,
      }).canStop,
    ).toBe(false);
    expect(
      workflowNodeActions(node, parent, {
        ...idleThread,
        status: "running",
        activeRunId: node.run.id,
      }).canStop,
    ).toBe(true);
    expect(workflowNodeActions(node, parent, idleThread).canRun).toBe(true);
  });

  it("allows new turns after terminal runs without offering to stop them", () => {
    const node = { id: "main", kind: "main" as const, run: run([]) };
    for (const status of [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(workflowNodeActions(node, parent, { ...idleThread, status })).toMatchObject({
        canRun: true,
        canStop: false,
      });
    }
  });

  it("does not offer unsupported native-member controls or messages to provider-owned threads", () => {
    const member = agent("native", { threadId: child, status: "completed" });
    const node = { id: "native", kind: "agent" as const, agent: member, phase: null };
    const nativeThread = {
      ...idleThread,
      creationSource: "provider" as const,
      lineage: {
        rootThreadId: parent,
        parentThreadId: parent,
        relationshipToParent: "subagent" as const,
      },
    };
    expect(workflowNodeActions(node, parent, nativeThread)).toMatchObject({
      canRun: false,
      canStop: false,
    });
    expect(
      workflowNodeActions(
        { ...node, agent: { ...member, status: "running" } },
        parent,
        nativeThread,
      ).canStop,
    ).toBe(false);
    expect(workflowNodeActions(node, parent, null).canRun).toBe(false);
    expect(
      workflowNodeActions({ id: "main", kind: "main", run: run([]) }, child, {
        ...nativeThread,
        status: "running",
        activeRunId: RunId.make("run-1"),
      }).canStop,
    ).toBe(false);
  });

  it("routes a workflow coordinator through its dedicated stop operation", () => {
    const node = {
      id: "flow",
      kind: "agent" as const,
      phase: null,
      agent: agent("flow", {
        control: { threadId: parent, subagentId: NodeId.make("flow"), workflow: true },
      }),
    };
    expect(workflowNodeActions(node, parent, null)).toMatchObject({
      canStop: true,
      canRun: false,
      stopWorkflowInput: { threadId: parent, subagentId: "flow" },
    });
  });

  it("does not restart archived threads or offer controls on informational stages", () => {
    const node = { id: "main", kind: "main" as const, run: run([]) };
    expect(
      workflowNodeActions(node, parent, {
        ...idleThread,
        archivedAt: DateTime.makeUnsafe("2026-10-26T00:00:00Z"),
      }).canRun,
    ).toBe(false);
    expect(workflowNodeActions({ id: "router", kind: "router" }, parent, idleThread)).toMatchObject(
      { canRun: false, canStop: false },
    );
  });
});
