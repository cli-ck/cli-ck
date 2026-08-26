# Subscription Login Plan

**Feature:** let cli-ck users connect a provider with their existing paid
subscription (OpenRouter, ChatGPT/Codex, Claude Pro/Max) instead of only
accepting a per-provider API key.

**Status:** approved, ready to build. Free for every cli-ck user, no paid
gate, no enterprise-only restriction.

Builds on the research already captured at the repo root in
`SUBSCRIPTION_OAUTH_ROADMAP.md` (reference implementations studied:
`can1357/oh-my-pi`, `paperclipai/paperclip`, `sst/opencode`), refined here
with a concrete UI design and two scope changes agreed after that first
pass.

## 1. What changed since the first pass

- **DeepSeek dropped.** Checked live: DeepSeek's chat product is free with
  no paid subscription tier, so there is nothing to bridge. DeepSeek stays
  API-key only, as it already is today.
- **Anthropic's enforcement is no longer a future risk, it already
  happened.** Anthropic began blocking third-party subscription reuse in
  January 2026 and enforced it fully in April 2026, forcing other tools
  (OpenCode included) to remove Claude support. The posture below was
  already conservative about this; this just confirms it was right to be.
- **No billing or enterprise gating.** This ships as a normal, free
  capability, not a paid tier. `cli-ck-billing` needs no changes for this.
- **A concrete UI design**, described in section 3, replacing the earlier
  toggle-only sketch.
- **Claude Pro/Max no longer means our own OAuth login.** The original plan
  called for the same wire-impersonation technique `oh-my-pi` uses: replaying
  Claude Code's internal headers and attestation signals so Anthropic's
  servers cannot tell cli-ck apart from their own client. That is not a login
  flow, it is software built to defeat Anthropic's technical anti-abuse
  detection, and we are not building that regardless of the account-risk
  framing, since the party being evaded is not the one consenting. Section 3
  below replaces it with detecting and delegating to an already-installed,
  already-logged-in `claude` CLI, which uses Claude exactly the way
  Anthropic's terms allow.

## 2. Provider posture

| Provider | Delivers real subscription reuse? | Risk | cli-ck posture |
| --- | --- | --- | --- |
| OpenRouter (OAuth PKCE) | No, pay-as-you-go credits, but removes per-provider key juggling | None, purpose-built for this | First-class, ships first |
| OpenAI / ChatGPT / Codex | Yes, their ChatGPT Plus/Pro | Tolerated, not officially endorsed | First-class, ships second |
| Anthropic (Claude Pro/Max) | Yes, via the user's own installed Claude CLI | None, uses Anthropic's own official client | Ships last, only appears when `claude` is detected on PATH |

## 3. UI design

The existing Models settings screen has one "Providers" block with an
"Add provider" button (`ModelsSection.tsx`, `ProviderKeyCard.tsx`,
`LocalProviderCard`). That block splits into two tabs. Everything else on
the page (Defaults, Model tiers, Model notes, Voice input) stays exactly
where it is today, above the tabs.

- **Providers tab.** Unchanged. Paste a key, same cards as today.
- **Subscription Login tab (new).** A dropdown listing OpenRouter, Codex,
  and, only when detected, Claude Code.
  - OpenRouter and Codex: picking one reveals a Login button. Clicking it
    opens that provider's real login page in the system browser. cli-ck
    listens briefly in the background and picks up the result automatically
    once the person signs in, no copy-pasting required, with a
    paste-the-code box as a fallback if the automatic capture ever fails.
  - Claude Code: no login button at all. cli-ck checks whether `claude` is
    on the person's PATH; if so, this option shows "Detected" and is usable
    immediately, since it is already logged into their subscription. If not
    found, this option does not appear in the dropdown; Claude stays
    available the normal way, by pasting an Anthropic API key in the
    Providers tab.
- **Shared connection state.** A successful subscription login (or, for
  Claude, a successful detection) marks the same underlying provider
  (OpenRouter, OpenAI, or Anthropic) as connected everywhere else in the
  app, the default chat model picker, model tiers, autocomplete, exactly as
  a pasted key would. The two tabs are two ways to connect the same thing,
  not two separate systems.
- **Key vs. login switch.** If a provider ends up with both a saved key and
  a subscription connection, a small switch on that provider's card in the
  Providers tab lets the person choose which one is actually used. The app
  does not guess.

## 4. Architecture decision: in-process for OpenRouter/Codex, delegate-to-CLI for Claude

OpenRouter and Codex: cli-ck holds the login token itself and attaches it to
model calls through a custom `fetch` inside `buildLanguageModel()`
(`ai/lib/aiAgent.ts`), still going through the same AI SDK path every other
provider uses.

Claude: the opposite choice, and deliberately so. cli-ck does not hold a
Claude credential of its own at all. It spawns the user's own `claude`
binary as a managed background process, reusing the external-agent
infrastructure already shipped for [[0012-ai-agent-meta-orchestration]]
(`shell::shell_bg_*`), and talks to it the same way that infrastructure
already talks to external coding agents.

## 5. Integration points

| Concern | Location | Change |
| --- | --- | --- |
| Providers/Subscription Login tabs | `cli-ck/src/settings/sections/ModelsSection.tsx` | Split the existing "Providers" block into two tabs; new subscription-login tab component with the provider dropdown and Login button (or "Detected" for Claude) |
| Provider registry | `cli-ck/src/features/ai-companion/ai/lib/oauth/` (new) | Per-provider client id, authorize/token URLs, scopes, required local port |
| Key vs. login switch | `cli-ck/src/settings/components/ProviderKeyCard.tsx` | Small switch shown only when both a key and a login exist; persisted as a non-secret `providerAuthMethod` preference |
| Request build (auth injection, OpenRouter/Codex) | `ai/lib/keyring.ts` effective-keys resolution | The stored OAuth access token stands in for the provider's API key wherever keys are read; no `buildLanguageModel()` changes needed |
| Request build (Claude) | new Rust command alongside `shell::shell_bg_*` | Detects `claude` on PATH (the same `which` crate already used in `lsp/env.rs`) and spawns it as a managed background process per [[0012-ai-agent-meta-orchestration]] |
| Token storage | `cli-ck/src-tauri/src/modules/secrets.rs`, `ai/lib/keyring.ts` | OpenRouter/Codex login credentials stored under a per-provider `*-oauth` keyring account, same mechanism as today's API keys. Nothing stored for Claude, there is no credential of our own |
| Login callback | new Rust command `oauth_loopback_listen` | Ephemeral local listener that catches the browser redirect for OpenRouter/Codex, verifies it, and hands the result back; paste-code fallback in the UI |
| Gating | `aiChatStore.ts`, `config.ts` (`providerNeedsKey`) | A provider is ready if a valid login, a detected CLI, or a valid key is present |

## 6. Phased delivery

Three vertical slices, safest first, each recorded as its own ADR, delivered
as one PR with one commit per slice.

1. **OpenRouter** (`0014-subscription-login-openrouter.md`). Fully safe,
   fully verified before merge.
2. **Codex/ChatGPT** (`0015-subscription-login-codex.md`). Low risk, login
   verified end-to-end; full chat-request fidelity against OpenAI's
   ChatGPT backend needs manual verification against a real account.
3. **Claude Pro/Max** (`0016-subscription-login-claude-experimental.md`).
   No credential of our own, no risk, ships last because it is additive and
   independent of the other two.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A provider changes its login flow and breaks the listener | Each provider's login details live in one file, easy to patch; falls back to the paste-code box |
| Token leaks into the app's webview | Same handling as today's API keys; forbidden-header enforcement already strips caller-supplied auth |
| `claude` CLI not on PATH, or not logged in | Claude Code option simply does not appear in the dropdown; Claude stays available via API key |

## 8. Explicitly out of scope

- **DeepSeek.** No subscription product exists to bridge. Stays
  API-key-only.
- **Paid or enterprise gating.** This is a free feature for every cli-ck
  user.
- **Sharing one login across machines, or exposing a stored login as a
  local server for other tools to use.** Not needed for this feature.
- **GitHub Copilot subscriptions.** Not requested, not in scope.
