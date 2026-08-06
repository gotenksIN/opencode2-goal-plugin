# Project Instructions

## Tooling

- Use Bun to install dependencies, run tests, check types, and build the project.
- Do not use `npm`, `npx`, or `bunx`.
- Maintain compatibility with the OpenCode V2 API.

## Code Standards

- Write code in TypeScript using ECMAScript Modules (ESM).
- Keep state transitions in the goal controller class (`src/controller.ts`).
- Ensure file persistence is atomic with owner-only file permissions where supported.
- Do not accept assistant prose text as goal completion evidence.
- Mark token accounting as approximate.

## Verification

- Run `bun test`, `bun run typecheck`, and `bun run build` after you make code changes.
