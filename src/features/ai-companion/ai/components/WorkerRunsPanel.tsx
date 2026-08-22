import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useEffect, useMemo } from "react";
import {
  useWorkerRunsStore,
  type WorkerRun,
} from "@/features/ai-companion/agents/store/workerRunsStore";
import { WorkerPane } from "./WorkerPane";

/** Renders every worker currently running for this session: step workers
 *  (spawn_worker, one self-contained task step) stack inline; team workers
 *  (spawn_team, e.g. planner+builder+reviewer) render side by side so their
 *  streams and approval cards are all visible and actionable at once. A
 *  finished run stays mounted briefly so its final output is readable, then
 *  gets pruned — the spawning tool call's own result, already in the main
 *  transcript, is the lasting record. */
const PRUNE_DONE_AFTER_MS = 20_000;

function usePruneDoneRuns(runs: WorkerRun[], remove: (id: string) => void) {
  useEffect(() => {
    const done = runs.filter((r) => r.status !== "running");
    if (done.length === 0) return;
    const timers = done.map((r) =>
      setTimeout(() => remove(r.id), PRUNE_DONE_AFTER_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [runs, remove]);
}

export function WorkerRunsPanel({ sessionId }: { sessionId: string }) {
  const runsMap = useWorkerRunsStore((s) => s.runs);
  const remove = useWorkerRunsStore((s) => s.remove);
  const runs = useMemo(
    () =>
      Array.from(runsMap.values()).filter(
        (r) => r.parentSessionId === sessionId,
      ),
    [runsMap, sessionId],
  );
  usePruneDoneRuns(runs, remove);

  if (runs.length === 0) return null;

  const steps = runs.filter((r) => r.kind === "step");
  const team = runs.filter((r) => r.kind === "team");

  return (
    <div className="flex max-h-72 shrink-0 flex-col gap-2 overflow-y-auto border-t border-border/60 p-2">
      {steps.map((r) => (
        <div key={r.id} className="h-56">
          <WorkerPane run={r} />
        </div>
      ))}
      {team.length > 0 && (
        <div className="h-72">
          <ResizablePanelGroup orientation="horizontal" className="gap-2">
            {team.flatMap((r, i) => [
              ...(i > 0
                ? [<ResizableHandle key={`${r.id}-handle`} withHandle />]
                : []),
              <ResizablePanel key={r.id} minSize={20}>
                <WorkerPane run={r} />
              </ResizablePanel>,
            ])}
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}
