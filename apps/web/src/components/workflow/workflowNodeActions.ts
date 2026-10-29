import { workflowStatusIsActive } from "@t3tools/client-runtime/state/workflow-runs";
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

import type { WorkflowGraphNode } from "./workflowGraph";

export function workflowNodeActions(
  node: WorkflowGraphNode,
  parentThreadId: ThreadId,
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activeRunId"
    | "latestRunId"
    | "lineage"
    | "creationSource"
    | "archivedAt"
    | "deletedAt"
  > | null,
) {
  const agent = node.kind === "agent" ? node.agent : null;
  const threadId = node.kind === "main" ? parentThreadId : (agent?.threadId ?? null);
  const stopInput = node.kind === "main" ? { threadId: parentThreadId } : (agent?.control ?? null);
  const threadActive =
    thread !== null &&
    (thread.status === "queued" ||
      thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running" ||
      thread.status === "waiting");
  const active =
    node.kind === "main"
      ? threadActive &&
        (thread?.activeRunId === node.run.id ||
          (thread?.activeRunId === null && thread?.latestRunId === node.run.id))
      : agent !== null && (workflowStatusIsActive(agent.status) || threadActive);
  const canRun =
    threadId !== null &&
    thread !== null &&
    !threadActive &&
    !active &&
    (agent === null || agent.control !== null) &&
    !isProviderNativeSubagentThread(thread) &&
    thread.archivedAt === null &&
    thread.deletedAt === null;
  return {
    threadId,
    stopWorkflowInput:
      agent?.control?.workflow === true && agent.control.subagentId !== null
        ? { threadId: agent.control.threadId, subagentId: agent.control.subagentId }
        : null,
    stopInput:
      stopInput === null
        ? null
        : {
            threadId: stopInput.threadId,
            ...("subagentId" in stopInput && stopInput.subagentId !== null
              ? { subagentId: stopInput.subagentId }
              : {}),
          },
    canStop:
      active &&
      stopInput !== null &&
      (node.kind !== "main" || (thread !== null && !isProviderNativeSubagentThread(thread))),
    canRun,
  };
}
