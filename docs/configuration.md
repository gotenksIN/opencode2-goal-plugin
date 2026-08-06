# Configuration

Add the plugin package and command configuration to your OpenCode V2 configuration file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode2-goal-plugin@1.0.0",
      "options": {
        "autoContinue": true,
        "continuationIntervalMs": 1500,
        "dataFile": "~/.local/share/opencode-goal-plugin/goals.json",
        "maxContinuations": 12,
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

## Command Configuration

You must define the `commands.goal` object in your configuration file.
OpenCode V2 command transforms can update existing command templates, but they cannot create missing commands.

## Completing a Goal

Run a verification tool and confirm that it succeeds.
Call `get_goal` if you need the ID, then copy an exact ID from the `evidenceCandidates` list.
Call `update_goal` with `action: "complete"`, successful structured evidence, and the copied ID as `evidence.toolCallID`.
The ID must come from a successful non-goal tool call in the same session.
Labels and invented IDs are not valid evidence.

## Configuration Options

You can configure the following options in the plugin `options` object:

- `autoContinue` (boolean, default: `true`): Enables automatic goal continuation when the session is idle.
- `continuationIntervalMs` (number, default: `1500`): Sets the delay in milliseconds before sending a continuation prompt after a `session.idle` event.
- `dataFile` (string, default: `${XDG_DATA_HOME:-~/.local/share}/opencode-goal-plugin/goals.json`): Specifies the storage path for the goal database file.
- `maxContinuations` (number, default: `12`): Sets the maximum number of automatic continuations allowed for an active goal.
- `maxDurationMs` (number, default: `3600000`): Sets the maximum total active duration in milliseconds before goal execution stops with status `budgetLimited`.
- `maxTokens` (number, default: `120000`): Sets the maximum estimated context token count before goal execution stops with status `usageLimited`.
- `noProgressTurns` (number, default: `3`): Sets the maximum consecutive continuation turns without file modifications before goal status becomes `paused`.
