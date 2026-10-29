import "@xyflow/react/dist/base.css";
import "./workflow.css";

import {
  type WorkflowAgent,
  type WorkflowRun,
  type WorkflowStatus,
  workflowStatusIsActive,
} from "@t3tools/client-runtime/state/workflow-runs";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type ReactFlowInstance,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitBranchIcon, MessageSquareIcon, Undo2Icon, WorkflowIcon } from "lucide-react";
import { memo, useEffect, useReducer, useRef, type ReactNode } from "react";

import { AgentElapsed } from "../chat/AgentElapsed";
import { WorkflowTokens } from "./WorkflowTokens";
import {
  arrangeRuns,
  buildWorkflowRunGraph,
  initialViewport,
  ROW_GAP,
  tidyLayoutRun,
  WORKFLOW_NODE_SIZE,
  workflowGraphShapeKey,
  type RunLayout,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowRunGraph,
} from "./workflowGraph";

export interface WorkflowCanvasProps {
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly horizontal: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
}

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting for input",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

type EdgeState = "running" | "waiting" | "completed" | "failed" | "idle";

const EDGE_COLOR: Record<EdgeState, string> = {
  running: "var(--wf-running)",
  waiting: "var(--wf-waiting)",
  completed: "var(--wf-completed)",
  failed: "var(--wf-failed)",
  idle: "var(--wf-idle)",
};

/** Static nodes (prompt, orchestrator, router) have no status; they read as done. */
function nodeStatus(node: WorkflowGraphNode): WorkflowStatus | null {
  switch (node.kind) {
    case "prompt":
    case "orchestrator":
    case "router":
      return null;
    case "main":
      return node.run.status;
    case "agent":
    case "worktree":
    case "collect":
      return node.agent.status;
    case "merge":
      return node.status;
    case "review":
      return node.run.review?.status ?? null;
  }
}

function edgeState(source: WorkflowStatus | null, target: WorkflowStatus | null): EdgeState {
  if (target === "running" || target === "waiting") return target;
  if (target === "failed") return "failed";
  const sourceDone = source === null || source === "completed" || source === "idle";
  return sourceDone && target !== "pending" ? "completed" : "idle";
}

// ELK results, by run shape: a status change keeps the shape, so it reuses the layout.
const elkLayouts = new Map<string, RunLayout>();
const elkPending = new Set<string>();
const elkFailed = new Set<string>();
const ELK_CACHE_LIMIT = 64;

function cacheElkLayout(key: string, layout: RunLayout) {
  if (elkLayouts.size >= ELK_CACHE_LIMIT) {
    const oldest = elkLayouts.keys().next().value;
    if (oldest !== undefined) elkLayouts.delete(oldest);
  }
  elkLayouts.set(key, layout);
}

const PENDING_LAYOUT: RunLayout = { positions: new Map(), width: 420, height: 220 };

function loadElkLayout(graph: WorkflowRunGraph) {
  return import("./workflowElkLayout").then(({ elkLayoutRun }) => elkLayoutRun(graph));
}

function useRunLayouts(graphs: ReadonlyArray<WorkflowRunGraph>) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const keys = graphs.map(workflowGraphShapeKey);
  const missing = graphs.flatMap((graph, index) => {
    const key = keys[index]!;
    return graph.layout === "general" && !elkLayouts.has(key) && !elkFailed.has(key)
      ? [{ graph, key }]
      : [];
  });
  const missingKey = missing.map(({ key }) => key).join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize the chart with asynchronous ELK worker layouts cached outside React.
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `missingKey` names exactly the graphs in `missing`.
    for (const { graph, key } of missing) {
      if (elkPending.has(key)) continue;
      elkPending.add(key);
      loadElkLayout(graph)
        .then((layout) => cacheElkLayout(key, layout))
        .catch(() => elkFailed.add(key))
        .finally(() => {
          elkPending.delete(key);
          if (!cancelled) rerender();
        });
    }
    return () => {
      cancelled = true;
    };
  }, [missingKey]);
  return graphs.map((graph, index) => {
    if (graph.layout === "tidy" || elkFailed.has(keys[index]!)) {
      return { layout: tidyLayoutRun(graph), pending: false };
    }
    const layout = elkLayouts.get(keys[index]!);
    return layout === undefined
      ? { layout: PENDING_LAYOUT, pending: true }
      : { layout, pending: false };
  });
}

interface FlowNodeData extends Record<string, unknown> {
  readonly node: WorkflowGraphNode;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selected: boolean;
  readonly onSelectNode: WorkflowCanvasProps["onSelectNode"];
}

interface RunNodeData extends Record<string, unknown> {
  readonly run: WorkflowRun;
  readonly pending: boolean;
}

interface BusEdgeData extends Record<string, unknown> {
  readonly side: boolean;
  readonly join: boolean;
}

type FlowNode = Node<FlowNodeData, "workflow"> | Node<RunNodeData, "run">;
type FlowEdge = Edge<BusEdgeData, "bus">;

function StatusText(props: { status: WorkflowStatus; text?: string | null }) {
  return (
    <span data-wf-status={props.status}>
      <span aria-hidden data-wf-dot />
      <span className="truncate">{props.text || STATUS_LABEL[props.status]}</span>
    </span>
  );
}

function providerLabel(agent: WorkflowAgent, providers: ReadonlyArray<ServerProvider>): string {
  const provider = providers.find((entry) => entry.instanceId === agent.providerInstanceId);
  if (provider) return resolveProviderInstanceDisplayName(provider);
  return (agent.driver && PROVIDER_DISPLAY_NAMES[agent.driver]) ?? "Agent";
}

/** Matches AgentElapsed's status vocabulary: a stopped agent shows its final time. */
function elapsedAgent(agent: WorkflowAgent) {
  return {
    status: agent.status === "stopped" ? ("cancelled" as const) : agent.status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  };
}

function Row(props: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center justify-between gap-1.5">{props.children}</div>;
}

function Title(props: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold">
      {props.children}
    </div>
  );
}

function Muted(props: { children: ReactNode }) {
  return <div className="min-w-0 truncate text-muted-foreground">{props.children}</div>;
}

function NodeBody({ node, providers }: Pick<FlowNodeData, "node" | "providers">) {
  switch (node.kind) {
    case "prompt":
      return (
        <>
          <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <b className="font-semibold">Prompt</b>
            <span className="text-muted-foreground"> · {node.run.prompt}</span>
          </span>
        </>
      );
    case "orchestrator":
      return (
        <>
          <Title>
            <WorkflowIcon aria-hidden className="size-3" />
            Orchestrator
          </Title>
          <Muted>spawns the thread</Muted>
        </>
      );
    case "main":
      return (
        <>
          <Row>
            <Title>Main agent</Title>
            <StatusText status={node.run.status} />
          </Row>
          <Muted>{formatModelSlugName(node.run.model)} · this thread</Muted>
          <Row>
            <Muted>own usage</Muted>
            <WorkflowTokens usage={node.run.mainTokenUsage} />
          </Row>
        </>
      );
    case "router":
      return (
        <>
          <Title>Router</Title>
          <Muted>matches each task to a provider</Muted>
        </>
      );
    case "agent": {
      const { agent } = node;
      const live = agent.status === "running" || agent.status === "waiting";
      return (
        <>
          <Row>
            <Title>{agent.title}</Title>
            <span className="shrink-0 rounded-full border px-1.5 text-3xs text-muted-foreground">
              {providerLabel(agent, providers)}
            </span>
          </Row>
          <Muted>
            {[agent.model ? formatModelSlugName(agent.model) : null, node.phase, agent.task]
              .filter(Boolean)
              .join(" · ")}
          </Muted>
          <Row>
            <StatusText status={agent.status} text={live ? agent.progress : null} />
            <span className="shrink-0 text-muted-foreground tabular-nums">
              <AgentElapsed agent={elapsedAgent(agent)} compact />
            </span>
          </Row>
          <WorkflowTokens usage={agent.tokenUsage} />
        </>
      );
    }
    case "worktree":
      return (
        <>
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{node.agent.branch ?? "isolated worktree"}</span>
        </>
      );
    case "collect":
      return (
        <>
          <Undo2Icon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">results to {node.agent.title}</span>
        </>
      );
    case "merge":
      return (
        <>
          <Row>
            <Title>Merge results</Title>
            <StatusText status={node.status} />
          </Row>
          <Muted>
            {node.status === "pending"
              ? "waiting on agents"
              : "main agent combines partial results"}
          </Muted>
        </>
      );
    case "review": {
      const { review } = node.run;
      if (review === null) return null;
      return (
        <>
          <Row>
            <Title>Review changes</Title>
            <StatusText
              status={review.status}
              text={review.status === "completed" ? "Available" : null}
            />
          </Row>
          <Muted>
            {review.pullRequestNumber !== null
              ? `PR #${review.pullRequestNumber}`
              : "workspace changes available"}
          </Muted>
        </>
      );
    }
  }
}

function nodeAccessibleName(node: WorkflowGraphNode): string {
  const status = nodeStatus(node);
  const suffix = status === null ? "" : `, ${STATUS_LABEL[status].toLowerCase()}`;
  switch (node.kind) {
    case "agent":
      return `Agent ${node.agent.title}${suffix}. Show details.`;
    case "main":
      return `Main agent${suffix}`;
    case "merge":
      return `Merge results${suffix}`;
    case "review":
      return `Review${suffix}`;
    case "prompt":
      return `Prompt: ${node.run.prompt}`;
    default:
      return node.kind;
  }
}

const WorkflowNodeView = memo(function WorkflowNodeView({ data }: NodeProps<Node<FlowNodeData>>) {
  const { node } = data;
  const status = nodeStatus(node);
  const body = <NodeBody node={node} providers={data.providers} />;
  return (
    <>
      <Handle type="target" position={Position.Top} id="t" isConnectable={false} />
      <Handle type="target" position={Position.Left} id="l" isConnectable={false} />
      <button
        type="button"
        className="cursor-pointer"
        data-wf-node={node.kind}
        data-status={status ?? undefined}
        data-selected={data.selected}
        aria-label={nodeAccessibleName(node)}
        aria-pressed={data.selected}
        onClick={() => data.onSelectNode(node.id)}
      >
        {body}
      </button>
      <Handle type="source" position={Position.Bottom} id="b" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="r" isConnectable={false} />
    </>
  );
});

function RunNodeView({ data }: NodeProps<Node<RunNodeData>>) {
  const live = workflowStatusIsActive(data.run.status);
  return (
    <div data-wf-run>
      <div data-wf-run-label data-live={live}>
        {live ? <span aria-hidden data-wf-dot /> : null}
        Run {data.run.ordinal}
        <WorkflowTokens usage={data.run.tokenUsage} />
        {live ? " · live" : ""}
        {data.pending ? " · laying out…" : ""}
      </div>
    </div>
  );
}

/** Option B's routing: straight down, or down-across-down with the bend on a shared line. */
function busPath(sx: number, sy: number, tx: number, ty: number, data: BusEdgeData) {
  if (data.side) return { path: `M${sx} ${sy}H${tx}`, labelX: (sx + tx) / 2, labelY: sy - 9 };
  const bendY = data.join ? ty - ROW_GAP / 2 : (sy + ty) / 2;
  if (Math.abs(sx - tx) < 1) {
    return { path: `M${sx} ${sy}V${ty}`, labelX: sx, labelY: (sy + ty) / 2 };
  }
  const dir = tx > sx ? 1 : -1;
  const r = Math.min(8, Math.abs(tx - sx) / 2, Math.abs(bendY - sy), Math.abs(ty - bendY));
  return {
    path: `M${sx} ${sy}V${bendY - r}Q${sx} ${bendY} ${sx + dir * r} ${bendY}H${tx - dir * r}Q${tx} ${bendY} ${tx} ${bendY + r}V${ty}`,
    labelX: sx,
    labelY: (sy + bendY) / 2,
  };
}

function BusEdge(props: EdgeProps<FlowEdge>) {
  const { path, labelX, labelY } = busPath(
    props.sourceX,
    props.sourceY,
    props.targetX,
    props.targetY,
    props.data ?? { side: false, join: false },
  );
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd === undefined ? {} : { markerEnd: props.markerEnd })}
      />
      {props.label ? (
        <EdgeLabelRenderer>
          <div
            data-wf-edge-label
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = { workflow: WorkflowNodeView, run: RunNodeView };
const edgeTypes = { bus: BusEdge };

function toFlowEdge(edge: WorkflowGraphEdge, state: EdgeState): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.side ? "r" : "b",
    targetHandle: edge.side ? "l" : "t",
    type: "bus",
    className: `wf-edge-${state}`,
    focusable: false,
    selectable: false,
    ...(edge.label ? { label: edge.label } : {}),
    data: { side: edge.side === true, join: edge.join === true },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_COLOR[state] },
  };
}

export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  const graphs = props.runs.map(buildWorkflowRunGraph);
  const layouts = useRunLayouts(graphs);
  const groups = arrangeRuns(
    graphs.map((graph, index) => ({ runId: graph.run.id, layout: layouts[index]!.layout })),
    props.horizontal,
  );
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  graphs.forEach((graph, index) => {
    const { layout, pending } = layouts[index]!;
    const group = groups[index]!;
    const groupId = `run:${graph.run.id}`;
    nodes.push({
      id: groupId,
      type: "run",
      position: { x: group.x, y: group.y },
      width: group.width,
      height: group.height,
      data: { run: graph.run, pending },
      draggable: false,
      selectable: false,
      focusable: false,
    });
    if (pending) return;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      const position = layout.positions.get(node.id);
      if (position === undefined) continue;
      nodes.push({
        id: node.id,
        type: "workflow",
        parentId: groupId,
        position,
        ...WORKFLOW_NODE_SIZE[node.kind],
        data: {
          node,
          providers: props.providers,
          selected: props.selectedNodeId === node.id,
          onSelectNode: props.onSelectNode,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      });
    }
    for (const edge of graph.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      edges.push(toFlowEdge(edge, edgeState(nodeStatus(source), nodeStatus(target))));
    }
  });
  const latestGroup = groups.at(-1);
  const flowRef = useRef<HTMLDivElement>(null);
  const frameLatestRun = (instance: ReactFlowInstance<FlowNode, FlowEdge>) => {
    const element = flowRef.current;
    if (!element || !latestGroup) return;
    void instance.setViewport(
      initialViewport(latestGroup, { width: element.clientWidth, height: element.clientHeight }),
    );
  };

  return (
    <ReactFlow
      // A new run or another dock reframes the newest run; status changes keep the viewport.
      key={`${props.horizontal}:${graphs.at(-1)?.run.id}:${graphs.length}`}
      ref={flowRef}
      onInit={frameLatestRun}
      data-workflow-flow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.15}
      maxZoom={1.6}
      nodesDraggable={false}
      noDragClassName="cursor-pointer"
      noPanClassName="cursor-pointer"
      nodesConnectable={false}
      elementsSelectable={false}
      onlyRenderVisibleElements
      attributionPosition="bottom-left"
    >
      <Background
        gap={16}
        size={1}
        color="color-mix(in srgb, var(--foreground) 12%, transparent)"
      />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
