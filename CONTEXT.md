# Architecture specification

This document provides the architectural specification for `opencode2-goal-plugin`.
Use this specification to recreate or maintain the plugin from first principles.

## Domain model

The domain model manages session-scoped goals, state history, checkpoints, completion evidence, and execution limits.

### Goal status

```ts
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
```

- `active`: The goal is currently executing. The active duration clock accumulates time.
- `paused`: The goal is paused manually, after turns without progress, or after a failed or interrupted execution. The active clock is stopped.
- `blocked`: The goal is blocked by an external requirement. The active clock is stopped.
- `usageLimited`: Token estimation reached the configured token limit. The active clock is stopped.
- `budgetLimited`: Execution reached maximum duration or maximum continuations. The active clock is stopped.
- `complete`: The goal finished with validated evidence. The active clock is stopped.

### Evidence types

```ts
export const evidenceSources = ["tool", "test", "verification"] as const

export type EvidenceSource = (typeof evidenceSources)[number]

export interface Evidence {
  source: EvidenceSource
  summary: string
  success: true
  toolCallID?: string
  createdAt: string
}

export type EvidenceInput = Omit<Evidence, "createdAt">

export interface EvidenceClaim {
  source: EvidenceSource
  summary: string
  success: boolean
  toolCallID?: string
}
```

- `Evidence`: Stored record of successful goal completion evidence.
- `EvidenceClaim`: Input payload submitted by the model when requesting goal completion.
- `EvidenceInput`: Validated evidence object prepared for persistence.

### Checkpoints and history

```ts
export interface Checkpoint {
  at: string
  summary: string
  source: string
}

export interface HistoryEntry {
  at: string
  action: string
  status: GoalStatus
  detail?: string
}
```

- `Checkpoint`: Progress milestone recorded during tool executions. The store retains the latest 50 entries.
- `HistoryEntry`: Audit log of lifecycle transitions. The store retains the latest 100 entries.

### Goal entity

```ts
export interface Goal {
  sessionID: string
  objective: string
  status: GoalStatus
  blocker?: string
  evidence: Evidence[]
  checkpoints: Checkpoint[]
  history: HistoryEntry[]
  createdAt: string
  updatedAt: string
  activeSince?: string
  activeTimeMs: number
  continuationCount: number
  tokenEstimate: number
  noProgressCount: number
  progressCount?: number
}
```

- `sessionID`: Unique identifier of the session.
- `objective`: Text description of the desired outcome.
- `status`: Current state machine status.
- `blocker`: Blocker description when status is `blocked`.
- `evidence`: Array of validated completion evidence records.
- `checkpoints`: Array of progress checkpoints.
- `history`: Array of lifecycle transitions.
- `createdAt`: ISO 8601 creation timestamp.
- `updatedAt`: ISO 8601 last update timestamp.
- `activeSince`: ISO 8601 timestamp when the current active period began. Undefined when not active.
- `activeTimeMs`: Total accumulated active execution time in milliseconds.
- `continuationCount`: Total number of automated continuation prompts dispatched.
- `tokenEstimate`: Cumulative estimated token count.
- `noProgressCount`: Number of consecutive continuation turns without file edits.
- `progressCount`: Total count of progress-marking tool executions.

### Database and limits

```ts
export interface GoalDatabase {
  version: 1
  goals: Record<string, Goal>
}

export interface GoalLimits {
  maxContinuations?: number
  maxTokens?: number
  maxDurationMs?: number
  noProgressTurns?: number
}

export interface PluginOptions {
  autoContinue?: boolean
  maxContinuations?: number
  continuationIntervalMs?: number
  maxDurationMs?: number
  maxTokens?: number
  noProgressTurns?: number
  dataFile?: string
}
```

All exhaustion limits are disabled unless explicitly configured.
Configure positive integers for continuation and no-progress limits, and finite non-negative numbers for token and duration limits.
Invalid configured limits are rejected.
`continuationIntervalMs` defaults to `1500`.
The token counter sums approximate request context lengths, not provider billing or context limits.

## Goal state machine

The goal controller (`src/controller.ts`) manages all state transitions.
It wraps state mutations inside atomic update operations on the goal store.

```
                  ┌───────────────┐
                  │    created    │
                  └───────┬───────┘
                          │ create()
                          ▼
                  ┌───────────────┐
       ┌─────────►│    active     │◄────────┐
       │          └───┬───┬───┬───┘         │
       │              │   │   │             │
resume │   ┌──────────┘   │   └─────────┐   │ resume
       │   │ pause /      │ blocked     │   │
       │   │ no-progress  │             │   │
       │   ▼              ▼             ▼   │
     ┌─────────┐    ┌─────────┐    ┌────────┴────────┐
     │ paused  │    │ blocked │    │  budgetLimited  │
     └─────────┘    └─────────┘    │  usageLimited   │
          │              │         └─────────────────┘
          │              │                  │
          └──────────────┼──────────────────┘
                         │ complete() (with valid evidence)
                         ▼
                  ┌───────────────┐
                  │   complete    │
                  └───────────────┘
```

### Transition rules

1. `create(sessionID, objective)`:
   - Trims and validates the objective string.
   - Throws an error if the objective is empty.
   - Throws an error if an incomplete goal already exists for `sessionID`.
   - Sets status to `active`, sets `activeSince = now()`, initializes `activeTimeMs = 0`, and records a `"created"` history entry.

2. `update(sessionID, "pause")`:
   - Throws an error if no goal exists or if the goal is `complete`.
   - Accumulates active time into `activeTimeMs` and deletes `activeSince`.
   - Sets status to `paused` and records a `"pause"` history entry.

3. `update(sessionID, "resume")`:
   - Throws an error if no goal exists or if the goal is `complete`.
   - If status is already `active`, records a `"resume"` history entry with `"Already active"` detail.
   - Otherwise, sets status to `active`, sets `activeSince = now()`, deletes `blocker`, resets `noProgressCount = 0`, and records a `"resume"` history entry.

4. `update(sessionID, "blocked", detail)`:
   - Throws an error if no goal exists or if the goal is `complete`.
   - Throws an error if `detail.blocker` is missing or empty.
   - Accumulates active time into `activeTimeMs` and deletes `activeSince`.
   - Sets status to `blocked`, stores `goal.blocker`, and records a `"blocked"` history entry.

5. `update(sessionID, "complete", detail)`:
   - Throws an error if no goal exists or if the goal is `complete`.
   - Validates the structured evidence:
     - Must be a non-null object.
     - `source` must be `"tool"`, `"test"`, or `"verification"`.
     - `success` must be `true`.
     - `summary` must be a string with trimmed length of at least 3 characters.
     - `toolCallID` must be a non-empty string.
   - Accumulates active time into `activeTimeMs` and deletes `activeSince`.
   - Appends `{ ...evidence, createdAt: now() }` to `goal.evidence`.
   - Sets status to `complete` and records a `"complete"` history entry.

6. `clear(sessionID)`:
   - Deletes the goal entry from the persistent database.

7. `pauseAfterExecution(sessionID, outcome, detail)`:
   - Executes only when an active goal exists for the session.
   - Sets status to `paused` after a terminal failed or interrupted execution.
   - Stops the active clock and records an `"execution-failed"` or `"execution-interrupted"` history entry.

8. `checkpoint(sessionID, summary, source, madeProgress)`:
   - Executes only when an active goal exists for the session.
   - Appends `{ at: now(), summary, source }` to `goal.checkpoints` and caps the array at 50 entries.
   - When `madeProgress` is `true`, resets `noProgressCount = 0` and increments `progressCount`.
   - Records a `"checkpoint"` history entry.

9. `account(sessionID, tokenEstimate, continuation, madeProgress)`:
   - Executes only when an active goal exists for the session.
   - Adds non-negative rounded `tokenEstimate` to `goal.tokenEstimate`.
   - Increments `continuationCount` when `continuation` is `true`.
   - Updates `noProgressCount`: resets to `0` when `madeProgress` is `true`, or increments by `1` on continuation.
   - Calculates total elapsed active time (`activeTimeMs` plus current active slice).
   - Evaluates only configured limit boundaries in order:
     1. If `tokenEstimate >= limits.maxTokens`, sets status to `usageLimited`.
     2. Else if `elapsed >= limits.maxDurationMs` or `continuationCount >= limits.maxContinuations`, sets status to `budgetLimited`.
     3. Else if `noProgressCount >= limits.noProgressTurns`, sets status to `paused` with action `"no-progress-pause"`.
   - When a limit triggers, stops the active clock and records a history entry.

## Persistence specification

`GoalStore` (`src/store.ts`) provides persistent disk storage.

### JSON schema

The database file stores a single JSON document adhering to schema version 1:

```json
{
  "version": 1,
  "goals": {
    "ses_example_1": {
      "sessionID": "ses_example_1",
      "objective": "Implement the feature",
      "status": "active",
      "evidence": [],
      "checkpoints": [],
      "history": [],
      "createdAt": "2026-08-25T10:00:00.000Z",
      "updatedAt": "2026-08-25T10:00:00.000Z",
      "activeSince": "2026-08-25T10:00:00.000Z",
      "activeTimeMs": 0,
      "continuationCount": 0,
      "tokenEstimate": 1200,
      "noProgressCount": 0,
      "progressCount": 0
    }
  }
}
```

### Path resolution and file permissions

- Custom path: When `options.dataFile` is set, expand leading `~/` to `homedir()`.
- Default path: Use `${XDG_DATA_HOME:-~/.local/share}/opencode-goal-plugin/goals.json`.
- Directory permissions: Create parent directories recursively with mode `0o700`. Apply `chmod(dir, 0o700)` for default plugin paths. Preserve directory permissions when using custom paths (`protectDirectory = false`).
- File permissions: Write database and lock files with mode `0o600`. Enforce `chmod(file, 0o600)` after writes.

### Cross-process locking protocol

`GoalStore` uses hard-link locking to synchronize access across separate processes:

1. The lock file path is `${this.path}.lock`.
2. Generate a random UUID token.
3. Write a candidate lock file `${lockPath}.${process.pid}.${token}.tmp` containing JSON `{ pid: process.pid, token }` using exclusive creation flag `"wx"` and mode `0o600`.
4. Poll until the deadline (`Date.now() + 5000ms`) with a `10ms` delay between attempts:
   - Call `link(candidate, lockPath)`. Hard-link creation is atomic on POSIX filesystems.
   - On success: delete the candidate file with `unlink(candidate)` and return the release callback.
   - On `EEXIST` (lock currently held):
     - Read the existing lock file and parse the owner PID.
     - Check owner process aliveness using `process.kill(pid, 0)`.
     - If `kill` throws `ESRCH` (owner process terminated), throw an error: `"Remove stale goal store lock before retrying: <lockPath>"`.
     - Otherwise, wait for the next retry interval.
   - On any unexpected error: delete the candidate file and rethrow.
5. If the deadline expires: delete the candidate file and throw a lock timeout error.
6. Lock release:
   - Read `${lockPath}`.
   - Unlink `${lockPath}` only if `lock.token` matches the candidate token.
7. In-process serialization:
   - Queue store operations through an internal promise chain (`this.queue`) to avoid in-process lock contention.

### Atomic file replacement

When writing database updates:

1. Ensure the parent directory exists.
2. Write serialized JSON to a unique temporary file `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp` with mode `0o600`.
3. Replace the target file using atomic `rename(temporary, this.path)`.
4. Enforce file permissions `0o600` on the target file.
5. On failure, remove the temporary file with `unlink` and rethrow the error.

## Evidence candidate tracking

To verify goal completion, the plugin tracks valid tool call IDs in memory:

- Hook: `ctx.tool.hook("execute.after")`.
- Filtering:
  - Skip processing when the plugin is stopped.
  - Skip goal management tools (`get_goal`, `create_goal`, `update_goal`, `clear_goal`).
  - Reject hook errors and completed events whose structured result does not establish success.
  - For `shell`, require a completed foreground process with exit code `0` and no timeout.
  - For Code Mode `execute`, reject JavaScript errors and any child call that is running or failed.
  - Treat nested Code Mode calls with the same call ID as one evidence outcome. Any failed nested outcome invalidates that ID.
- Active check: Verify that the session has a stored goal with status `active`.
- In-memory candidate cache:
  - Map `sessionID` to an array of recent tool call IDs.
  - Retain up to 20 candidate IDs per session.
  - Cap tracked sessions at 100 using LRU eviction (delete oldest session key when capacity is exceeded).
- Checkpoint creation:
  - Record a checkpoint with summary `"Successful <tool> tool call"`.
  - Tool calls from `"edit"`, `"write"`, and `"patch"` pass `madeProgress = true`.
- Strict validation in `update_goal`:
  - When `action === "complete"`, `evidence.toolCallID` must match an ID in `evidenceCandidates.get(sessionID)`.
  - Reject foreign, synthetic, or cross-session IDs.
  - Delete `evidenceCandidates` for the session after successful completion.

## Prompt injection and session hook

The plugin injects active goal state into model context on each turn:

- Hook: `ctx.session.hook("context")`.
- Process:
  1. Retrieve the persisted goal for `event.sessionID`. Exit early if no goal exists.
  2. Calculate the estimated token count using `Math.ceil(JSON.stringify(event.messages).length / 4)`.
  3. Call `controller.account(event.sessionID, estimatedTokens)`.
  4. Build the system message text:
     - Header: `[Persisted goal]`
     - Include objective and current status.
     - Include blocker text if status is `blocked`.
     - Add status instruction:
       - Active goals: `"Continue work toward this goal. Use goal tools for every state change. Complete only with successful structured evidence."`
       - Inactive goals: `"Do not silently continue this goal because its state is <status>."`
     - Add candidate evidence instructions:
       - If candidates exist: include the list of valid candidate IDs and instruct the model to copy an exact ID.
       - If candidates list is empty: instruct the model to run a successful non-goal verification tool.
  5. Push the text object to `event.system` with metadata `{ plugin: "opencode.goal" }`.

## Auto-continuation engine

The plugin automatically prompts the session agent after successful execution:

- Subscription: Subscribes to the OpenCode event stream via `ctx.event.subscribe({ signal })`.
- Handled events:
  - `session.execution.succeeded` settles the previous continuation and schedules the next prompt.
  - `session.execution.failed` pauses an active goal and cancels scheduled or pending continuation state.
  - `session.execution.interrupted` pauses an active goal and cancels scheduled or pending continuation state.
- Session ownership:
  - Load the session before settlement, terminal pausing, scheduling, and prompt dispatch.
  - Require the session `projectID`, location directory, and optional workspace ID to match the plugin instance `ctx.location`.
  - Ignore events for sessions owned by another project or plugin location.
  - Recheck ownership immediately before prompt dispatch.
- Turn settlement:
  - Check for a pending continuation on the session.
  - Compare current `goal.progressCount` against the count stored before the turn.
  - Call `controller.account(sessionID, 0, true, madeProgress)` to advance counters and evaluate no-progress limits.
- Debounce and concurrency guard:
  - Skip scheduling if a continuation is already scheduled or in-flight for `sessionID`.
  - Defer scheduling until prompt admission returns when execution succeeds during admission.
  - Schedule continuation with `setTimeout` using `continuationIntervalMs` (default `1500ms`).
  - Track each active timer by session in `scheduled`.
- Prompt dispatch:
  - Retrieve the persisted goal and verify status is `active`.
  - Record the current `progressCount` in `pendingContinuations`.
  - Dispatch a prompt via `ctx.session.prompt`:
    - `text`: `"Continue the persisted goal from the latest checkpoint. Do not mark it complete without successful structured evidence."`
    - `metadata`: `{ plugin: "opencode.goal", continuation: goal.continuationCount + 1 }`.
- Subagent handling:
  - Query `ctx.session.get({ sessionID })`.
  - If `session.parentID` is present, the session is a subagent.
  - Bypass `ctx.session.interrupt` on pause, blocked, or clear actions for subagents.
- Teardown:
  - Set `stopped = true`.
  - Clear all timers and candidate maps.
  - Abort the event stream iterator.
  - Do not wait for unresolved prompt admission because the Promise plugin adapter cannot cancel it.
  - Invalidate in-flight admission before terminal cancellation can pause the goal.

## Command transform

The plugin registers the `/goal` command via `ctx.command.transform`:

- Registers command name `"goal"` with descriptive help.
- Formats prompt instruction text mapping user subcommands to tool invocations:
  - `status` or empty arguments -> `get_goal`
  - Plain objective text or `create <objective>` -> `create_goal`
  - `pause`, `resume`, `blocked <reason>` -> `update_goal`
  - `complete <evidence>` -> `update_goal` with evidence validation
  - `clear` -> `clear_goal`
- Preserves context mentions and parameters:
  - Maps `prompt.files` (`uri`, `name`, `description`).
  - Maps `prompt.agents` (`name`).
  - Maps `prompt.skills` (`id`).
  - Forwards `delivery` mode (`steer` or `queue`).
- Dispatches formatted instructions via `ctx.session.prompt`.

## Packaging and runtime dependencies

The package manifest and build must follow strict rules to maintain compatibility with OpenCode V2:

### Dependency declaration

- Declare `@opencode/plugin` under `dependencies`.
- Pin exact versions (such as `"2.0.2"`).
- Do not mark `@opencode/plugin` as an optional peer dependency. OpenCode V2's Bun runtime loads server plugins via standard dynamic import without synthetic module interception.

### Tool schema provider compatibility

- Use standard JSON Schema primitives across all registered tool schemas.
- Do not use boolean `const` properties (such as `{ type: "boolean", const: true }`).
- Downstream model providers (such as Google Gemini) translate boolean `const` values into invalid string enums (`TYPE_STRING`) and reject the tool schema.
- Enforce boolean literals (such as `success: true`) in runtime controller validation instead.

### Entrypoints and package contents

- Set `"main": "./dist/index.js"`.
- Set `"exports"`:
  ```json
  "exports": {
    ".": "./dist/index.js",
    "./source": "./index.ts"
  }
  ```
- Build the standalone ESM bundle with `bun build index.ts --outdir dist --target bun --format esm --external @opencode/plugin`.
- Restrict `"files"` in `package.json` to `["dist", "index.ts", "src"]`.
- Package managers automatically bundle `package.json`, `README.md`, and `LICENSE`. Internal agent specifications (`AGENTS.md`, `CONTEXT.md`) and tests remain excluded from the registry tarball.
