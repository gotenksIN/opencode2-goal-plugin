# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run the test suite.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run build`: Build the ESM distribution bundle.
- `bun run lint`: Run code linter checks.

Always maintain compatibility with the OpenCode V2 plugin API.

## Code standards

- Write source code in TypeScript with ECMAScript Modules (ESM).
- Encapsulate all goal state transitions in `GoalController` (`src/controller.ts`).
- Restrict `GoalStore` (`src/store.ts`) to scoped `ctx.storage` access and cross-process transition locking.
- Use the same per-goal local lock directory for all plugin processes running under one OS account.
- Apply owner-only permissions (`0o700` for the lock directory, `0o600` for lock files) on supported platforms.
- Never import legacy JSON goal databases.
- Treat token accounting as approximate.
- Calculate token estimates using the serialized message length heuristic (`JSON.stringify(messages).length / 4`).
- Validate completion evidence strictly.
- Reject plain assistant prose, unverified assertions, and cross-session tool IDs.

## Test contracts

- Test public and executable interfaces of `GoalController`, `GoalStore`, and plugin hooks.
- Assert state transitions, limit triggers, error conditions, and storage side effects.
- Verify persistence across store instances, scope isolation, and concurrent transitions.
- Verify completion validation: evidence schemas, candidate ID matching, and session isolation.
- Do not write tests that only verify the presence of symbol names, command registrations, or type definitions.
- Let the TypeScript compiler enforce static type relationships.
