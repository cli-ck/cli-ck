import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useChat } from "@ai-sdk/react";
import { useCallback } from "react";
import type { WorkerRun } from "@/features/ai-companion/agents/store/workerRunsStore";
import { RenderedMessage } from "./AiCompChat";

const ROLE_DOT: Record<WorkerRun["role"], string> = {
  planner: "bg-sky-500",
  builder: "bg-violet-500",
  reviewer: "bg-emerald-500",
  step: "bg-amber-500",
};

export function WorkerPane({ run }: { run: WorkerRun }) {
  const { messages, status, error, addToolApprovalResponse } = useChat({
    chat: run.chat,
  });
  const onApproval = useCallback(
    (id: string, approved: boolean) =>
      addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", ROLE_DOT[run.role])} />
        <span className="truncate text-[11.5px] font-medium text-foreground">
          {run.label}
        </span>
        <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">
          {run.modelId}
        </span>
      </div>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 p-2.5">
          {messages.map((m) => (
            <RenderedMessage
              key={m.id}
              message={m}
              onApproval={onApproval}
              streaming={m.id === streamingMessageId}
            />
          ))}
          {isBusy && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Spinner />
              <span>Working…</span>
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error.message}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}
