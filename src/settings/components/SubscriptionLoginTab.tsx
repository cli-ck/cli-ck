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
import { refreshClaudeCliDetection } from "@/features/ai-companion/ai/lib/claudeCli";
import { clearKey } from "@/features/ai-companion/ai/lib/keyring";
import { loginWithCodex } from "@/features/ai-companion/ai/lib/oauth/codex";
import {
  clearCodexAuth,
  setPreferredAuthMethod,
} from "@/features/ai-companion/ai/lib/oauth/codexAuth";
import { loginWithOpenRouter } from "@/features/ai-companion/ai/lib/oauth/openrouter";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";

type ConnectionState = {
  keys: Record<ProviderId, string | null>;
  codexConnected: boolean;
  claudeCliDetected: boolean;
  claudeCliEnabled: boolean;
};

type SubscriptionProvider = {
  id: ProviderId;
  label: string;
  description: string;
  /** Codex and OpenRouter run a real browser OAuth flow. Claude has none —
   *  "login" just opts in to using the CLI that's already on PATH, an
   *  explicit action so merely having `claude` installed never silently
   *  connects it. */
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isConnected: (state: ConnectionState) => boolean;
  /** Gates the login button — Claude needs the CLI found on PATH first,
   *  everything else can always attempt to log in. */
  canLogin?: (state: ConnectionState) => boolean;
};

const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Connects your OpenRouter account. No API key to copy.",
    login: loginWithOpenRouter,
    logout: () => clearKey("openrouter"),
    isConnected: (s) => !!s.keys.openrouter,
  },
  {
    id: "openai",
    label: "Codex (ChatGPT)",
    description: "Connects your ChatGPT Plus/Pro subscription.",
    login: loginWithCodex,
    logout: clearCodexAuth,
    isConnected: (s) => s.codexConnected,
  },
  {
    id: "anthropic",
    label: "Claude Code",
    description:
      "Uses your own installed, already logged in claude CLI, the same way the official app does. Install and log in with `claude login` first, then connect it here.",
    login: () => setPreferredAuthMethod("anthropic", "oauth"),
    logout: () => setPreferredAuthMethod("anthropic", "apikey"),
    isConnected: (s) => s.claudeCliDetected && s.claudeCliEnabled,
    canLogin: (s) => s.claudeCliDetected,
  },
];

export function SubscriptionLoginTab({
  keys,
  codexConnected,
  claudeCliDetected,
  claudeCliEnabled,
  onLoggedIn,
}: {
  keys: Record<ProviderId, string | null>;
  codexConnected: boolean;
  claudeCliDetected: boolean;
  claudeCliEnabled: boolean;
  onLoggedIn: () => void;
}) {
  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const state: ConnectionState = {
    keys,
    codexConnected,
    claudeCliDetected,
    claudeCliEnabled,
  };
  const selected = SUBSCRIPTION_PROVIDERS.find((p) => p.id === selectedId);
  const connected = !!selected && selected.isConnected(state);
  const canLogin = !!selected && (selected.canLogin?.(state) ?? true);

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

  const logout = async () => {
    if (!selected) return;
    await selected.logout();
    onLoggedIn();
  };

  const recheckClaudeCli = async () => {
    await refreshClaudeCliDetection();
    onLoggedIn();
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
            <div className="flex items-center gap-2">
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => void logout()}
                className="h-7 px-2.5 text-[11px]"
              >
                Log out
              </Button>
            </div>
          ) : canLogin ? (
            <Button
              size="sm"
              onClick={() => void login()}
              disabled={status === "connecting"}
              className="h-8 w-fit gap-1.5 px-3 text-[11px]"
            >
              {status === "connecting" ? <Spinner className="size-3" /> : null}
              {selected.id === "anthropic"
                ? "Connect Claude Code"
                : `Log in with ${selected.label}`}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                Not found on your PATH.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void recheckClaudeCli()}
                className="h-7 gap-1.5 px-2.5 text-[11px]"
              >
                <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={1.75} />
                Check again
              </Button>
            </div>
          )}
          {status === "error" && error ? (
            <p className="text-[10.5px] text-destructive">{error}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
