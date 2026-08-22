import type { Chat, UIMessage } from "@ai-sdk/react";
import { create } from "zustand";
import type { WorkerRole } from "@/features/ai-companion/ai/lib/workerRun";

export type WorkerRunStatus = "running" | "done" | "error";

export type WorkerRun = {
  id: string;
  role: WorkerRole;
  modelId: string;
  label: string;
  /** "step" runs render inline under the main chat, one at a time. "team"
   *  runs render concurrently in the split team panel. */
  kind: "step" | "team";
  parentSessionId: string;
  chat: Chat<UIMessage>;
  status: WorkerRunStatus;
};

type WorkerRunsState = {
  runs: Map<string, WorkerRun>;
  register: (run: WorkerRun) => void;
  setStatus: (id: string, status: WorkerRunStatus) => void;
  remove: (id: string) => void;
  bySession: (parentSessionId: string) => WorkerRun[];
};

export const useWorkerRunsStore = create<WorkerRunsState>((set, get) => ({
  runs: new Map(),
  register: (run) =>
    set((s) => {
      const next = new Map(s.runs);
      next.set(run.id, run);
      return { runs: next };
    }),
  setStatus: (id, status) =>
    set((s) => {
      const existing = s.runs.get(id);
      if (!existing) return s;
      const next = new Map(s.runs);
      next.set(id, { ...existing, status });
      return { runs: next };
    }),
  remove: (id) =>
    set((s) => {
      if (!s.runs.has(id)) return s;
      const next = new Map(s.runs);
      next.delete(id);
      return { runs: next };
    }),
  bySession: (parentSessionId) =>
    Array.from(get().runs.values()).filter(
      (r) => r.parentSessionId === parentSessionId,
    ),
}));
