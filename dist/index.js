// @bun
var __require = import.meta.require;

// src/plugin.ts
import { homedir } from "os";
import { join } from "path";
import { Plugin } from "@opencode-ai/plugin";

// src/types.ts
var evidenceSources = ["tool", "test", "verification"];

// src/controller.ts
var defaultLimits = {
  maxContinuations: 12,
  maxTokens: 120000,
  maxDurationMs: 60 * 60 * 1000,
  noProgressTurns: 3
};
var now = () => new Date().toISOString();
function stopActiveClock(goal, at) {
  if (!goal.activeSince)
    return;
  goal.activeTimeMs += Math.max(0, Date.parse(at) - Date.parse(goal.activeSince));
  delete goal.activeSince;
}
function history(goal, action, detail) {
  goal.history.push({ at: goal.updatedAt, action, status: goal.status, detail });
  goal.history = goal.history.slice(-100);
}
function validateEvidence(value) {
  if (value === null || value instanceof Object === false) {
    throw new Error("Completion requires structured evidence");
  }
  if (!evidenceSources.includes(value.source)) {
    throw new Error("Evidence source must be tool, test, or verification");
  }
  if (value.success !== true)
    throw new Error("Evidence must report success: true");
  let summary;
  try {
    summary = value.summary.trim();
  } catch {
    throw new Error("Evidence requires a useful summary");
  }
  if (summary.length < 3)
    throw new Error("Evidence requires a useful summary");
  if (value.toolCallID !== undefined && String(value.toolCallID) !== value.toolCallID) {
    throw new Error("Evidence toolCallID must be a string");
  }
  const evidence = { source: value.source, summary, success: true };
  if (value.toolCallID)
    evidence.toolCallID = value.toolCallID;
  return evidence;
}
function parseGoalCommand(input) {
  const text = input.trim();
  if (!text || text === "status" || text === "get")
    return { action: "get" };
  const [action, ...rest] = text.split(/\s+/);
  const detail = rest.join(" ").trim();
  if (action === "create") {
    if (!detail)
      throw new Error("Usage: /goal create <objective>");
    return { action, objective: detail };
  }
  if (action === "pause" || action === "resume" || action === "clear")
    return { action };
  if (action === "blocked") {
    if (!detail)
      throw new Error("Usage: /goal blocked <blocker>");
    return { action, blocker: detail };
  }
  if (action === "complete") {
    let evidence;
    try {
      evidence = JSON.parse(detail);
    } catch {
      throw new Error("Completion evidence must be JSON");
    }
    return { action, evidence: validateEvidence(evidence) };
  }
  return { action: "create", objective: text };
}

class GoalController {
  store;
  limits;
  constructor(store, limits = defaultLimits) {
    this.store = store;
    this.limits = limits;
  }
  get(sessionID) {
    return this.store.get(sessionID);
  }
  create(sessionID, objective) {
    const clean = objective.trim();
    if (!clean)
      return Promise.reject(new Error("Objective is required"));
    return this.store.update(sessionID, (current) => {
      if (current && current.status !== "complete")
        throw new Error("This session already has a goal");
      const at = now();
      const goal = {
        sessionID,
        objective: clean,
        status: "active",
        evidence: [],
        checkpoints: [],
        history: [],
        createdAt: at,
        updatedAt: at,
        activeSince: at,
        activeTimeMs: 0,
        continuationCount: 0,
        tokenEstimate: 0,
        noProgressCount: 0
      };
      history(goal, "created", clean);
      return goal;
    });
  }
  clear(sessionID) {
    return this.store.update(sessionID, () => {
      return;
    });
  }
  update(sessionID, status, detail) {
    return this.store.update(sessionID, (goal) => {
      if (!goal)
        throw new Error("No goal exists for this session");
      if (goal.status === "complete")
        throw new Error("The goal is already complete");
      const at = now();
      goal.updatedAt = at;
      if (status === "resume") {
        if (goal.status === "active") {
          history(goal, "resume", "Already active");
          return goal;
        }
        goal.status = "active";
        goal.activeSince = at;
        delete goal.blocker;
        goal.noProgressCount = 0;
      } else {
        stopActiveClock(goal, at);
        if (status === "pause")
          goal.status = "paused";
        if (status === "blocked") {
          if (!detail?.blocker?.trim())
            throw new Error("Blocked status requires a blocker");
          goal.status = "blocked";
          goal.blocker = detail.blocker.trim();
        }
        if (status === "complete") {
          const evidence = validateEvidence(detail?.evidence);
          goal.evidence.push({ ...evidence, createdAt: at });
          goal.status = "complete";
        }
      }
      history(goal, status, detail?.blocker);
      return goal;
    });
  }
  async handleCommand(sessionID, input) {
    const command = parseGoalCommand(input);
    if (command.action === "get")
      return this.get(sessionID);
    if (command.action === "create")
      return this.create(sessionID, command.objective);
    if (command.action === "clear")
      return this.clear(sessionID);
    if (command.action === "blocked")
      return this.update(sessionID, "blocked", command);
    if (command.action === "complete")
      return this.update(sessionID, "complete", command);
    return this.update(sessionID, command.action);
  }
  checkpoint(sessionID, summary, source, madeProgress = false) {
    return this.store.update(sessionID, (goal) => {
      if (!goal || goal.status !== "active")
        return goal;
      goal.updatedAt = now();
      goal.checkpoints.push({ at: goal.updatedAt, summary, source });
      goal.checkpoints = goal.checkpoints.slice(-50);
      if (madeProgress)
        goal.noProgressCount = 0;
      history(goal, "checkpoint", summary);
      return goal;
    });
  }
  account(sessionID, tokenEstimate, continuation = false, madeProgress = false) {
    return this.store.update(sessionID, (goal) => {
      if (!goal || goal.status !== "active")
        return goal;
      const at = now();
      goal.updatedAt = at;
      goal.tokenEstimate += Math.max(0, Math.round(tokenEstimate));
      if (continuation)
        goal.continuationCount++;
      goal.noProgressCount = madeProgress ? 0 : goal.noProgressCount + (continuation ? 1 : 0);
      const elapsed = goal.activeTimeMs + (goal.activeSince ? Date.parse(at) - Date.parse(goal.activeSince) : 0);
      let limited;
      if (goal.tokenEstimate >= this.limits.maxTokens)
        limited = "usageLimited";
      else if (elapsed >= this.limits.maxDurationMs || goal.continuationCount >= this.limits.maxContinuations)
        limited = "budgetLimited";
      else if (goal.noProgressCount >= this.limits.noProgressTurns)
        limited = "paused";
      if (limited) {
        stopActiveClock(goal, at);
        goal.status = limited;
        history(goal, limited === "paused" ? "no-progress-pause" : "limit-reached");
      }
      return goal;
    });
  }
}

// src/store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
var emptyDatabase = () => ({ version: 1, goals: {} });

class GoalStore {
  path;
  queue = Promise.resolve();
  constructor(path) {
    this.path = path;
  }
  async readUnlocked() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value.version !== 1 || !value.goals || value.goals instanceof Object === false) {
        throw new Error("Unsupported goal database format");
      }
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return emptyDatabase();
      throw error;
    }
  }
  async writeUnlocked(database) {
    await mkdir(dirname(this.path), { recursive: true, mode: 448 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(database, null, 2)}
`, { mode: 384 });
      await rename(temporary, this.path);
    } catch (error) {
      await import("fs/promises").then(({ unlink }) => unlink(temporary)).catch(() => {
        return;
      });
      throw error;
    }
    await chmod(this.path, 384).catch(() => {
      return;
    });
  }
  locked(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
  get(sessionID) {
    return this.locked(async () => structuredClone((await this.readUnlocked()).goals[sessionID]));
  }
  all() {
    return this.locked(async () => structuredClone((await this.readUnlocked()).goals));
  }
  update(sessionID, mutate) {
    return this.locked(async () => {
      const database = await this.readUnlocked();
      const next = mutate(structuredClone(database.goals[sessionID]));
      if (next)
        database.goals[sessionID] = next;
      else
        delete database.goals[sessionID];
      await this.writeUnlocked(database);
      return structuredClone(next);
    });
  }
}

// src/plugin.ts
var goalToolNames = new Set(["get_goal", "create_goal", "update_goal", "clear_goal"]);
var maxEvidenceCandidatesPerSession = 20;
var maxEvidenceCandidateSessions = 100;
function dataPath(options) {
  if (options.dataFile) {
    return options.dataFile.startsWith("~/") ? join(homedir(), options.dataFile.slice(2)) : options.dataFile;
  }
  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "opencode-goal-plugin", "goals.json");
}
function format(goal) {
  return goal ? JSON.stringify(goal, null, 2) : "No goal exists for this session.";
}
function formatGoalStatus(goal, evidenceCandidates) {
  return JSON.stringify({
    goal: goal ?? null,
    evidenceCandidates,
    evidenceInstruction: evidenceCandidates.length ? "To complete the goal, copy one exact evidence candidate ID into evidence.toolCallID. Do not invent an ID." : "Run a successful non-goal verification tool, then call get_goal again to get its exact evidence candidate ID."
  }, null, 2);
}
function estimateTokens(messages) {
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}
function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function positiveInteger(value, fallback) {
  return Math.max(1, Math.floor(finiteNonNegative(value, fallback)));
}
var plugin_default = Plugin.define({
  id: "opencode.goal",
  setup: async (ctx) => {
    const options = ctx.options;
    const limits = {
      maxContinuations: positiveInteger(options.maxContinuations, defaultLimits.maxContinuations),
      maxTokens: finiteNonNegative(options.maxTokens, defaultLimits.maxTokens),
      maxDurationMs: finiteNonNegative(options.maxDurationMs, defaultLimits.maxDurationMs),
      noProgressTurns: positiveInteger(options.noProgressTurns, defaultLimits.noProgressTurns)
    };
    const controller = new GoalController(new GoalStore(dataPath(options)), limits);
    const inFlight = new Set;
    const scheduled = new Set;
    const evidenceCandidates = new Map;
    const timers = new Set;
    let stopped = false;
    let stopStream;
    const isSubagentSession = async (sessionID) => {
      try {
        const session = await ctx.session.get({ sessionID });
        return session.parentID !== undefined && session.parentID.length > 0;
      } catch {
        return false;
      }
    };
    const interruptSession = async (sessionID) => {
      if (await isSubagentSession(sessionID))
        return;
      await ctx.session.interrupt({ sessionID }).catch(() => {
        return;
      });
    };
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "get_goal",
        description: "Get the persisted goal and recent valid evidence candidate IDs for this session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, toolCtx) => ({
          content: formatGoalStatus(await controller.get(toolCtx.sessionID), evidenceCandidates.get(toolCtx.sessionID) ?? [])
        })
      });
      tools.add({
        name: "create_goal",
        description: "Create one persisted goal for this session.",
        input: {
          type: "object",
          properties: { objective: { type: "string", minLength: 1 } },
          required: ["objective"],
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (input, toolCtx) => {
          const value = input;
          return { content: format(await controller.create(toolCtx.sessionID, value.objective)) };
        }
      });
      tools.add({
        name: "update_goal",
        description: "Pause, resume, block, or complete the session goal. Completion requires successful structured evidence.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["pause", "resume", "blocked", "complete"] },
            blocker: { type: "string" },
            evidence: {
              type: "object",
              properties: {
                source: { type: "string", enum: ["tool", "test", "verification"] },
                summary: { type: "string", minLength: 3 },
                success: { type: "boolean" },
                toolCallID: { type: "string" }
              },
              required: ["source", "summary", "success"],
              additionalProperties: false
            }
          },
          required: ["action"],
          additionalProperties: false
        },
        options: { codemode: false },
        execute: async (input, toolCtx) => {
          const value = input;
          if (value.action === "complete") {
            const toolCallID = value.evidence?.toolCallID;
            if (toolCallID === undefined || !evidenceCandidates.get(toolCtx.sessionID)?.includes(toolCallID)) {
              throw new Error("Completion evidence must reference an exact evidence candidate ID from get_goal for this session");
            }
          }
          const updated = await controller.update(toolCtx.sessionID, value.action, value);
          if (value.action === "complete")
            evidenceCandidates.delete(toolCtx.sessionID);
          if (value.action === "pause" || value.action === "blocked") {
            await interruptSession(toolCtx.sessionID);
          }
          return { content: format(updated) };
        }
      });
      tools.add({
        name: "clear_goal",
        description: "Remove the persisted goal for this session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, toolCtx) => {
          await controller.clear(toolCtx.sessionID);
          evidenceCandidates.delete(toolCtx.sessionID);
          await interruptSession(toolCtx.sessionID);
          return { content: "Goal cleared." };
        }
      });
    });
    await ctx.command.transform((commands) => {
      commands.update("goal", (command) => {
        command.description = "Create, inspect, pause, resume, block, complete, or clear a session goal";
        command.template = [
          "Route this goal command through the matching goal controller tools.",
          "Arguments: $ARGUMENTS",
          "With no arguments or with 'status', call get_goal.",
          "A plain objective or 'create OBJECTIVE' calls create_goal.",
          "pause, resume, and blocked BLOCKER call update_goal.",
          "For complete, call get_goal if needed, then copy an exact evidence candidate ID into structured evidence for update_goal.",
          "clear calls clear_goal.",
          "For complete, require a JSON evidence object with source, summary, and success=true.",
          "Never infer completion from prose and never claim a state change without the tool result."
        ].join(`
`);
      });
    });
    await ctx.session.hook("context", async (event) => {
      const goal = await controller.get(event.sessionID);
      if (!goal)
        return;
      await controller.account(event.sessionID, estimateTokens(event.messages));
      const state = goal.status === "active" ? "Continue work toward this goal. Use goal tools for every state change. Complete only with successful structured evidence." : `Do not silently continue this goal because its state is ${goal.status}.`;
      const candidates = evidenceCandidates.get(event.sessionID) ?? [];
      const evidenceContext = candidates.length ? `
Recent valid evidence candidate IDs: ${JSON.stringify(candidates)}
For completion, copy one exact ID into evidence.toolCallID. Do not invent an ID.` : `
No evidence candidate is available. Run a successful non-goal verification tool, then call get_goal.`;
      event.system.push({
        type: "text",
        text: `[Persisted goal]
Objective: ${goal.objective}
Status: ${goal.status}${goal.blocker ? `
Blocker: ${goal.blocker}` : ""}
${state}${evidenceContext}`,
        metadata: { plugin: "opencode.goal" }
      });
    });
    await ctx.tool.hook("execute.after", async (event) => {
      if (stopped || event.status !== "completed" || goalToolNames.has(event.tool))
        return;
      const recent = evidenceCandidates.get(event.sessionID) ?? [];
      const next = [...recent.filter((id) => id !== event.id), event.id].slice(-maxEvidenceCandidatesPerSession);
      evidenceCandidates.delete(event.sessionID);
      evidenceCandidates.set(event.sessionID, next);
      while (evidenceCandidates.size > maxEvidenceCandidateSessions) {
        const oldestSession = evidenceCandidates.keys().next().value;
        if (oldestSession === undefined)
          break;
        evidenceCandidates.delete(oldestSession);
      }
      const meaningful = new Set(["edit", "write", "patch"]);
      await controller.checkpoint(event.sessionID, `Successful ${event.tool} tool call`, event.tool, meaningful.has(event.tool));
    });
    const continueGoal = async (sessionID) => {
      if (stopped || inFlight.has(sessionID))
        return;
      inFlight.add(sessionID);
      try {
        const goal = await controller.get(sessionID);
        if (!goal || goal.status !== "active")
          return;
        const before = goal.checkpoints.length;
        await controller.account(sessionID, 0, true, false);
        const checked = await controller.get(sessionID);
        if (!checked || checked.status !== "active")
          return;
        await ctx.session.prompt({
          sessionID,
          text: "Continue the persisted goal from the latest checkpoint. Do not mark it complete without successful structured evidence.",
          metadata: { plugin: "opencode.goal", continuation: checked.continuationCount }
        });
        const after = await controller.get(sessionID);
        if (after && after.checkpoints.length > before) {
          await controller.account(sessionID, 0, false, true);
        }
      } finally {
        inFlight.delete(sessionID);
      }
    };
    if (options.autoContinue !== false) {
      const stream = await ctx.event.subscribe();
      const iterator = stream[Symbol.asyncIterator]();
      stopStream = async () => {
        await iterator.return?.();
      };
      (async () => {
        try {
          while (!stopped) {
            const item = await iterator.next();
            if (item.done)
              break;
            const event = item.value;
            if (event.type !== "session.idle" || !event.data.sessionID)
              continue;
            if (scheduled.has(event.data.sessionID) || inFlight.has(event.data.sessionID))
              continue;
            scheduled.add(event.data.sessionID);
            const timer = setTimeout(() => {
              timers.delete(timer);
              scheduled.delete(event.data.sessionID);
              continueGoal(event.data.sessionID).catch(() => {
                return;
              });
            }, Math.max(0, options.continuationIntervalMs ?? 1500));
            timers.add(timer);
          }
        } catch {
          if (!stopped)
            return;
        }
      })();
    }
    return async () => {
      stopped = true;
      for (const timer of timers)
        clearTimeout(timer);
      timers.clear();
      scheduled.clear();
      evidenceCandidates.clear();
      await stopStream?.();
    };
  }
});
export {
  plugin_default as default
};
