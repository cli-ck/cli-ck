import { routeAgentNotification } from "@/features/ai-companion/agents/lib/route";
import { useWindowFocus } from "@/features/ai-companion/agents/lib/useWindowFocus";
import { useAgentStore } from "@/features/ai-companion/agents/store/agentStore";
import type { AgentStatus } from "@/features/ai-companion/agents/lib/types";
import { useEffect, useRef } from "react";
import { useAiChatStore } from "../store/aiChatStore";

const AGENT = "cli-ck";

type RunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

function isBusy(s: RunStatus): boolean {
  return s === "thinking" || s === "streaming" || s === "awaiting-approval";
}

function liveStatus(s: RunStatus): AgentStatus | null {
  if (s === "awaiting-approval") return "waiting";
  if (s === "thinking" || s === "streaming") return "working";
  return null;
}

export function LocalAgentNotificationsBridge() {
  const status = useAiChatStore((s) => s.agentMeta.status) as RunStatus;
  const error = useAiChatStore((s) => s.agentMeta.error);
  const visible = useAiChatStore((s) => s.panelOpen || s.mini.open);
  const focused = useWindowFocus();

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const prev = useRef<RunStatus>(status);

  useEffect(() => {
    useAgentStore.getState().setLocalAgent(
      liveStatus(status) ? { agent: AGENT, status: liveStatus(status)! } : null,
    );

    const was = prev.current;
    prev.current = status;
    if (was === status) return;

    const fire = (
      kind: "attention" | "finished" | "error",
      title: string,
      body?: string,
    ) =>
      routeAgentNotification({
        source: "local",
        agent: AGENT,
        kind,
        title,
        body,
        focused: focusedRef.current,
        visible: visibleRef.current,
        allowToast: true,
        onActivate: () => useAiChatStore.getState().openPanel(),
      });

    if (status === "awaiting-approval") {
      fire("attention", "cli-ck needs your approval", "Approve a tool to continue");
    } else if (status === "error") {
      fire("error", "cli-ck run failed", error ?? undefined);
    } else if (status === "idle" && isBusy(was)) {
      fire("finished", "cli-ck finished", "Your task is ready");
    }
  }, [status, error]);

  return null;
}
