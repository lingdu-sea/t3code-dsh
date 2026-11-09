# DSH Native Provider — staged integration acceptance

> Status: **NOT APPROVED FOR PRODUCTION**. This document is an execution and evidence checklist, not a record of a successful live DSH run.
> Target: PR #1, branch `feat/dsh-native-provider`.
> SDK pinned: `@deepseek-ai/dsh-sdk-client@0.2.2-rc.1`.

## Evidence levels

| Level | What it proves | Status |
| --- | --- | --- |
| L0 — Type safety | T3 server/client + DSH Provider compile under exact frozen dependencies | **PASS** |
| L1 — SDK protocol | The published SDK can exchange events/approvals/questions with a real child process using an offline fixture; actual SDK-shipped DSH runtime starts and closes without model credentials | **PASS** |
| L2a — T3 adapter event link | T3 ProviderAdapterV2 receives SDK messages, tool traces, permission requests and structured questions, and correctly reports crash/instance-separated events | **PASS (offline test)** |
| L2b — T3 storage/UI E2E | Browser operation, database persistence, replay and UI controls work with the provider in the actual T3 server | **NOT VERIFIED** |
| L3 — Live DSH model | SDK launches the actual DSH profile, authorizes a model route, performs a bounded model inference and a safe tool task | **NOT VERIFIED** |
| L4 — Multi-user safety | Two authenticated users with separate permissions/credentials remain isolated in the running platform | **NOT VERIFIED** |
| L5 — Release | Full build, regression, adversarial tests, owner approval and rollback mechanism | **NOT VERIFIED** |

Verified CI evidence:
- [T3 adapter and inherited-environment tests — 6 files, 29 passing](https://github.com/lingdu-sea/t3code-dsh/actions/runs/42590428012)
- [Actual SDK-shipped DSH runtime handshake, no model requests or secrets](https://github.com/lingdu-sea/t3code-dsh/actions/runs/42591067899)
- The actual-runtime handshake deliberately uses registered provider `deepseek-official` and model ID `deepseek-v4-flash`; the initial attempt with the fake route was rejected as expected. No generated output or model authorization is implied.

### Security findings from this iteration

- **P0 prevented:** The initial driver forwarded all inherited T3 server environment variables except a small key list. It now supplies only a minimal launch-variable allowlist to the DSH SDK subprocess, and merges deliberately bound Provider-instance variables separately. Tests verify that GitHub, AWS, database, model secrets and `NODE_OPTIONS` are not implicitly forwarded.
- Persistence subdirectories now hash **both Provider-instance and thread IDs** rather than including their external spellings as paths.
- These changes prevent environment leak by ordinary inheritance and path traversal by ID; they **do not** establish a tenant security boundary. A DSH child still runs with the T3 server's underlying OS identity and may access its filesystem. Strong multi-user isolation needs separate OS/container identities, filesystem scoping, access controls and integration tests.

## Preconditions for live validation

- Use an **isolated test host and throwaway workspace**, not production or sensitive engineering/bidding documents.
- Install the pinned DSH CLI/SDK route matching this branch; its SDK `sdk` profile must be launchable as a child process.
- Create a dedicated **least-privilege model API credential** with small usage limits, injected through the provider's secret environment binding. Never place secrets in Git, screenshots, issue comments, or test logs.
- Set the DSH provider route and exact model ID in Provider settings; never rely on the successful handshake to imply model credentials are usable.
- Keep DSH **disabled outside the isolated test instance**, and use **Supervised / approval-required** mode only.

## Mandatory execution cases

| ID | Test action | Acceptance criteria | Severity |
| --- | --- | --- | --- |
| DSH-LIVE-01 | Enable DSH; run a simple text prompt | One native session created; a model reply appears; final status is `completed`; no fabricated success | P0 |
| DSH-LIVE-02 | Ask for a read-only tool operation, then deny | No underlying operation performed; denial visible and recorded | P0 |
| DSH-LIVE-03 | Repeat allowed read-only operation with `Allow once` | One operation only; grant not reused on later operation | P0 |
| DSH-LIVE-04 | Request a file write or command outside the allowed boundary | Denial or explicit user approval; no execution without permission | P0 |
| DSH-LIVE-05 | Exercise a DSH structured question | Correct prompt, options, answer, cancellation, and no auto-answer | P0 |
| DSH-LIVE-06 | Restart a completed conversation and continue | Same persisted session identity/history; no unexpected new session; no repeated side effects | P0 |
| DSH-LIVE-07 | Inject process crash and interrupted turn | Run not marked success; errors surfaced; active approvals closed; no orphan process | P0 |
| DSH-LIVE-08 | Two independent T3 sessions and two user accounts | Distinct subprocess, home, sessions, credentials and event feeds; no cross-user access or event bleed | P0 |
| DSH-LIVE-09 | Trigger tool start/result and model output | UI and event store show correct name, arguments, outcome, timestamps and evidence trail | P1 |
| DSH-LIVE-10 | Send unsupported attachments, plans, forks and stop requests | Explicitly rejected or disabled, never presented as supported | P0 |
| DSH-LIVE-11 | Try inherited environment variables from another Provider | Only explicitly bound secrets reach the DSH child; other Provider keys are absent | P0 |
| DSH-LIVE-12 | Run baseline Codex/Claude sessions after enabling/disabling DSH | No regression in existing Provider selection, authentication, chats or permissions | P1 |

**Safety decision:** per-session Stop is currently **unsupported** by this adapter. The UI must not promise that interrupting the T3 task cancels DSH safely. Enabling this feature requires an SDK capability or a proven isolated subprocess kill/reap strategy with durable terminal reconciliation.

## Evidence that must be retained per case

1. Exact commit SHA, SDK version, Node and pnpm versions, OS; use sanitized host and directory names.
2. Test case ID, scenario/inputs, start/end time, expected vs actual behavior.
3. Provider session ID + T3 thread/run IDs in **redacted** form, request correlation IDs, terminal reason.
4. Selected relevant event log, tool permission request/result, subprocess exit status, and rerun evidence.
5. Exit code of each gate command, failing log excerpt and corresponding fix commit.
6. Reviewer, release decision, unresolved P0/P1 issues and rollback conditions.

Do **not** commit credentials, raw private documents, unredacted user prompts, or production logs.

## Local gate commands

```bash
pnpm install --frozen-lockfile
pnpm --filter '@t3tools/provider-dsh' typecheck
pnpm --filter '@t3tools/client-runtime' typecheck
pnpm --filter 't3' typecheck
pnpm --filter '@t3tools/provider-dsh' test
```

The published SDK subprocess fixture exercises protocol behavior without API access; **running those tests does not constitute L2 or L3 approval**.

## Release decision criteria

- No unresolved P0 defects, especially authorization bypass, cross-account leak, orphan subprocess, fabricated success or silent replay of side effects.
- L2, L3, L4 and L5 have independent evidence and sign-off.
- Complete product limitations are displayed to end-users. Do not enable DSH by default or merge PR #1 before approval.
