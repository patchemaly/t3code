import ELK from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";

import {
  COLUMN_GAP,
  finishRunLayout,
  ROW_GAP,
  WORKFLOW_NODE_SIZE,
  type Point,
  type RunLayout,
  type WorkflowRunGraph,
} from "./workflowGraph";

/**
 * Lays out runs the tidy layout cannot: phased workflows, where each phase hands off to every
 * agent in the next. This module is imported on demand, and ELK runs in a worker, so a user who
 * never has such a run never downloads it and layout never blocks the UI.
 */

let elk: InstanceType<typeof ELK> | null = null;

const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(ROW_GAP + 4),
  "elk.spacing.nodeNode": String(COLUMN_GAP),
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  // Keep agents in the order they started, like the tidy layout.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
};

export async function elkLayoutRun(graph: WorkflowRunGraph): Promise<RunLayout> {
  elk ??= new ELK({ workerUrl: elkWorkerUrl });
  // The prompt and orchestrator sit beside the main agent; finishRunLayout places them.
  const placed = graph.nodes.filter(
    (node) => node.kind !== "prompt" && node.kind !== "orchestrator",
  );
  const placedIds = new Set(placed.map((node) => node.id));
  const result = await elk.layout({
    id: graph.run.id,
    layoutOptions: LAYOUT_OPTIONS,
    children: placed.map((node) => ({ id: node.id, ...WORKFLOW_NODE_SIZE[node.kind] })),
    edges: graph.edges
      .filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map<string, Point>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return finishRunLayout(graph, positions);
}
