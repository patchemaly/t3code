import type {
  WorkflowAgent,
  WorkflowRun,
  WorkflowStatus,
} from "@t3tools/client-runtime/state/workflow-runs";

/**
 * The chart for one run, as nodes and edges, plus Option B's tidy layout: a vertical spine
 * (prompt, main agent, router, merge, review) with agents fanned out horizontally and nested
 * agents as sub-columns under their parent. Runs containing a multi-phase workflow are not trees
 * (each phase hands off to every agent in the next), so those go to ELK instead.
 */

export type WorkflowNodeKind =
  | "prompt"
  | "orchestrator"
  | "main"
  | "router"
  | "agent"
  | "worktree"
  | "collect"
  | "merge"
  | "review";

export type WorkflowGraphNode =
  | { readonly id: string; readonly kind: "prompt"; readonly run: WorkflowRun }
  | { readonly id: string; readonly kind: "orchestrator" }
  | { readonly id: string; readonly kind: "main"; readonly run: WorkflowRun }
  | { readonly id: string; readonly kind: "router" }
  | {
      readonly id: string;
      readonly kind: "agent";
      readonly agent: WorkflowAgent;
      readonly phase: string | null;
    }
  | { readonly id: string; readonly kind: "worktree"; readonly agent: WorkflowAgent }
  | { readonly id: string; readonly kind: "collect"; readonly agent: WorkflowAgent }
  | { readonly id: string; readonly kind: "merge"; readonly status: WorkflowStatus }
  | { readonly id: string; readonly kind: "review"; readonly run: WorkflowRun };

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  /** Leaves the source's right side for the target's left, on the same row. */
  readonly side?: boolean;
  /** Several edges converge on the target; they share one horizontal line just above it. */
  readonly join?: boolean;
}

export interface WorkflowRunGraph {
  readonly run: WorkflowRun;
  readonly nodes: ReadonlyArray<WorkflowGraphNode>;
  readonly edges: ReadonlyArray<WorkflowGraphEdge>;
  /** "tidy" for trees; "general" (ELK) when some node has several parents. */
  readonly layout: "tidy" | "general";
}

export const WORKFLOW_NODE_SIZE: Record<WorkflowNodeKind, { width: number; height: number }> = {
  prompt: { width: 260, height: 40 },
  orchestrator: { width: 150, height: 44 },
  main: { width: 232, height: 64 },
  router: { width: 210, height: 42 },
  agent: { width: 232, height: 68 },
  worktree: { width: 190, height: 28 },
  collect: { width: 170, height: 28 },
  merge: { width: 232, height: 46 },
  review: { width: 244, height: 48 },
};

const ids = (run: WorkflowRun) => {
  const prefix = `${run.id}:`;
  return {
    prompt: `${prefix}prompt`,
    orchestrator: `${prefix}orchestrator`,
    main: `${prefix}main`,
    router: `${prefix}router`,
    merge: `${prefix}merge`,
    review: `${prefix}review`,
    agent: (agent: WorkflowAgent) => `${prefix}agent:${agent.id}`,
    worktree: (agent: WorkflowAgent) => `${prefix}worktree:${agent.id}`,
    collect: (agent: WorkflowAgent) => `${prefix}collect:${agent.id}`,
  };
};

function agentHasPhases(agent: WorkflowAgent): boolean {
  return agent.phases.length > 1 || agent.children.some(agentHasPhases);
}

/** Agents fanned out under `agent`: a single-phase workflow is just a fan-out. */
function agentMembers(agent: WorkflowAgent): ReadonlyArray<WorkflowAgent> {
  return agent.phases.length === 1
    ? [...agent.phases[0]!.agents, ...agent.children]
    : agent.children;
}

/**
 * The tidy layout's columns. Multi-phase workflows normally go to ELK; if ELK fails to load, the
 * tidy layout still places every phase's agents, as one fan-out.
 */
function tidyMembers(agent: WorkflowAgent): ReadonlyArray<WorkflowAgent> {
  return agent.phases.length > 1
    ? [...agent.phases.flatMap((phase) => phase.agents), ...agent.children]
    : agentMembers(agent);
}

export function buildWorkflowRunGraph(run: WorkflowRun): WorkflowRunGraph {
  const id = ids(run);
  const nodes: WorkflowGraphNode[] = [];
  const edges: WorkflowGraphEdge[] = [];
  const edge = (source: string, target: string, extra: Partial<WorkflowGraphEdge> = {}) =>
    edges.push({ id: `${source}->${target}`, source, target, ...extra });
  const delegated = run.agents.length > 0;

  nodes.push({ id: id.prompt, kind: "prompt", run });
  if (delegated) {
    nodes.push({ id: id.orchestrator, kind: "orchestrator" });
    edge(id.prompt, id.orchestrator);
    edge(id.orchestrator, id.main, { side: true, label: "spawns thread" });
  } else {
    edge(id.prompt, id.main);
  }
  nodes.push({ id: id.main, kind: "main", run });

  /** Adds the agent's column and returns the node its result leaves from. */
  const addAgent = (agent: WorkflowAgent, phase: string | null): string => {
    const agentId = id.agent(agent);
    nodes.push({ id: agentId, kind: "agent", agent, phase });
    const phased = agent.phases.length > 1;
    const members = agentMembers(agent);
    const hasMembers = phased || members.length > 0;
    const end = agent.isolated ? id.worktree(agent) : hasMembers ? id.collect(agent) : agentId;
    let returned = 0;
    const returns = (from: string) =>
      edge(from, end, { join: true, ...(returned++ === 0 ? { label: "returns" } : {}) });

    if (phased) {
      let previous: ReadonlyArray<string> = [agentId];
      for (const step of agent.phases) {
        const current = step.agents.map((member) => addAgent(member, step.title));
        for (const member of step.agents) {
          for (const from of previous) edge(from, id.agent(member));
        }
        previous = current;
      }
      previous.forEach(returns);
    }
    for (const member of members) {
      if (phased && agent.phases.some((step) => step.agents.includes(member))) continue;
      const memberEnd = addAgent(member, null);
      edge(agentId, id.agent(member), { label: "delegate_task()" });
      returns(memberEnd);
    }
    if (agent.isolated) {
      nodes.push({ id: end, kind: "worktree", agent });
      if (!hasMembers) edge(agentId, end);
    } else if (hasMembers) {
      nodes.push({ id: end, kind: "collect", agent });
    }
    return end;
  };

  if (delegated) {
    nodes.push({ id: id.router, kind: "router" });
    edge(id.main, id.router, { label: "delegate_task()" });
    run.agents.forEach((agent, index) => {
      const end = addAgent(agent, null);
      edge(id.router, id.agent(agent));
      edge(end, id.merge, { join: true, ...(index === 0 ? { label: "results" } : {}) });
    });
    nodes.push({ id: id.merge, kind: "merge", status: run.merge ?? "pending" });
    edge(id.merge, id.review);
  } else {
    edge(id.main, id.review);
  }
  nodes.push({ id: id.review, kind: "review", run });

  return {
    run,
    nodes,
    edges,
    layout: run.agents.some(agentHasPhases) ? "general" : "tidy",
  };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface RunLayout {
  readonly positions: ReadonlyMap<string, Point>;
  readonly width: number;
  readonly height: number;
}

const RUN_PADDING = 24;
const RUN_HEADER = 26;
export const COLUMN_GAP = 26;
export const ROW_GAP = 30;
const SIDE_GAP = 100;
const RUN_GAP = 40;

/** Puts the prompt above the orchestrator, left of the main agent, then frames the run. */
export function finishRunLayout(graph: WorkflowRunGraph, positions: Map<string, Point>): RunLayout {
  const id = ids(graph.run);
  const main = positions.get(id.main)!;
  const mainSize = WORKFLOW_NODE_SIZE.main;
  const promptSize = WORKFLOW_NODE_SIZE.prompt;
  if (graph.run.agents.length > 0) {
    const orchestratorSize = WORKFLOW_NODE_SIZE.orchestrator;
    const orchestrator = {
      x: main.x - orchestratorSize.width - SIDE_GAP,
      y: main.y + (mainSize.height - orchestratorSize.height) / 2,
    };
    positions.set(id.orchestrator, orchestrator);
    positions.set(id.prompt, {
      x: orchestrator.x + orchestratorSize.width / 2 - promptSize.width / 2 + 60,
      y: main.y - promptSize.height - ROW_GAP,
    });
  } else {
    positions.set(id.prompt, {
      x: main.x + mainSize.width / 2 - promptSize.width / 2,
      y: main.y - promptSize.height - ROW_GAP,
    });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of graph.nodes) {
    const point = positions.get(node.id);
    if (point === undefined) continue;
    const size = WORKFLOW_NODE_SIZE[node.kind];
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + size.width);
    maxY = Math.max(maxY, point.y + size.height);
  }
  const shifted = new Map<string, Point>();
  for (const [nodeId, point] of positions) {
    shifted.set(nodeId, {
      x: point.x - minX + RUN_PADDING,
      y: point.y - minY + RUN_PADDING + RUN_HEADER,
    });
  }
  return {
    positions: shifted,
    width: maxX - minX + RUN_PADDING * 2,
    height: maxY - minY + RUN_PADDING * 2 + RUN_HEADER,
  };
}

export function tidyLayoutRun(graph: WorkflowRunGraph): RunLayout {
  const { run } = graph;
  const id = ids(run);
  const positions = new Map<string, Point>();
  const size = WORKFLOW_NODE_SIZE;
  const endWidth = (agent: WorkflowAgent) =>
    agent.isolated ? size.worktree.width : tidyMembers(agent).length > 0 ? size.collect.width : 0;
  const widths = new Map<string, number>();
  const columnWidth = (agent: WorkflowAgent): number => {
    const known = widths.get(agent.id);
    if (known !== undefined) return known;
    const members = tidyMembers(agent);
    const membersWidth =
      members.reduce((total, member) => total + columnWidth(member), 0) +
      COLUMN_GAP * Math.max(0, members.length - 1);
    const width = Math.max(size.agent.width, endWidth(agent), membersWidth);
    widths.set(agent.id, width);
    return width;
  };
  /** Places the column and returns its bottom edge. */
  const place = (agent: WorkflowAgent, left: number, top: number): number => {
    const center = left + columnWidth(agent) / 2;
    positions.set(id.agent(agent), { x: center - size.agent.width / 2, y: top });
    let bottom = top + size.agent.height;
    const members = tidyMembers(agent);
    if (members.length > 0) {
      const membersWidth =
        members.reduce((total, member) => total + columnWidth(member), 0) +
        COLUMN_GAP * (members.length - 1);
      let x = left + (columnWidth(agent) - membersWidth) / 2;
      let membersBottom = 0;
      for (const member of members) {
        membersBottom = Math.max(membersBottom, place(member, x, bottom + ROW_GAP));
        x += columnWidth(member) + COLUMN_GAP;
      }
      bottom = membersBottom;
    }
    if (agent.isolated) {
      positions.set(id.worktree(agent), {
        x: center - size.worktree.width / 2,
        y: bottom + ROW_GAP,
      });
      bottom += ROW_GAP + size.worktree.height;
    } else if (members.length > 0) {
      positions.set(id.collect(agent), { x: center - size.collect.width / 2, y: bottom + ROW_GAP });
      bottom += ROW_GAP + size.collect.height;
    }
    return bottom;
  };

  const total =
    run.agents.reduce((sum, agent) => sum + columnWidth(agent), 0) +
    COLUMN_GAP * Math.max(0, run.agents.length - 1);
  const center = Math.max(total, size.main.width) / 2;
  const mainTop = 0;
  positions.set(id.main, { x: center - size.main.width / 2, y: mainTop });
  let bottom = mainTop + size.main.height;
  if (run.agents.length > 0) {
    const routerTop = bottom + ROW_GAP;
    positions.set(id.router, { x: center - size.router.width / 2, y: routerTop });
    const agentsTop = routerTop + size.router.height + ROW_GAP;
    let x = center - total / 2;
    let agentsBottom = agentsTop;
    for (const agent of run.agents) {
      agentsBottom = Math.max(agentsBottom, place(agent, x, agentsTop));
      x += columnWidth(agent) + COLUMN_GAP;
    }
    const mergeTop = agentsBottom + ROW_GAP + 6;
    positions.set(id.merge, { x: center - size.merge.width / 2, y: mergeTop });
    bottom = mergeTop + size.merge.height;
  }
  positions.set(id.review, { x: center - size.review.width / 2, y: bottom + ROW_GAP });
  return finishRunLayout(graph, positions);
}

export interface WorkflowLayoutGroup {
  readonly runId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Side by side for top and bottom docks, stacked for side docks. */
export function arrangeRuns(
  layouts: ReadonlyArray<{ readonly runId: string; readonly layout: RunLayout }>,
  horizontal: boolean,
): ReadonlyArray<WorkflowLayoutGroup> {
  let offset = 0;
  return layouts.map(({ runId, layout }) => {
    const group = {
      runId,
      x: horizontal ? offset : 0,
      y: horizontal ? 0 : offset,
      width: layout.width,
      height: layout.height,
    };
    offset += (horizontal ? layout.width : layout.height) + RUN_GAP;
    return group;
  });
}

/** Identifies a run's shape, so a status change reuses the cached layout. */
export function workflowGraphShapeKey(graph: WorkflowRunGraph): string {
  return [
    graph.nodes.map((node) => `${node.kind}:${node.id}`).join("|"),
    graph.edges.map((edge) => edge.id).join("|"),
  ].join("#");
}
