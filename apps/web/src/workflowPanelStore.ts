import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type WorkflowPanelDock = "top" | "bottom" | "left" | "right";

export const WORKFLOW_PANEL_MIN_HEIGHT = 160;
export const WORKFLOW_PANEL_MIN_WIDTH = 280;
const DEFAULT_HEIGHT = 320;
const DEFAULT_WIDTH = 440;

/** Top and bottom docks lay runs out side by side; side docks stack them. */
export function workflowPanelIsHorizontal(dock: WorkflowPanelDock): boolean {
  return dock === "top" || dock === "bottom";
}

interface WorkflowPanelState {
  /** Where the chart opens. One choice for every thread, like the user's other layout picks. */
  readonly dock: WorkflowPanelDock;
  readonly height: number;
  readonly width: number;
  /** Open is per thread, like the terminal drawer. Closed threads have no entry. */
  readonly openByThreadKey: Readonly<Record<string, true>>;
  readonly setDock: (dock: WorkflowPanelDock) => void;
  readonly setSize: (dock: WorkflowPanelDock, size: number) => void;
  readonly setOpen: (threadKey: string, open: boolean) => void;
}

export const useWorkflowPanelStore = create<WorkflowPanelState>()(
  persist(
    (set) => ({
      dock: "bottom",
      height: DEFAULT_HEIGHT,
      width: DEFAULT_WIDTH,
      openByThreadKey: {},
      setDock: (dock) => set({ dock }),
      setSize: (dock, size) =>
        set(
          workflowPanelIsHorizontal(dock)
            ? { height: Math.max(WORKFLOW_PANEL_MIN_HEIGHT, Math.round(size)) }
            : { width: Math.max(WORKFLOW_PANEL_MIN_WIDTH, Math.round(size)) },
        ),
      setOpen: (threadKey, open) =>
        set((state) => {
          if (open === (state.openByThreadKey[threadKey] === true)) return state;
          const { [threadKey]: _removed, ...rest } = state.openByThreadKey;
          return { openByThreadKey: open ? { ...rest, [threadKey]: true } : rest };
        }),
    }),
    {
      name: "t3code:workflow-panel:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ dock, height, width, openByThreadKey }) => ({
        dock,
        height,
        width,
        openByThreadKey,
      }),
    },
  ),
);

export function useWorkflowPanelOpen(threadKey: string | null): boolean {
  return useWorkflowPanelStore((state) =>
    threadKey === null ? false : state.openByThreadKey[threadKey] === true,
  );
}

export function toggleWorkflowPanel(threadKey: string): void {
  const { openByThreadKey, setOpen } = useWorkflowPanelStore.getState();
  setOpen(threadKey, openByThreadKey[threadKey] !== true);
}
