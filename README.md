# Jira Service Desk TUI

A terminal user interface for viewing Jira Service Desk issues.

## Prerequisites

- [Bun](https://bun.sh/) (required - OpenTUI uses file types not supported by Node.js)
- A Jira Cloud account with API access
- This package is offered without support and is only tested on macOS.

## Installation

1. Install Bun (if not already installed):

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (via PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Or via Homebrew
brew install oven-sh/bun/bun
```

2. Clone the repository and install dependencies:


```bash
git clone https://github.com/dja29/jiratui.git
cd jira-tui
bun install
```

3. Create a `.env` file with your Jira credentials:

```bash
cp .env.example .env
```

Then edit `.env` with your values:
```
JIRA_API_KEY=your_api_token
JIRA_EMAIL=your_email@example.com
```

To get a Jira API token, go to https://id.atlassian.com/manage-profile/security/api-tokens

Your Jira domain is configured in `config.json` (see next step).

4. Create an alias before your first run (macOS only), and use it to start the app:

```bash
echo "alias jira='cd $(pwd); bun run start'" >> ~/.zshrc
source ~/.zshrc
```

Have some JQL ready (you’ll be prompted for it during setup).

5. Use the default config or start the setup wizard:

```bash
cp config.json.example config.json
```

OR

```bash
jira -- --config
```

This will guide you through creating your configuration, including:
- Setting your Jira project key
- Adding views with JQL queries (validated against the API)
- Configuring the optional Activity panel


6. Start the app:

```bash
jira
```

### Settings

Press `e` while in the TUI to open the settings menu.

From the settings menu you can:
- Add, edit, or remove views
- Configure the Activity panel
- Change the project key

## Configuration

Configuration is managed through the settings menu (press `e` or run `--config`). The config is stored in `config.json`:

```json
{
  "project": "YOUR_PROJECT_KEY",
  "domain": "your-domain.atlassian.net",
  "views": [
    {
      "name": "All Open",
      "jql": "status in (\"Open\", \"In Progress\") ORDER BY created DESC"
    },
    {
      "name": "My Work",
      "jql": "assignee = currentUser() AND status != Resolved ORDER BY updated DESC"
    },
    {
      "name": "High Priority",
      "jql": "priority = High AND status != Done ORDER BY created DESC"
    }
  ],
  "activity": {
    "enabled": true,
    "pollingIntervalMinutes": 5,
    "jql": "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC"
  }
}
```

| Field | Description |
|-------|-------------|
| `project` | Your Jira project key (e.g., "PROJ"). All views are constrained to this project. |
| `domain` | Your Jira Cloud domain |
| `views` | Array of views, each with a `name` and `jql` query (see below) |
| `activity` | Optional activity feed configuration (see below) |

### Views

Each view becomes a tab in the TUI. Define as many as you need:

```json
{
  "name": "Tab Name",
  "jql": "your JQL query here ORDER BY created DESC"
}
```

If your view JQL does not include a project constraint, the app will append one:

```
(<your jql>) AND project = <project>
```

If your JQL includes `ORDER BY`, the project constraint is inserted before it.

**JQL Validation**: On startup, all JQL queries are validated against the Jira API. If any query has errors, the app will display them and exit gracefully instead of crashing.

### Activity Feed

The Activity feed provides a frequently-polling tab for monitoring recent changes:

```json
{
  "activity": {
    "enabled": true,
    "pollingIntervalMinutes": 5,
    "jql": "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -1h ORDER BY updated DESC"
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Set to `true` to show the Activity tab |
| `pollingIntervalMinutes` | How often to refresh Activity (independent of main 60s refresh) |
| `jql` | JQL query for the Activity feed |

The Activity tab polls on its own interval, separate from the main refresh cycle. It combines:
- Issues from your custom activity JQL
- New issues from all configured views

This gives you a single view of everything happening across your watched queues, with new issues highlighted in red.

## JQL Helper

Convert JQL queries to the proper JSON format for `config.json` (paste into the `views` array):

```bash
bun run jql
```

Paste your JQL (multi-line supported), press Enter on an empty line, then enter a view name. The tool outputs a JSON object with `name` and `jql`.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle through tabs |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `o` | Open selected issue in browser |
| `f` | Toggle flag on selected issue |
| `s` | Cycle sort (Created → Updated → Owner → Flagged) |
| `r` | Refresh all tabs |
| `c` | Clear new issue highlights |
| `d` | Show JQL query for current view |
| `e` | Open settings menu |
| `Esc` | Exit |

## Flagging Issues

You can flag issues locally to mark them for follow-up. Flagged issues display a `*` after the issue key.

- Press `f` to toggle the flag on the currently selected issue
- Use `s` to cycle to "Flagged" sort mode, which puts all flagged issues at the top
- Flags are persisted to `state.conf` in the project directory

## How It Works

### Data Loading

On startup, the app fetches issues for **all tabs** before displaying the UI. This ensures instant tab switching without loading delays. All issues are fetched (no pagination limits) using server-side JQL filtering.

Auto-refresh occurs every 60 seconds, fetching all tabs again. New issues are highlighted with a blinking red background.

### JQL Queries

Each view's JQL query is executed with a project constraint applied.

If your view JQL does not already reference a project, the app will transform it like:

```
({your jql}) AND project = {project} ORDER BY {your order}
```
