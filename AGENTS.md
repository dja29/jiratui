# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-01 10:13 America/Toronto
**Commit:** aaaf7ff
**Branch:** main

## OVERVIEW
Jira Service Desk TUI built with TypeScript, Bun, and OpenTUI React to browse Jira Cloud issues in the terminal.

## STRUCTURE
```
./
├── src/          # App, Jira client, config wizard, JQL helper
├── dist/         # TypeScript build output (ignored)
├── config.json   # User config (ignored; generated from example or wizard)
├── config.json.example
├── .env.example
└── state.conf    # Local flag state (generated at runtime)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Main TUI app | src/index.tsx | OpenTUI React UI, issue loading, key bindings |
| Jira API client | src/jira-client.ts | JQL validation, issue search, project constraint injection |
| Config wizard | src/config-wizard.ts | Interactive setup and editing for config.json |
| JQL helper | src/jql-helper.ts | CLI tool to format JQL into config entries |
| Runtime config | config.json | Loaded from process.cwd() |
| Env vars | .env | JIRA_API_KEY, JIRA_EMAIL |
| Local state | state.conf | Stores flagged issue keys |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| main | function | src/index.tsx | app entry | Bootstraps OpenTUI renderer |
| App | function | src/index.tsx | app root | UI composition and data loading |
| JiraClient | class | src/jira-client.ts | shared | Jira REST v3 client |
| injectProjectConstraintAtEnd | function | src/jira-client.ts | shared | Ensures project clause in JQL |
| runConfigWizard | function | src/config-wizard.ts | entry | Interactive config editor |
| formatConfigEntry | function | src/jql-helper.ts | entry | Escapes JQL for JSON config |

## CONVENTIONS
- Bun runtime required; scripts use `bun run`.
- TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- JSX uses `@opentui/react` via `jsxImportSource` in `tsconfig.json`.
- Runtime files read/write in repo root via `process.cwd()`.

## ANTI-PATTERNS (THIS PROJECT)
- None documented.

## UNIQUE STYLES
- OpenTUI React components in TSX for terminal UI.
- JQL queries validated against Jira API before loading UI.

## COMMANDS
```bash
bun install
bun run start
bun run start -- --config
bun run jql
bun run build
bun run typecheck
```

## NOTES
- `config.json` and `.env` are ignored in git; use the example files as templates.
- `state.conf` stores local flags; safe to delete if you want a clean slate.
