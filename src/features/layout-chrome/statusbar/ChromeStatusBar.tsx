import { useAiChatStore } from "@/features/ai-companion/ai";
import { AgentStatusPill } from "@/features/ai-companion/ai/components/AgentStatusPill";
import {
  AiOpenButton,
  AiStatusBarControls,
} from "@/features/ai-companion/ai/components/AiStatusBarControls";
import { native } from "@/features/ai-companion/ai/lib/native";
import { useBrowserAutomationStore } from "@/features/ai-companion/ai/store/browserAutomationStore";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Globe02Icon, IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";
import type { WorkspaceEnv } from "@/features/shell-pty/workspace";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
};

export function ChromeStatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenMini,
  hasComposer,
  privateActive,
}: Props) {
  const panelOpen = useAiChatStore((s) => s.panelOpen);
  const openPanel = useAiChatStore((s) => s.openPanel);
  const automationActive = useBrowserAutomationStore((s) => s.active);
  const automationUrl = useBrowserAutomationStore((s) => s.url);
  const setAutomationInactive = useBrowserAutomationStore((s) => s.setInactive);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {automationActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  void native.browserAutomationStop();
                  setAutomationInactive();
                }}
                className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 hover:bg-sky-500/25 dark:text-sky-400"
              >
                <HugeiconsIcon icon={Globe02Icon} size={11} strokeWidth={2} />
                <span>
                  Agent driving browser
                  {automationUrl ? ` — ${automationUrl}` : ""}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              A real, separate browser window is open under the agent's control
              (browser_automate). Click to stop and close it.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AgentStatusPill onClick={onOpenMini} />
        {panelOpen && hasComposer ? (
          <AiStatusBarControls />
        ) : (
          <AiOpenButton onOpen={openPanel} />
        )}
      </div>
    </footer>
  );
}
