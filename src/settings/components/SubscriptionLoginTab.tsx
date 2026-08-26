import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderId } from "@/features/ai-companion/ai/config";
import { loginWithCodex } from "@/features/ai-companion/ai/lib/oauth/codex";
import { loginWithOpenRouter } from "@/features/ai-companion/ai/lib/oauth/openrouter";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";

type SubscriptionProvider = {
  id: ProviderId;
  label: string;
  description: string;
  login: () => Promise<void>;
  /** OpenRouter's login lands in the regular key slot, so presence there is
   *  enough. Codex's login is a separate access/refresh credential, not a
   *  key, so it needs its own check instead of `keys[id]`. */
  isConnected: (keys: Record<ProviderId, string | null>, codexConnected: boolean) => boolean;
};

// Claude Pro/Max is deliberately not in this list, see
// docs/adr/0016-subscription-login-claude-experimental.md for how Claude
// Code is handled instead (delegated to an installed claude CLI, not
// OAuth), added in a later slice.
const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Connects your OpenRouter account. No API key to copy.",
    login: loginWithOpenRouter,
    isConnected: (keys) => !!keys.openrouter,
  },
  {
    id: "openai",
    label: "Codex (ChatGPT)",
    description: "Connects your ChatGPT Plus/Pro subscription.",
    login: loginWithCodex,
    isConnected: (_keys, codexConnected) => codexConnected,
  },
];

export function SubscriptionLoginTab({
  keys,
  codexConnected,
  onLoggedIn,
}: {
  keys: Record<ProviderId, string | null>;
  codexConnected: boolean;
  onLoggedIn: () => void;
}) {
  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const selected = SUBSCRIPTION_PROVIDERS.find((p) => p.id === selectedId);
  const connected = !!selected && selected.isConnected(keys, codexConnected);

  const login = async () => {
    if (!selected) return;
    setStatus("connecting");
    setError(null);
    try {
      await selected.login();
      setStatus("idle");
      onLoggedIn();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Log in with a provider you already have an account or subscription with,
        instead of pasting an API key.
      </p>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
          >
            {selected ? (
              <span className="flex items-center gap-2 truncate">
                <ProviderIcon provider={selected.id} size={13} />
                <span className="truncate">{selected.label}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">
                Choose a provider
              </span>
            )}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={11}
              strokeWidth={2}
              className="opacity-70"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56 p-1">
          {SUBSCRIPTION_PROVIDERS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => {
                setSelectedId(p.id);
                setStatus("idle");
                setError(null);
              }}
              className="flex items-center gap-2 text-[12px]"
            >
              <ProviderIcon provider={p.id} size={13} />
              <span>{p.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {selected ? (
        <>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {selected.description}
          </span>
          {connected ? (
            <Badge
              variant="outline"
              className="w-fit gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
            >
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={9}
                strokeWidth={2}
              />
              Connected
            </Badge>
          ) : (
            <Button
              size="sm"
              onClick={() => void login()}
              disabled={status === "connecting"}
              className="h-8 w-fit gap-1.5 px-3 text-[11px]"
            >
              {status === "connecting" ? <Spinner className="size-3" /> : null}
              Log in with {selected.label}
            </Button>
          )}
          {status === "error" && error ? (
            <p className="text-[10.5px] text-destructive">{error}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
