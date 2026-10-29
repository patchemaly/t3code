import type { WorkflowTokenUsage } from "@t3tools/client-runtime/state/workflow-runs";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function WorkflowTokens(props: {
  readonly usage: WorkflowTokenUsage | null;
  readonly exact?: boolean;
}) {
  const { usage } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="pointer-events-auto shrink-0 text-muted-foreground tabular-nums" />
        }
      >
        {usage === null
          ? "N/A tokens"
          : `${(props.exact ? formatCount : formatTokens)(usage.totalTokens)} tokens${usage.complete ? "" : " · partial"}`}
      </TooltipTrigger>
      <TooltipPopup>
        {usage === null
          ? "Token consumption has not been reported by this provider."
          : `${formatCount(usage.totalTokens)} input + output tokens.${usage.complete ? "" : " Partial total: some usage is unavailable."}`}
      </TooltipPopup>
    </Tooltip>
  );
}
