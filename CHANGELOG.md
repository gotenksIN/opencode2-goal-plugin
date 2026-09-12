# Changelog

All notable changes to `opencode2-goal-plugin` are documented in this file.

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
