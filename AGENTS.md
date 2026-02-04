# AGENTS

## Project Summary
Jira Service Desk TUI built with TypeScript, Bun, and OpenTUI React. The UI is rendered in the terminal and backed by a Jira Cloud REST v3 client that validates JQL before rendering.

## Quick Commands
```bash
bun install
bun run start
bun run start -- --config
bun run jql
bun run build
bun run typecheck
```

### Tests and Single-Test Runs
- No test runner is configured yet. `bun run test` currently exits with error in `package.json`.
- There is no supported single-test invocation until a test framework is added.

## Repository Layout
```
./
├── src/          # App, Jira client, config wizard, JQL helper
├── dist/         # TypeScript build output (ignored)
├── config.json   # User config (ignored; generated from example or wizard)
├── config.json.example
├── .env.example
└── state.conf    # Local flag state (generated at runtime)
```

## Key Files
- `src/index.tsx`: OpenTUI React UI, issue loading, key bindings, modals.
- `src/jira-client.ts`: Jira REST v3 client, JQL validation, project constraint helper.
- `src/config-wizard.ts`: Interactive config editor (CLI wizard) and validation.
- `src/jql-helper.ts`: JQL formatting helper for config entries.
- `config.json`: Runtime config loaded from `process.cwd()`.
- `.env`: Jira credentials (`JIRA_API_KEY`, `JIRA_EMAIL`).

## Environment and Tooling
- Bun is required; scripts run with `bun run`.
- TypeScript is `strict` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- ESM build (`"type": "module"`) with `moduleResolution: nodenext`.
- JSX uses `@opentui/react` via `jsxImportSource` in `tsconfig.json`.

## Code Style Guidelines
### Imports and Modules
- Use ESM `import`/`export` only.
- Use explicit file extensions in relative imports (`./jira-client.js`).
- Group imports: external packages first, then Node built-ins, then local modules.
- Use `import type` for type-only imports when helpful.

### Formatting
- 2-space indentation, semicolons, double quotes.
- Keep lines reasonably short; wrap long JSX props for readability.
- Trailing newline at EOF.

### Types and Interfaces
- Prefer `interface` for object shapes and `type` for unions/literals.
- Avoid `any`; use `unknown` and narrow with guards when needed.
- Use `Record<...>` and explicit return types for exported functions.
- Keep optional fields explicit and handle `undefined` with guards.

### Naming
- `camelCase` for variables/functions, `PascalCase` for components/classes.
- Use descriptive names for UI state (`selectedTabIndex`, `validationErrors`).
- Constants in `SCREAMING_SNAKE_CASE` only when truly global.

### Error Handling
- Throw `Error` with actionable messages (include guidance for users).
- In `catch`, use `err instanceof Error ? err.message : "Unknown error"`.
- Avoid empty `catch` blocks; if ignoring an error is intentional, comment why.
- Use `console.error` for CLI-visible failures and `process.exit(1)` on fatal errors.

### React/OpenTUI Patterns
- Functional components with hooks (`useState`, `useEffect`, `useRef`).
- Keep rendering pure; do side effects in `useEffect`.
- Use `scrollbox` refs for imperative scroll control.
- Prefer small helper functions for UI formatting (`truncateOrPad`, `getRowColors`).

### Data and I/O
- Read/write JSON with `JSON.parse` and `JSON.stringify(..., null, 2)`.
- Ensure written JSON ends with a newline.
- Paths should be based on `process.cwd()` to respect repo-local config.
- CLI flows use sync FS reads for simplicity; keep them contained.

## Jira Client Conventions
- Build JQL by injecting project constraints via `injectProjectConstraintAtEnd`.
- Validate JQL before UI load and on edits to prevent invalid views.
- The Jira client uses Basic auth from `.env` via `dotenv`.

## Runtime Files
- `config.json` and `.env` are git-ignored; use `config.json.example` and `.env.example` as templates.
- `state.conf` stores local flags and can be deleted to reset state.

## Cursor/Copilot Rules
- No `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md` were found in this repo.

## Notes for Agents
- Do not introduce Node-only APIs that Bun/OpenTUI cannot handle.
- Match existing patterns in `src/index.tsx` before adding new UI components.
- Prefer minimal, focused changes and avoid refactors unless requested.
