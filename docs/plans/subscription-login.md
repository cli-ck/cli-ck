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

## 2. Provider posture

| Provider | Delivers real subscription reuse? | Risk to the user | cli-ck posture |
| --- | --- | --- | --- |
| OpenRouter (OAuth PKCE) | No, pay-as-you-go credits, but removes per-provider key juggling | None, purpose-built for this | First-class, ships first |
| OpenAI / ChatGPT / Codex | Yes, their ChatGPT Plus/Pro | Tolerated, not officially endorsed | First-class, ships second |
| Anthropic (Claude Pro/Max) | Yes, their Claude subscription | Anthropic can ban the user's own account; actively enforced since April 2026 | Experimental, gated behind a warning, ships last and isolated |

## 3. UI design

The existing Models settings screen has one "Providers" block with an
"Add provider" button (`ModelsSection.tsx`, `ProviderKeyCard.tsx`,
`LocalProviderCard`). That block splits into two tabs. Everything else on
the page (Defaults, Model tiers, Model notes, Voice input) stays exactly
where it is today, above the tabs.

- **Providers tab.** Unchanged. Paste a key, same cards as today.
- **Subscription Login tab (new).** A dropdown listing OpenRouter, Claude
  Code, and Codex. Picking one reveals a Login button. Clicking it opens
  that provider's real login page in the system browser. cli-ck listens
  briefly in the background and picks up the result automatically once the
  person signs in, no copy-pasting required, with a paste-the-code box as a
  fallback if the automatic capture ever fails.
- **Shared connection state.** A successful subscription login marks the
  same underlying provider (OpenRouter, OpenAI, or Anthropic) as connected
  everywhere else in the app, the default chat model picker, model tiers,
  autocomplete, exactly as a pasted key would. The two tabs are two ways to
  connect the same thing, not two separate systems.
- **Key vs. login switch.** If a provider ends up with both a saved key and
  a subscription login, a small switch on that provider's card in the
  Providers tab lets the person choose which one is actually used. The app
  does not guess.
- **Claude Code warning.** Because of the account-ban risk, picking
  "Claude Code" in the dropdown shows a one-time warning dialog explaining
  that risk. The Login button only appears after it is acknowledged. This
  gate does not apply to OpenRouter or Codex.

## 4. Architecture decision: in-process, not delegate-to-CLI

Unchanged from the original research. cli-ck holds the login token itself
and attaches it to model calls through a custom `fetch` inside
`buildLanguageModel()` (`ai/lib/aiAgent.ts`), still going through the same
AI SDK path every other provider uses. Delegating to the official
`claude`/`codex` binaries was considered and rejected: cli-ck has no
subprocess-agent runner today, and that path only works when the person
already has the vendor CLI installed.

## 5. Integration points

| Concern | Location | Change |
| --- | --- | --- |
| Providers/Subscription Login tabs | `cli-ck/src/settings/sections/ModelsSection.tsx` | Split the existing "Providers" block into two tabs; new `SubscriptionLoginTab` component with the provider dropdown, Login button, and Claude warning dialog |
| Provider registry | `cli-ck/src/features/ai-companion/ai/config.ts` | New `OAUTH_PROVIDERS` registry: client id, authorize/token URLs, scopes, required local port, per-provider wire details |
| Key vs. login switch | `cli-ck/src/settings/components/ProviderKeyCard.tsx` | Small switch shown only when both a key and a login exist; persisted as a non-secret `providerAuthMethod` preference |
| Request build (auth injection) | `ai/lib/aiAgent.ts`, `buildLanguageModel()` | Branch: subscription login active, use the custom `fetch` path; API key active, use today's `apiKey` path |
| Transport | `cli-ck/src-tauri/src/modules/net.rs` (`ai_http_stream`), `ai/lib/proxyFetch.ts` | Extend to the OAuth cloud hosts; relax the header blocklist for allowlisted OAuth hosts |
| Token storage | `cli-ck/src-tauri/src/modules/secrets.rs`, `ai/lib/keyring.ts` | Store login credentials under a per-provider `*-oauth` keyring account, same mechanism as today's API keys |
| Login callback | new Rust command in `cli-ck/src-tauri/src/` | Ephemeral local listener that catches the browser redirect, verifies it, and hands the result back; paste-code fallback in the UI |
| Gating | `aiChatStore.ts`, `config.ts` (`providerNeedsKey`) | A provider is ready if either a valid login or a valid key is present |

## 6. Phased delivery

Three separate pull requests, safest first, each recorded as its own ADR.

1. **OpenRouter** (`0014-subscription-login-openrouter.md`). Fully safe,
   fully verified before merge.
2. **Codex/ChatGPT** (`0015-subscription-login-codex.md`). Low risk,
   verified by hand against a real account.
3. **Claude Pro/Max** (`0016-subscription-login-claude-experimental.md`).
   Isolated in its own module so it can be pulled out on its own if
   Anthropic escalates further. Off by default in spirit (gated behind the
   warning dialog), left unverified against a real account until one is
   deliberately spent on it.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Anthropic bans a user's account | Warning dialog required before login, clearly separate from the other two providers |
| Anthropic escalates against cli-ck itself | Claude support isolated to its own module and PR, clean revert available |
| A provider changes its login flow and breaks the listener | Each provider's login details live in one file, easy to patch; falls back to the paste-code box |
| Token leaks into the app's webview | Same handling as today's API keys; forbidden-header enforcement already strips caller-supplied auth |

## 8. Explicitly out of scope

- **DeepSeek.** No subscription product exists to bridge. Stays
  API-key-only.
- **Paid or enterprise gating.** This is a free feature for every cli-ck
  user.
- **Sharing one login across machines, or exposing a stored login as a
  local server for other tools to use.** Not needed for this feature.
- **GitHub Copilot subscriptions.** Not requested, not in scope.
