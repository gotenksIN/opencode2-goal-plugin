# OpenCode Goal Plugin

This OpenCode V2 plugin stores and tracks one persistent goal for each session.
It provides the `/goal` command, four goal tools, evidence-gated completion, progress checkpoints, and automatic continuation with limits.
It does not add a terminal user interface (TUI) indicator.

## Installation

Add the plugin package and command configuration to your OpenCode V2 configuration file.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode2-goal-plugin@1.0.1",
      "options": {
        "autoContinue": true,
        "maxContinuations": 12,
        "continuationIntervalMs": 1500,
        "maxDurationMs": 3600000,
        "maxTokens": 120000,
        "noProgressTurns": 3
      }
    }
  ],
  "commands": {
    "goal": {
      "description": "Manage the session goal",
      "template": "Route this goal command through the matching goal controller tools. Arguments: $ARGUMENTS. With no arguments or status, call get_goal. A plain objective or create OBJECTIVE calls create_goal. pause, resume, and blocked BLOCKER call update_goal. For complete, call get_goal if needed, then copy an exact evidence candidate ID into structured evidence for update_goal. clear calls clear_goal. Never infer completion from prose."
    }
  }
}
```

## Commands

Use the `/goal` command to manage session goals:

- `/goal Build and verify the feature`: Creates a new session goal with the given objective.
- `/goal status`: Returns the current goal status.
- `/goal pause`: Pauses automatic continuation for the active goal.
- `/goal resume`: Resumes execution for a paused or blocked goal.
- `/goal blocked <reason>`: Sets the goal status to blocked and records the reason.
- `/goal complete {"source":"test","summary":"All tests passed","success":true,"toolCallID":"..."}`: Completes the goal using structured evidence.
- `/goal clear`: Deletes the session goal.

OpenCode V2 command transforms modify prompt templates.
They do not execute direct command callbacks.
The `/goal` command template instructs the model to route operations through `get_goal`, `create_goal`, `update_goal`, or `clear_goal`.
OpenCode V2 plugin transforms can update existing commands, but they cannot register new commands.
You must define the `commands.goal` object in your OpenCode V2 configuration file.
Only goal tools modify the stored goal state.

## Completion Evidence Workflow

Completion uses the exact OpenCode tool call ID from a successful non-goal tool in the same session.

1. Run a verification tool, such as a test or build command, and confirm that it succeeds.
2. Call `get_goal` if you need the ID.
3. Copy an exact ID from the returned `evidenceCandidates` list.
4. Call `update_goal` with `action: "complete"` and put that ID in `evidence.toolCallID`.

Do not use a command name, a descriptive label such as `bun-publish-dry-run`, or an ID from another session.
The plugin rejects any value that is not a recent successful evidence candidate for the current session.

## Persistence and Limits

The plugin stores goal data in an atomic JSON file at `${XDG_DATA_HOME:-~/.local/share}/opencode-goal-plugin/goals.json`.
It uses process queue locking for safe concurrent file writes.
It sets directory permissions to `0700` and file permissions to `0600` on supported operating systems.
Each goal record contains execution history, checkpoints, timestamps, active duration, continuation counts, and a token estimate.
The plugin estimates token usage by dividing the length of serialized context messages by four.
OpenCode V2 does not provide exact token count metrics to plugins.
Goal completion requires evidence that references a recent successful tool call recorded during the same session.

The `session.idle` event triggers automatic goal continuation.
The plugin verifies persisted goal state before each continuation prompt.
It prevents concurrent continuation tasks for the same session.
It stops continuation when execution reaches configured limits for continuations, active time, token estimates, or turns without progress.
You can disable automatic continuation by setting `autoContinue: false` in the plugin options.
