# Goal plugin for OpenCode

This plugin stores and tracks one persistent goal for each OpenCode session.
It provides the `/goal` command, four goal management tools, verification-gated completion, progress checkpoints, and automatic session continuation.
It does not add a terminal user interface indicator.

## Installation

Add the plugin package to your `opencode.json` or `opencode.jsonc` configuration file.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode2-goal-plugin@1.0.3",
      "options": {
        "autoContinue": true,
        "maxContinuations": 12,
        "continuationIntervalMs": 1500,
        "maxDurationMs": 3600000,
        "maxTokens": 120000,
        "noProgressTurns": 3,
        "dataFile": "~/.local/share/opencode-goal-plugin/goals.json"
      }
    }
  ]
}
```

### Configuration options

You can configure the following options:

- `autoContinue`: Enables automatic continuation when the session becomes idle. Defaults to `true`.
- `maxContinuations`: Sets the maximum number of automatic continuation turns. Defaults to `12`.
- `continuationIntervalMs`: Sets the delay in milliseconds before an automatic continuation prompt. Defaults to `1500`.
- `maxDurationMs`: Sets the maximum active execution time in milliseconds before setting status to `budgetLimited`. Defaults to `3600000` (1 hour).
- `maxTokens`: Sets the maximum estimated context token count before setting status to `usageLimited`. Defaults to `120000`.
- `noProgressTurns`: Sets the maximum consecutive continuation turns without file edits before pausing the goal. Defaults to `3`.
- `dataFile`: Specifies a custom file path for the goal database. Defaults to `${XDG_DATA_HOME:-~/.local/share}/opencode-goal-plugin/goals.json`.

## Commands

Use the `/goal` command in chat to manage session goals.

- `/goal`: Shows the active goal status and evidence candidate IDs.
- `/goal status`: Shows the active goal status and evidence candidate IDs.
- `/goal <objective>`: Creates a goal with the specified objective.
- `/goal create <objective>`: Creates a goal with the specified objective.
- `/goal pause`: Pauses automatic continuation for the active goal.
- `/goal resume`: Resumes execution for a paused or blocked goal.
- `/goal blocked <reason>`: Marks the goal as blocked and records the reason.
- `/goal complete <evidence>`: Completes the goal using structured evidence JSON.
- `/goal clear`: Removes the goal for the session.

The plugin registers the `/goal` command through the OpenCode command transform API.
The command callback preserves invocation delivery modes (`steer` or `queue`) and context mentions (`@files`, `@agents`, `@skills`).
It provides instructions that guide the session agent to call the matching goal tool.
Only goal tools modify the stored goal state.

## Tools interface

The plugin registers four tools for agent use:

- `get_goal`: Returns the stored goal, its status, active duration, token estimate, checkpoints, history, and valid evidence candidate IDs.
- `create_goal`: Creates a goal for the session with an `objective` string.
- `update_goal`: Updates goal status with an `action` of `pause`, `resume`, `blocked`, or `complete`.
- `clear_goal`: Deletes the session goal and cancels pending continuations.

## Evidence workflow and verification

The plugin requires verified tool execution before goal completion.
The assistant cannot complete a goal through prose claims alone.

1. Execute a verification tool, such as a test command or build command.
2. Confirm that the command succeeds.
3. Call `get_goal` to retrieve recorded evidence candidate IDs.
4. Call `update_goal` with `action: "complete"` and structured evidence.

The evidence object must contain the following fields:

- `source`: Set to `"tool"`, `"test"`, or `"verification"`.
- `summary`: Provide a descriptive summary of at least 3 characters.
- `success`: Set to `true`.
- `toolCallID`: Provide the exact tool call ID from `get_goal`.

```json
{
  "action": "complete",
  "evidence": {
    "source": "test",
    "summary": "All test suites passed successfully",
    "success": true,
    "toolCallID": "call_123456789"
  }
}
```

The plugin rejects completion if `toolCallID` does not match a successful tool call from the same session.

## Persistence and limits

The plugin stores goal records in a single JSON file.
It resolves the database path from the `dataFile` option or uses `${XDG_DATA_HOME:-~/.local/share}/opencode-goal-plugin/goals.json`.
The store uses atomic file replacement and cross-process file locking.
It applies permissions of `0700` for created directories and `0600` for files on supported systems.
Existing custom directories retain their original permissions.

Each goal record contains timestamps, active duration, continuation counts, checkpoints, history entries, and approximate token estimates.
The plugin estimates token usage from serialized context messages divided by four.

The plugin triggers automatic continuation when a session becomes idle.
It checks limits before and during continuation:

- Reaching `maxTokens` sets goal status to `usageLimited`.
- Reaching `maxDurationMs` or `maxContinuations` sets goal status to `budgetLimited`.
- Reaching `noProgressTurns` without file changes sets goal status to `paused`.
