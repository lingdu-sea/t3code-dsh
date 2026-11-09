# DeepSeek Harness — native provider (development preview)

This fork adds a **native SDK/JSON-RPC** provider called **DeepSeek Harness** (driver kind `dsh`). This is **not** the generic ACP provider.

## Current implementation

- Dedicated `packages/provider-dsh` module, provider registration, model defaults and browser/mobile client registration.
- Starts an isolated DeepSeek Harness SDK runtime using `@deepseek-ai/dsh-sdk-client` and the `sdk` profile.
- Supports creating a T3 thread, submitting a text turn, displaying its final assistant message, persistent DSH session identity, and resuming a previously persisted session.
- DSH CLI version health probe, manually configurable DSH executable path, model ID and provider route.
- Default safety: disabled until configured; Supervised mode only; denies SDK permission requests and cancels native user-question requests until a UI handler is implemented.
- Existing providers stay registered unchanged.

## Not ready for general use

**Unverified preview; do not merge to main or use against important workspaces yet.**

The following are explicitly not implemented: streaming and tool-call trace projection; user-question/approval UI; per-session Stop/cancellation; structured subagent views; conversation rollback/fork; attachment forwarding; provider-owned text generation. DSH SDK currently has no dedicated per-session cancel and close protocol. Status 'ready' only proves the CLI version command ran successfully, **not** provider authentication or runtime readiness. This adapter is not yet production qualified.

The dependency `@deepseek-ai/dsh-sdk-client@0.2.2-rc.1` is a prerelease and needs a dependency lockfile refresh (`pnpm install`) and a dependency/security review. The root lockfile was not regenerated in this branch. Validate against pinned T3 and DSH commits before release.

## Testing and release gate

1. Regenerate and commit the pnpm lockfile in a full working copy. Run install on a separate test environment.
2. Run full typecheck, lint and tests, and fix any failures.
3. Confirm DSH SDK CLI, runtime profile and model route availability; run an isolated test workspace with no sensitive data.
4. Record native SDK event fixtures: text, tools, permissions, failure, resumed session, parallel sessions, unexpected subprocess exit.
5. Implement missing event and permission UI mapping and a scoped cancellation strategy.
6. Run comprehensive regression tests for Codex, Claude and other built-in providers.
7. Obtain independent security review before merging and enabling by default.

Useful references: [T3 provider integration](../../docs/internals/adding-a-provider.md), [DSH native SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk).
