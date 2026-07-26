# AGENTS.md

This file defines working guidelines for AI coding agents in this repository.

## Project Overview

- Name: Chascuro
- Purpose: Experimental, mobile-first Fedimint wallet PWA with Marmot chat integration. Do not use it with real funds.
- Stack: React + TypeScript + Vite + Vitest + Playwright
- Package manager: npm (use the committed `package-lock.json`)
- App source: `src/`
- UI and app composition: `src/app/`, `src/features/`, `src/styles/`
- Domain and services: `src/domain/`, `src/services/`
- Tests: colocated `*.test.ts(x)` files under `src/`; E2E tests in `e2e/`
- Marmot runtime: `runtime/marmot-web/`; supporting scripts: `scripts/`

## Primary Goals For Agents

1. Make minimal, focused changes that solve the user request.
2. Preserve existing architecture, naming, and style conventions.
3. Keep wallet and chat behavior safe and predictable (no silent behavior changes).
4. Validate changes with relevant tests or type checks when feasible.

## Safety Rules

- Do not hardcode secrets, private keys, mnemonics, tokens, or relay credentials.
- Do not log sensitive values (passwords, seeds, mnemonics, `nsec`, auth headers, session material, or encrypted-record contents).
- Do not weaken existing security controls (vault encryption, session guard, inactivity lock, exclusive wallet ownership, CSP/security headers, or PWA/service-worker behavior).
- Preserve the production safeguards around fake-wallet, test-wallet, and insecure-localhost modes; they must remain development/E2E-only.
- Read `THREAT_MODEL.md` and `SECURITY.md` before changing a security-sensitive flow or boundary.
- Avoid destructive git commands unless explicitly requested.

## Editing Guidelines

- Prefer small diffs over broad refactors.
- Match existing coding patterns before introducing new abstractions.
- Add brief comments only for non-obvious logic.
- Update docs when behavior, flows, developer commands, or security assumptions change.

## Frontend Conventions

- Reuse feature-local and shared UI from `src/features/` before creating new components.
- Keep state close to the feature; lift only when needed.
- Preserve accessibility basics: labels, keyboard flow, focus visibility, semantic elements.
- Keep responsive behavior intact for mobile-first wallet usage.
- Respect the current CSS organization: `src/styles.css` imports shared styles from `src/styles/`.
- Extend the established CSS and component patterns; this repository does not use Tailwind.

## TypeScript And Quality Bar

- Favor explicit types on public boundaries and complex return values.
- Avoid `any` unless there is no practical alternative.
- Handle nullable/undefined values defensively around wallet, persistence, browser-capability, and network operations.
- Surface user-facing errors clearly with existing UI primitives.

## Testing Expectations

Use the smallest meaningful validation first, then expand if needed.

- Unit/integration (Vitest): target impacted files and logic paths; tests are normally colocated with source.
- E2E (Playwright): run when changes affect critical flows (onboarding, wallet setup, send/receive, offline PWA behavior, or chat).
- Marmot changes: use the relevant `test:e2e:marmot-*` command and/or `check:marmot-wasm` as appropriate.
- For bug fixes, add or update at least one test when practical.

Suggested commands (run from repository root):

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run check
npm run test:e2e
```

For specialized SDK, Marmot, relay, native-peer, or live-federation validation, inspect `package.json` and use the relevant `test:e2e:*` script. Do not run live-federation tests unless the task requires them and their environment is available.

## Local Runtime And Infrastructure

- Use `runtime/marmot-web/` and its scripts when changing the Marmot browser/WASM runtime.
- Use `scripts/nostr-test-relay.mjs` and the relevant E2E configuration when reproducing relay behavior.
- Treat regtest as a network mode, not a standalone top-level tool directory; prefer deterministic, scriptable setup over manual one-off configuration.
- Record assumptions in PR or patch notes when environment parity is incomplete.

## Workflow For Agents

1. Read the request and inspect only relevant files.
2. Propose or apply minimal changes.
3. Run focused checks/tests for touched behavior.
4. Summarize what changed, validation performed, and residual risks.

## Commit Guidance

- If asked to commit, keep commits atomic and descriptive.
- Group related code, tests, and docs in the same commit.
- Avoid mixing unrelated cleanups with functional changes.

## Definition Of Done

A task is complete when:

1. The requested behavior is implemented.
2. Relevant checks/tests pass or failures are explained.
3. No obvious regressions are introduced in nearby flows.
4. Documentation is updated when needed.

## Quick File Map

- App entry: `src/main.tsx`, `src/app/App.tsx`
- App controller and records: `src/app/`
- Features and shared UI: `src/features/`
- Domain logic: `src/domain/`
- Wallet, persistence, security, Arkade, LNURL, and chat services: `src/services/`
- Styling: `src/styles.css`, `src/styles/`
- PWA and deployment security headers: `vite.config.ts`, `src/config/security-headers.ts`
- E2E configuration: `playwright.config.ts`, `e2e/config/`
- Build and tooling config: `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `tsconfig.json`

## Notes For Future Agents

- Prefer `rg` for fast search and targeted code discovery.
- Validate only what is relevant to keep iteration fast.
- If you discover repository-specific conventions not listed here, propose an update to this file rather than changing it opportunistically.
