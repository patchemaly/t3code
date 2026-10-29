import {
  summarizeWorkflowRuns,
  visibleWorkflowRuns,
} from "@t3tools/client-runtime/state/workflow-runs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PanelTopIcon,
  WorkflowIcon,
  ListEndIcon,
  XIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import { useWorkflowRuns } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useWorkflowPanelOpen,
  useWorkflowPanelStore,
  WORKFLOW_PANEL_MIN_HEIGHT,
  WORKFLOW_PANEL_MIN_WIDTH,
  workflowPanelIsHorizontal,
  type WorkflowPanelDock,
} from "../../workflowPanelStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildWorkflowRunGraph } from "./workflowGraph";
import { WorkflowNodeDetails } from "./WorkflowNodeDetails";

// React Flow loads with the chart, not with the app.
const WorkflowCanvas = lazy(() => import("./WorkflowCanvas"));

const DOCK_OPTIONS: ReadonlyArray<{
  readonly dock: WorkflowPanelDock;
  readonly label: string;
  readonly Icon: typeof PanelTopIcon;
}> = [
  { dock: "top", label: "Dock above the chat", Icon: PanelTopIcon },
  { dock: "bottom", label: "Dock below the chat", Icon: PanelBottomIcon },
  { dock: "left", label: "Dock left of the chat", Icon: PanelLeftIcon },
  { dock: "right", label: "Dock right of the chat", Icon: PanelRightIcon },
];

const RESIZE_STEP = 24;
// The chart never squeezes the chat below a usable size.
const MAX_SHARE = 0.75;
const MIN_CHAT_WIDTH = 360;
const MIN_CHAT_HEIGHT = 200;

/**
 * Renders the workflow chart when it is open for this thread and docked at `slot`. ChatView places
 * one slot at each dock position, so moving the chart is a store change, not a remount dance.
 */
export function WorkflowPanelSlot(props: {
  readonly slot: WorkflowPanelDock;
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
}) {
  const dock = useWorkflowPanelStore((state) => state.dock);
  const open = useWorkflowPanelOpen(props.threadKey);
  if (dock !== props.slot || !open || props.threadRef === null || props.threadKey === null) {
    return null;
  }
  return <WorkflowPanel dock={dock} threadRef={props.threadRef} threadKey={props.threadKey} />;
}

function WorkflowPanel(props: {
  readonly dock: WorkflowPanelDock;
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
}) {
  const { dock, threadRef } = props;
  const horizontal = workflowPanelIsHorizontal(dock);
  const size = useWorkflowPanelStore((state) => (horizontal ? state.height : state.width));
  const setDock = useWorkflowPanelStore((state) => state.setDock);
  const setSize = useWorkflowPanelStore((state) => state.setSize);
  const setOpen = useWorkflowPanelStore((state) => state.setOpen);
  const allRuns = useWorkflowRuns(threadRef);
  const latestRunOnly = useWorkflowPanelStore((state) => state.latestRunOnly);
  const setLatestRunOnly = useWorkflowPanelStore((state) => state.setLatestRunOnly);
  const runs = visibleWorkflowRuns(allRuns, latestRunOnly);
  const providers = useEnvironmentProviders().get(threadRef.environmentId) ?? [];
  const navigate = useNavigate();
  const panelRef = useRef<HTMLElement>(null);
  const summary = summarizeWorkflowRuns(runs);
  const [selection, setSelection] = useState<{ threadKey: string; nodeId: string } | null>(null);
  const selectedNodeId = selection?.threadKey === props.threadKey ? selection.nodeId : null;
  const selectedRun = runs.find((run) => selectedNodeId?.startsWith(`${run.id}:`));
  const selectedNode = selectedRun
    ? buildWorkflowRunGraph(selectedRun).nodes.find((node) => node.id === selectedNodeId)
    : null;

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
    });
  };

  const maxSize = () => {
    const container = panelRef.current?.parentElement;
    if (!container) return Number.POSITIVE_INFINITY;
    const available = horizontal ? container.clientHeight : container.clientWidth;
    return Math.max(
      0,
      Math.min(available * MAX_SHARE, available - (horizontal ? MIN_CHAT_HEIGHT : MIN_CHAT_WIDTH)),
    );
  };
  const clamp = (next: number) =>
    Math.min(
      Math.max(next, horizontal ? WORKFLOW_PANEL_MIN_HEIGHT : WORKFLOW_PANEL_MIN_WIDTH),
      maxSize(),
    );
  const renderedSize = () => {
    const panel = panelRef.current;
    return panel ? (horizontal ? panel.clientHeight : panel.clientWidth) : size;
  };
  // Dragging toward the chat grows the panel: up for the bottom dock, down for the top, and so on.
  const growDirection = dock === "bottom" || dock === "right" ? -1 : 1;

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = horizontal ? event.clientY : event.clientX;
    const startSize = renderedSize();
    let next = startSize;
    const onMove = (move: PointerEvent) => {
      const delta = ((horizontal ? move.clientY : move.clientX) - start) * growDirection;
      next = clamp(startSize + delta);
      // Resize the element directly while dragging; the store saves once on release.
      panel.style.setProperty(horizontal ? "height" : "width", `${next}px`);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setSize(dock, next);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = horizontal
      ? { ArrowUp: -growDirection, ArrowDown: growDirection }
      : { ArrowLeft: -growDirection, ArrowRight: growDirection };
    const direction = grow[event.key as keyof typeof grow];
    if (direction === undefined) return;
    event.preventDefault();
    setSize(dock, clamp(renderedSize() + direction * RESIZE_STEP));
  };

  const summaryText =
    runs.length === 0
      ? "No runs yet"
      : [
          latestRunOnly && allRuns.length > 1
            ? `1 of ${allRuns.length} runs`
            : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
          `${summary.agentCount} ${summary.agentCount === 1 ? "agent" : "agents"}`,
          ...(summary.working > 0 ? [`${summary.working} working`] : []),
          ...(summary.waiting > 0 ? [`${summary.waiting} waiting`] : []),
        ].join(" · ");

  return (
    <section
      ref={panelRef}
      aria-label="Workflow chart"
      data-workflow-panel={dock}
      className={cn(
        "relative flex shrink-0 flex-col bg-card",
        dock === "bottom" && "border-t",
        dock === "top" && "border-b",
        dock === "left" && "border-r",
        dock === "right" && "border-l",
      )}
      style={
        horizontal
          ? {
              height: size,
              maxHeight: `max(0px, min(${MAX_SHARE * 100}%, calc(100% - ${MIN_CHAT_HEIGHT}px)))`,
            }
          : {
              width: size,
              maxWidth: `max(0px, min(${MAX_SHARE * 100}%, calc(100% - ${MIN_CHAT_WIDTH}px)))`,
            }
      }
    >
      <div
        role="separator"
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        aria-label="Resize workflow chart"
        aria-valuenow={Math.round(size)}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
        className={cn(
          "group absolute z-20 touch-none select-none focus-visible:outline-none",
          horizontal ? "inset-x-0 h-2 cursor-row-resize" : "inset-y-0 w-2 cursor-col-resize",
          dock === "bottom" && "-top-1",
          dock === "top" && "-bottom-1",
          dock === "left" && "-right-1",
          dock === "right" && "-left-1",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-ring group-active:bg-primary/60",
            horizontal
              ? "inset-x-0 top-1/2 h-px -translate-y-1/2"
              : "inset-y-0 left-1/2 w-px -translate-x-1/2",
          )}
        />
      </div>
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3 text-xs">
        <span className="flex items-center gap-1.5 font-semibold">
          <WorkflowIcon aria-hidden className="size-3.5" />
          Workflow
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
          {summaryText}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="xs"
                variant="ghost"
                aria-label="Show only the latest run"
                pressed={latestRunOnly}
                onPressedChange={setLatestRunOnly}
              >
                <ListEndIcon aria-hidden className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Last run only</TooltipPopup>
        </Tooltip>
        <ToggleGroup
          size="xs"
          aria-label="Workflow chart position"
          value={[dock]}
          onValueChange={(next) => {
            const picked = DOCK_OPTIONS.find((option) => option.dock === next[0]);
            if (picked) setDock(picked.dock);
          }}
        >
          {DOCK_OPTIONS.map(({ dock: option, label, Icon }) => (
            <Tooltip key={option}>
              <TooltipTrigger
                render={
                  <Toggle value={option} aria-label={label}>
                    <Icon aria-hidden className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">{label}</TooltipPopup>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close workflow chart"
          onClick={() => setOpen(props.threadKey, false)}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        {runs.length === 0 ? (
          <p className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
            Send a prompt and its workflow appears here, including any agents it delegates to.
          </p>
        ) : (
          <Suspense
            fallback={
              <div className="grid h-full place-items-center">
                <Spinner size="sm" aria-label="Loading workflow chart" />
              </div>
            }
          >
            <WorkflowCanvas
              runs={runs}
              horizontal={horizontal}
              providers={providers}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => setSelection({ threadKey: props.threadKey, nodeId })}
            />
          </Suspense>
        )}
        {selectedNode ? (
          <WorkflowNodeDetails
            key={selectedNode.id}
            node={selectedNode}
            threadRef={threadRef}
            providers={providers}
            onClose={() => setSelection(null)}
            onOpenThread={openThread}
          />
        ) : null}
      </div>
    </section>
  );
}
