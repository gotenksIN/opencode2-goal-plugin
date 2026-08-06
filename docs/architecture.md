# Architecture

The plugin stores and manages one goal record for each OpenCode session.

## System Components

The plugin consists of three primary modules:

- `GoalStore` (`src/store.ts`): Manages atomic read and write operations for the JSON database file.
  It uses process queue locking to prevent concurrent file conflicts.
  It sets directory permissions to `0700` and file permissions to `0600` on supported operating systems.
- `GoalController` (`src/controller.ts`): Implements state machine logic, command parsing, progress checks, checkpoint recording, execution history, and limit enforcement.
- `Plugin` (`src/plugin.ts`): Adapts the goal controller to the OpenCode V2 plugin API.
  It registers tools, transforms commands, hooks into session context and tool execution, and handles idle events.

## Integration Hooks

The plugin integrates with OpenCode V2 using the following API mechanisms:

- Context hook (`ctx.session.hook("context")`): Appends active goal details and instructions into system context during context creation and context compaction.
- Tool registration (`ctx.tool.transform`): Registers four tools (`get_goal`, `create_goal`, `update_goal`, `clear_goal`) to perform goal operations.
- Command transform (`ctx.command.transform`): Updates the prompt template for the `/goal` command to direct operations to goal tools.
- Tool execution hook (`ctx.tool.hook("execute.after")`): Tracks recent successful non-goal tool call IDs by session and records progress checkpoints when files are modified by tools such as `edit`, `write`, or `patch`.
- Event subscriber (`ctx.event.subscribe`): Monitors `session.idle` events to schedule automatic continuation prompts when goals are active.

## Design Constraints

- Terminal interface: OpenCode V2 does not provide a terminal user interface API.
  The plugin does not render a custom status indicator in the terminal user interface.
- Token accounting: OpenCode V2 does not provide exact model token count metrics to plugins.
  The plugin estimates token usage by dividing the length of serialized context messages by four.
- Completion validation: Goal completion requires structured evidence referencing an exact recent successful tool call identifier from the same session.
  Candidate lists and session data are bounded in memory and cleared during cleanup.
