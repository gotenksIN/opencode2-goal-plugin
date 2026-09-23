# Changelog

All notable changes to `opencode2-goal-plugin` are documented in this file.

## 1.0.8 (2026-09-23)

- Store session goals in scoped OpenCode V2 plugin storage instead of a JSON file, with local cross-process locks for updates.
- Do not import goals from older JSON files; remove the obsolete `dataFile` option before loading this version.
- Make continuation, token, duration, and no-progress limits opt-in.
- Cancel pending continuations when goals change state or sessions move, and continue handling events after a storage failure.
- Reject empty Code Mode tool calls as completion evidence.
- Update the OpenCode V2 plugin dependency and Bun development tools.

## 1.0.7 (2026-09-15)

- Update `@opencode/plugin` to `2.0.3` and refresh development dependencies.
- Use OpenCode V2 execution events for automatic continuation.
- Pause active goals after terminal failures and user interruptions.
- Validate structured tool outcomes before accepting completion evidence.
- Restrict continuation handling to sessions owned by the plugin instance.
- Prevent cleanup and prompt admission races from restarting stopped goals.

## 1.0.6 (2026-09-12)

- Update `@opencode/plugin` dependency to `2.0.2` for the OpenCode V2 release.
- Externalize `@opencode/plugin` in the distribution build bundle.
- Add `prepack` script to run bundle compilation before publishing.
- Update vendored anti-slop Oxlint rules to the latest upstream release.
- Enable `no-array-filter-map`, `no-reduce-accumulator-copy`, and `require-readable-spacing` rules.

## 1.0.5 (2026-08-25)

- Pin `@opencode-ai/plugin` to `0.0.0-dev-18153` under dependencies.
- Configure `main` and `exports` to point to `./dist/index.js`.
- Remove boolean `const` properties in tool schemas for Gemini and downstream compatibility.
- Document packaging and schema rules in `CONTEXT.md`.

## 1.0.4 (2026-08-25)

- Restrict published files to runtime entries and add MIT license.
- Add packaging and linter configurations.
