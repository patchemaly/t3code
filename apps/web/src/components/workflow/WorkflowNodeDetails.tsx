import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { PlayIcon, SquareIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { WorkflowGraphNode, WorkflowNodeKind } from "./workflowGraph";
import { workflowNodeActions } from "./workflowNodeActions";
import { WorkflowTokens } from "./WorkflowTokens";

const NODE_TITLES: Record<WorkflowNodeKind, string> = {
  prompt: "User prompt",
  orchestrator: "Orchestrator",
  main: "Main agent",
  router: "Delegation router",
  agent: "Agent",
  worktree: "Isolated worktree",
  collect: "Collect results",
  merge: "Combine agent results",
  review: "Review changes",
};

const NODE_DESCRIPTIONS: Partial<Record<WorkflowNodeKind, string>> = {
  orchestrator: "The server coordinates this run. This is not a separately runnable agent.",
  router: "Delegated agents fan out here. Start or stop an individual agent from its own node.",
  collect: "This agent collects results from its delegated agents.",
  merge:
    "Coordination state inferred from the run and its agents. This does not perform a Git merge.",
  review:
    "Shown only when this run has captured file changes or a linked pull request. It does not mean a review was performed or approved.",
};

export function WorkflowNodeDetails(props: {
  readonly node: WorkflowGraphNode;
  readonly threadRef: ScopedThreadRef;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { node, threadRef } = props;
  const agent =
    node.kind === "agent" || node.kind === "worktree" || node.kind === "collect"
      ? node.agent
      : null;
  const targetId = agent?.threadId ?? (node.kind === "main" ? threadRef.threadId : null);
  const targetRef = targetId === null ? null : scopeThreadRef(threadRef.environmentId, targetId);
  const thread = useThreadShell(targetRef);
  const targetProjection = useThreadProjection(targetRef)?.projection;
  const ownerId = agent?.control?.threadId ?? threadRef.threadId;
  const ownerProjection = useThreadProjection(
    scopeThreadRef(threadRef.environmentId, ownerId),
  )?.projection;
  const sourceAgent = ownerProjection?.subagents.find((entry) => entry.id === agent?.id);
  const sourceMember =
    agent === null
      ? undefined
      : ownerProjection?.subagents.flatMap(
          (entry) =>
            entry.workflow?.agents.filter(
              (member) => `${entry.id}:agent:${member.index}` === agent.id,
            ) ?? [],
        )[0];
  const actions = workflowNodeActions(node, threadRef.threadId, thread?.source ?? null);
  const canDispatch = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(threadRef.environmentId),
  );
  const hasScope = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const canOperate = canDispatch && hasScope;
  const canStopWorkflow = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(threadRef.environmentId),
  );
  const canStop =
    canOperate && actions.canStop && (actions.stopWorkflowInput === null || canStopWorkflow);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const [instruction, setInstruction] = useState("");
  const stopWorkflow = useOrchestrationCommand(orchestrationEnvironment.stopWorkflow, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"run" | "stop" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = "run" in node ? node.run : null;
  const sourceRun = ownerProjection?.runs.find((entry) => entry.id === run?.id);
  const prompt =
    sourceAgent?.prompt ??
    sourceMember?.prompt ??
    ownerProjection?.messages.find((message) => message.id === sourceRun?.userMessageId)?.text ??
    agent?.task ??
    run?.prompt;
  const latestOutput = targetProjection?.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.runId === (node.kind === "main" ? node.run.id : thread?.latestRun?.runId),
  )?.text;
  const result = latestOutput || sourceAgent?.result || sourceMember?.result;
  const providerId = agent?.providerInstanceId ?? run?.providerInstanceId;
  const provider = props.providers.find((entry) => entry.instanceId === providerId);
  const status = agent?.status ?? (node.kind === "merge" ? node.status : run?.status);
  const checkpoint = ownerProjection?.checkpoints.find(
    (entry) => entry.id === sourceRun?.checkpointId,
  );
  const controllable = node.kind === "main" || node.kind === "agent";

  const execute = async (action: "run" | "stop") => {
    if (inFlight.current || !canOperate) return;
    if (action === "stop" && (!canStop || actions.stopInput === null)) return;
    if (
      action === "run" &&
      (!actions.canRun || !instruction.trim() || thread === null || actions.threadId === null)
    )
      return;
    inFlight.current = true;
    setBusy(action);
    setFeedback(null);
    try {
      const response =
        action === "stop"
          ? actions.stopWorkflowInput !== null
            ? await stopWorkflow({
                environmentId: threadRef.environmentId,
                input: actions.stopWorkflowInput,
              })
            : await interruptTurn({
                environmentId: threadRef.environmentId,
                input: actions.stopInput!,
              })
          : await startTurn({
              environmentId: threadRef.environmentId,
              input: {
                threadId: actions.threadId!,
                message: {
                  messageId: newMessageId(),
                  role: "user",
                  text: instruction.trim(),
                  attachments: [],
                },
                runtimeMode: thread!.runtimeMode,
                interactionMode: thread!.interactionMode,
                dispatchMode: "start",
              },
            });
      if (response._tag === "Failure") {
        setFeedback(`Could not ${action} this agent. Check its thread for details.`);
      } else {
        if (action === "run") setInstruction("");
        setFeedback(action === "run" ? "New turn requested." : "Stop requested.");
      }
    } catch {
      setFeedback(`Could not ${action} this agent. The environment may be disconnected.`);
    }
    inFlight.current = false;
    setBusy(null);
  };

  return (
    <aside
      aria-label="Workflow node details"
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
      className="absolute inset-y-0 right-0 z-10 flex w-80 max-w-full flex-col border-l bg-card shadow-lg"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h3 className="min-w-0 truncate text-xs font-semibold">
          {agent?.title ?? NODE_TITLES[node.kind]}
        </h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close node details"
          onClick={props.onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs wrap-anywhere">
        {status ? (
          <p aria-live="polite">
            Status: <span className="font-medium">{status}</span>
          </p>
        ) : null}
        {NODE_DESCRIPTIONS[node.kind] ? (
          <p className="text-muted-foreground">{NODE_DESCRIPTIONS[node.kind]}</p>
        ) : null}
        {providerId ? (
          <p>Provider: {provider ? resolveProviderInstanceDisplayName(provider) : providerId}</p>
        ) : null}
        {agent?.model || run?.model ? <p>Model: {agent?.model ?? run?.model}</p> : null}
        {node.kind === "main" || agent !== null ? (
          <p>
            Consumption:{" "}
            <WorkflowTokens usage={agent?.tokenUsage ?? run?.mainTokenUsage ?? null} exact />
          </p>
        ) : null}
        {agent?.branch ? <p>Branch: {agent.branch}</p> : null}
        {thread?.worktreePath ? <p>Workspace: {thread.worktreePath}</p> : null}
        {agent?.startedAt || run?.startedAt ? (
          <p>Started: {agent?.startedAt ?? run?.startedAt}</p>
        ) : null}
        {agent?.completedAt || run?.completedAt ? (
          <p>Finished: {agent?.completedAt ?? run?.completedAt}</p>
        ) : null}
        {prompt ? (
          <section>
            <h4 className="mb-1 font-medium">Prompt</h4>
            <p className="whitespace-pre-wrap">{prompt}</p>
          </section>
        ) : null}
        {sourceAgent?.progress || agent?.progress ? (
          <section>
            <h4 className="mb-1 font-medium">Progress</h4>
            <p className="whitespace-pre-wrap">{sourceAgent?.progress ?? agent?.progress}</p>
          </section>
        ) : null}
        {result ? (
          <section>
            <h4 className="mb-1 font-medium">Latest output</h4>
            <p className="whitespace-pre-wrap">{result}</p>
          </section>
        ) : null}
        {node.kind === "review" ? (
          <section>
            {node.run.review?.pullRequestNumber ? (
              <p>Pull request #{node.run.review.pullRequestNumber}</p>
            ) : null}
            {checkpoint?.files.map((file) => (
              <p key={file.path}>
                {file.path} (+{file.additions} / −{file.deletions})
              </p>
            ))}
          </section>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onOpenThread(targetId ?? ownerId)}
          >
            Open thread
          </Button>
          {controllable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canStop || busy !== null}
              onClick={() => void execute("stop")}
            >
              <SquareIcon aria-hidden />
              {busy === "stop" ? "Stopping…" : "Stop agent"}
            </Button>
          ) : null}
        </div>
        {controllable ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void execute("run");
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">Next instruction</span>
              <Textarea
                size="sm"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="What should this agent do next?"
                disabled={!canOperate || !actions.canRun || busy !== null}
              />
            </label>
            <Button
              size="sm"
              disabled={!canOperate || !actions.canRun || !instruction.trim() || busy !== null}
              type="submit"
            >
              <PlayIcon aria-hidden />
              {busy === "run" ? "Starting…" : "Run agent"}
            </Button>
            <p className="text-muted-foreground">
              {!canOperate
                ? "This connection cannot operate agents."
                : actions.threadId === null
                  ? "This provider-native agent has no independently runnable thread. Control it through its parent."
                  : !actions.canRun
                    ? "Run is available when this thread is idle and independently runnable. Waiting agents may need approval in their thread."
                    : "Starts a new turn in this thread using its current model and permissions. It does not recreate the original delegated task."}
            </p>
          </form>
        ) : null}
        {feedback ? <p role="status">{feedback}</p> : null}
      </div>
    </aside>
  );
}
