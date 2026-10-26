import type { WorkflowAgent, WorkflowRun } from "@t3tools/client-runtime/state/workflow-runs";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeRuns,
  buildWorkflowRunGraph,
  tidyLayoutRun,
  WORKFLOW_NODE_SIZE,
  workflowGraphShapeKey,
  type RunLayout,
  type WorkflowRunGraph,
} from "./workflowGraph";

function agent(id: string, overrides: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    id,
    threadId: null,
    title: id,
    task: null,
    driver: null,
    providerInstanceId: null,
    model: null,
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
