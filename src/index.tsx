import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createCliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/react";
import { useState, useEffect, useRef } from "react";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import {
  JiraClient,
  type JiraIssue,
  injectProjectConstraintAtEnd,
  getIssueSubject,
  getIssueOwner,
  getIssueStatus,
  getIssueCreated,
  getIssueUpdated,
} from "./jira-client.js";
import { runConfigWizard } from "./config-wizard.js";
import clipboard from "clipboardy";

interface View {
  name: string;
  jql: string;
}

interface ActivityConfig {
  enabled: boolean;
  pollingIntervalMinutes: number;
  jql: string;
}

interface Config {
  project: string;
  domain: string;
  views: View[];
  activity?: ActivityConfig;
}

interface ConfigValidationResult {
  errors: string[];
}

interface ViewValidation {
  name: string;
  jql: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ValidationErrorProps {
  validationErrors: ViewValidation[];
  width: number;
  height: number;
}

function ValidationErrorScreen({ validationErrors, width, height }: ValidationErrorProps) {
  return (
    <box
      flexDirection="column"
      padding={1}
      border
      borderStyle="rounded"
      style={{ width: Math.min(width - 2, 100), height: Math.min(height - 2, 30) }}
    >
      <text fg="#EF4444">
        <strong>JQL Validation Errors</strong>
      </text>
      <box style={{ height: 1 }} />
      <scrollbox style={{ flexGrow: 1 }}>
        {validationErrors.map((v) => (
          <box key={v.name} flexDirection="column" style={{ marginBottom: 1 }}>
            <text fg="#F59E0B">
              <strong>{v.name}:</strong>
            </text>
            {v.errors.map((err, i) => (
              <text key={i} fg="#F87171">  {err}</text>
            ))}
            {v.warnings.map((warn, i) => (
              <text key={`w${i}`} fg="#FBBF24">  Warning: {warn}</text>
            ))}
          </box>
        ))}
      </scrollbox>
      <box style={{ height: 1 }} />
      <text fg="#888888">Fix config.json and restart. Press Esc to exit.</text>
    </box>
  );
}

const CONFIG_PATH = join(process.cwd(), "config.json");
const STATE_PATH = join(process.cwd(), "state.conf");
const ISSUE_CACHE_TTL_MS = 30_000;

interface AppState {
  flaggedIssueKeys: string[];
}

function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return { project: "", domain: "", views: [] };
  }
}

function validateConfig(config: Config): ConfigValidationResult {
  const errors: string[] = [];
  const project = config.project?.trim();
  const domain = config.domain?.trim();

  if (!project) {
    errors.push("Missing project key in config.json.");
  }

  if (!domain) {
    errors.push("Missing domain in config.json.");
  }

  if (!Array.isArray(config.views) || config.views.length === 0) {
    errors.push("At least one view is required in config.json.");
  } else {
    config.views.forEach((view, index) => {
      const viewName = view?.name?.trim();
      const viewJql = view?.jql?.trim();
      const label = viewName ? `View \"${viewName}\"` : `View #${index + 1}`;

      if (!viewName) {
        errors.push(`${label} is missing a name.`);
      }

      if (!viewJql) {
        errors.push(`${label} is missing a JQL query.`);
      }
    });
  }

  if (config.activity?.enabled) {
    const interval = config.activity.pollingIntervalMinutes;
    if (!interval || interval <= 0) {
      errors.push("Activity polling interval must be a positive number.");
    }

    if (!config.activity.jql?.trim()) {
      errors.push("Activity JQL query is required when activity is enabled.");
    }
  }

  return { errors };
}

function buildValidationQueries(config: Config): { name: string; jql: string }[] {
  const queries = config.views.map((view) => ({
    name: view.name,
    jql: injectProjectConstraintAtEnd(view.jql, config.project),
  }));

  if (config.activity?.enabled) {
    queries.push({
      name: "Activity",
      jql: injectProjectConstraintAtEnd(config.activity.jql, config.project),
    });
  }

  return queries;
}

function loadConfigFromDisk(): Config {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Config;
}

function shouldAutoRunWizard(config: Config): boolean {
  if (!Array.isArray(config.views) || config.views.length === 0) return true;
  return config.views.every((view) => !view?.jql?.trim());
}

async function preflightConfigAndJql(): Promise<void> {
  let config: Config;
  try {
    config = loadConfigFromDisk();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new Error(
      `Failed to load config.json. Copy config.json.example or run: bun run start -- --config\n${message}`
    );
  }

  const configValidation = validateConfig(config);
  if (configValidation.errors.length > 0) {
    const lines = configValidation.errors.map((error) => `- ${error}`);
    throw new Error(`Config validation failed:\n${lines.join("\n")}`);
  }

  const validationQueries = buildValidationQueries(config);
  if (validationQueries.length === 0) {
    throw new Error(
      "No views configured. Create config.json (copy config.json.example) or run: bun run start -- --config"
    );
  }

  const client = new JiraClient(config.domain);
  const results = await client.validateJql(validationQueries.map((q) => q.jql));
  const failures = results
    .map((result, index) => ({ result, query: validationQueries[index] }))
    .filter((entry) => entry.query && !entry.result.valid);

  if (failures.length > 0) {
    const lines = failures.flatMap((failure) => {
      const name = failure.query?.name ?? "Unknown";
      const errors = failure.result.errors.length > 0 ? failure.result.errors : ["Invalid JQL"];
      return errors.map((error) => `- ${name}: ${error}`);
    });
    throw new Error(`JQL validation failed:\n${lines.join("\n")}`);
  }
}

function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function loadState(): AppState {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as AppState;
  } catch {
    return { flaggedIssueKeys: [] };
  }
}

function saveState(state: AppState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

type SortOption = "created" | "updated" | "owner" | "flagged";

interface IssueRowProps {
  issue: JiraIssue;
  isSelected: boolean;
  isNew: boolean;
  isFlagged: boolean;
  blinkOn: boolean;
  columns: { key: number; subject: number; owner: number; status: number };
}

function getRowColors(isNew: boolean, isSelected: boolean, blinkOn: boolean) {
  if (isNew) {
    return { bg: blinkOn ? "#DC2626" : "#7F1D1D", fg: "#FFFFFF" };
  }
  if (isSelected) {
    return { bg: "#3B82F6", fg: "#FFFFFF" };
  }
  return { bg: undefined, fg: "#E5E5E5" };
}

function truncateOrPad(text: string, width: number): string {
  if (text.length > width) {
    return text.slice(0, width - 3) + "...";
  }
  return text.padEnd(width);
}

function IssueRow({ issue, isSelected, isNew, isFlagged, blinkOn, columns }: IssueRowProps) {
  const { bg, fg } = getRowColors(isNew, isSelected, blinkOn);
  
  const flagIcon = isFlagged ? " *" : "";
  const keyWithFlag = (issue.key + flagIcon).padEnd(columns.key);
  const subject = truncateOrPad(getIssueSubject(issue), columns.subject);
  const owner = getIssueOwner(issue).padEnd(columns.owner);
  const status = getIssueStatus(issue).padEnd(columns.status);

  return (
    <box style={{ width: "100%", height: 1, backgroundColor: bg }}>
      <text fg={fg}>
        {` ${keyWithFlag} | ${subject} | ${owner} | ${status}`}
      </text>
    </box>
  );
}

interface IssueListProps {
  issues: JiraIssue[];
  selectedIndex: number;
  newIssueIds: Set<string>;
  flaggedIssueKeys: Set<string>;
  blinkOn: boolean;
  columns: { key: number; subject: number; owner: number; status: number };
}

interface ScrollboxHandle {
  scrollTo: (position: number | { y: number }) => void;
  scrollTop: number;
  viewport: { height: number };
}

function IssueList({ issues, selectedIndex, newIssueIds, flaggedIssueKeys, blinkOn, columns }: IssueListProps) {
  const scrollboxRef = useRef<ScrollboxHandle | null>(null);

  useEffect(() => {
    const scrollbox = scrollboxRef.current;
    if (!scrollbox || issues.length === 0) return;

    const viewportHeight = scrollbox.viewport.height;
    const currentScrollTop = scrollbox.scrollTop;
    const selectedRow = selectedIndex;

    if (selectedRow < currentScrollTop) {
      scrollbox.scrollTo({ y: selectedRow });
    } else if (selectedRow >= currentScrollTop + viewportHeight) {
      scrollbox.scrollTo({ y: selectedRow - viewportHeight + 1 });
    }
  }, [selectedIndex, issues.length]);

  if (issues.length === 0) {
    return (
      <box padding={2}>
        <text fg="#888888">No issues found</text>
      </box>
    );
  }

  const headerKey = "Issue".padEnd(columns.key);
  const headerSubject = "Subject".padEnd(columns.subject);
  const headerOwner = "Owner".padEnd(columns.owner);
  const headerStatus = "Status".padEnd(columns.status);

  return (
    <box flexDirection="column" style={{ width: "100%", height: "100%" }}>
      <box style={{ width: "100%", height: 1 }}>
        <text fg="#10B981">
          <strong>{` ${headerKey} | ${headerSubject} | ${headerOwner} | ${headerStatus}`}</strong>
        </text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
      <scrollbox ref={scrollboxRef} style={{ flexGrow: 1 }}>
        {issues.map((issue, index) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            isSelected={index === selectedIndex}
            isNew={newIssueIds.has(issue.id)}
            isFlagged={flaggedIssueKeys.has(issue.key)}
            blinkOn={blinkOn}
            columns={columns}
          />
        ))}
      </scrollbox>
    </box>
  );
}

interface TabBarProps {
  tabs: string[];
  selectedIndex: number;
}

function TabBar({ tabs, selectedIndex }: TabBarProps) {
  return (
    <box flexDirection="row" style={{ width: "100%", gap: 1 }}>
      {tabs.map((name, index) => {
        const isActive = index === selectedIndex;
        return (
          <box
            key={name}
            style={{
              paddingLeft: 1,
              paddingRight: 1,
              backgroundColor: isActive ? "#3B82F6" : "#374151",
            }}
          >
            <text fg={isActive ? "#FFFFFF" : "#9CA3AF"}>
              {isActive ? <strong>{name}</strong> : name}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function sortIssues(issues: JiraIssue[], sortBy: SortOption, flaggedKeys: Set<string>): JiraIssue[] {
  return [...issues].sort((a, b) => {
    switch (sortBy) {
      case "owner":
        return getIssueOwner(a).localeCompare(getIssueOwner(b));
      case "created":
        return getIssueCreated(b).getTime() - getIssueCreated(a).getTime();
      case "updated":
        return getIssueUpdated(b).getTime() - getIssueUpdated(a).getTime();
      case "flagged": {
        const aFlagged = flaggedKeys.has(a.key) ? 0 : 1;
        const bFlagged = flaggedKeys.has(b.key) ? 0 : 1;
        if (aFlagged !== bFlagged) return aFlagged - bFlagged;
        return getIssueCreated(b).getTime() - getIssueCreated(a).getTime();
      }
      default:
        return 0;
    }
  });
}

const SORT_LABELS: Record<SortOption, string> = {
  created: "Created",
  updated: "Updated",
  owner: "Owner",
  flagged: "Flagged",
};

interface IssueCacheEntry {
  issues: JiraIssue[];
  fetchedAt: number;
}

type IssueCache = Record<number, IssueCacheEntry>;

function openUrl(url: string): void {
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Failed to open URL");
  }
}

interface JqlModalProps {
  tabName: string;
  jql: string;
  width: number;
  height: number;
}

function JqlModal({ tabName, jql, width, height }: JqlModalProps) {
  const modalWidth = Math.min(width - 8, 80);
  const lines = jql.split("\n");
  const contentHeight = Math.min(lines.length + 4, height - 8);

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      style={{
        position: "absolute",
        left: Math.floor((width - modalWidth) / 2),
        top: Math.floor((height - contentHeight) / 2),
        width: modalWidth,
        height: contentHeight,
        backgroundColor: "#1F2937",
        zIndex: 100,
      }}
    >
      <box style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#10B981">
          <strong>{tabName} - JQL Query</strong>
        </text>
      </box>
      <box style={{ height: 1 }} />
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}>
        {lines.map((line, i) => (
          <text key={i} fg="#E5E5E5">{line}</text>
        ))}
      </scrollbox>
      <box style={{ paddingLeft: 1 }}>
        <text fg="#6B7280">Press ESC to close</text>
      </box>
    </box>
  );
}

type SettingsMode = "menu" | "views" | "edit-view" | "activity" | "project";

interface SettingsModalProps {
  config: Config;
  width: number;
  height: number;
  onSave: (config: Config) => void;
  onClose: () => void;
  onKeyEvent: (handler: (key: KeyEvent) => boolean) => void;
}

function SettingsModal({ config, width, height, onSave, onClose, onKeyEvent }: SettingsModalProps) {
  const [mode, setMode] = useState<SettingsMode>("menu");
  const [menuIndex, setMenuIndex] = useState(0);
  const [viewIndex, setViewIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editingConfig, setEditingConfig] = useState<Config>(() => JSON.parse(JSON.stringify(config)));
  const [editField, setEditField] = useState<"name" | "jql" | "project" | "interval" | "activityJql" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [isNewView, setIsNewView] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const modalWidth = Math.min(width - 4, 90);
  const modalHeight = Math.min(height - 4, 25);

  type EditFieldType = typeof editField;
  
  function startEditing(field: NonNullable<EditFieldType>, value: string): void {
    setEditField(field);
    setEditValue(value);
    setCursorPos(value.length);
  }

  function clearEditState(): void {
    setEditField(null);
    setEditValue("");
    setCursorPos(0);
    setValidationError(null);
  }

  const menuItems = [
    { label: `Project: ${editingConfig.project}`, action: "project" },
    { label: `Views (${editingConfig.views.length})`, action: "views" },
    { label: `Activity: ${editingConfig.activity?.enabled ? "Enabled" : "Disabled"}`, action: "activity" },
    { label: "Save & Close", action: "save" },
    { label: "Cancel", action: "cancel" },
  ];

  const validateJql = async (jql: string): Promise<string | null> => {
    try {
      const client = new JiraClient(editingConfig.domain);
      const injected = injectProjectConstraintAtEnd(jql, editingConfig.project);
      const [result] = await client.validateJql([injected]);
      if (!result?.valid) {
        return result?.errors[0] ?? "Invalid JQL";
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Validation failed";
    }
  };

  useEffect(() => {
    const handler = (key: KeyEvent): boolean => {
      if (validating) return true;

      if (editField) {
        if (key.name === "escape") {
          clearEditState();
          return true;
        }
        if (key.name === "return") {
          if (editField === "jql" || editField === "activityJql") {
            setValidating(true);
            validateJql(editValue).then((error) => {
              setValidating(false);
              if (error) {
                setValidationError(error);
              } else {
                applyEdit();
              }
            });
          } else {
            applyEdit();
          }
          return true;
        }
        if (key.name === "left") {
          setCursorPos((p) => Math.max(0, p - 1));
          return true;
        }
        if (key.name === "right") {
          setCursorPos((p) => Math.min(editValue.length, p + 1));
          return true;
        }
        if (key.name === "home" || (key.ctrl && key.name === "a")) {
          setCursorPos(0);
          return true;
        }
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
          setCursorPos(editValue.length);
          return true;
        }
        if (key.name === "backspace") {
          if (cursorPos > 0) {
            setEditValue((v) => v.slice(0, cursorPos - 1) + v.slice(cursorPos));
            setCursorPos((p) => p - 1);
          }
          setValidationError(null);
          return true;
        }
        if (key.name === "delete") {
          if (cursorPos < editValue.length) {
            setEditValue((v) => v.slice(0, cursorPos) + v.slice(cursorPos + 1));
          }
          setValidationError(null);
          return true;
        }
        // Handle paste (Ctrl+V on Linux/Windows, Cmd+V on macOS)
        if ((key.ctrl || key.meta) && key.name === "v") {
          try {
            const pastedText = clipboard.readSync();
            if (pastedText) {
              // Normalize line endings and filter based on field type
              let normalizedText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
              // For single-line fields (name, project, interval), strip newlines
              if (editField === "name" || editField === "project" || editField === "interval") {
                normalizedText = normalizedText.replace(/\n/g, " ").trim();
              }
              setEditValue((v) => v.slice(0, cursorPos) + normalizedText + v.slice(cursorPos));
              setCursorPos((p) => p + normalizedText.length);
              setValidationError(null);
            }
          } catch {
          }
          return true;
        }
        if (key.sequence && key.sequence.length >= 1) {
          const printable = key.sequence.split("").filter((c) => c.charCodeAt(0) >= 32).join("");
          if (printable.length > 0) {
            setEditValue((v) => v.slice(0, cursorPos) + printable + v.slice(cursorPos));
            setCursorPos((p) => p + printable.length);
            setValidationError(null);
          }
          return true;
        }
        return true;
      }

      if (key.name === "escape") {
        if (mode === "menu") {
          onClose();
        } else {
          setMode("menu");
          setValidationError(null);
        }
        return true;
      }

      if (key.name === "up" || key.name === "k") {
        if (mode === "menu") {
          setMenuIndex((i) => Math.max(0, i - 1));
        } else if (mode === "views") {
          setViewIndex((i) => Math.max(0, i - 1));
        } else if (mode === "edit-view") {
          setFieldIndex((i) => Math.max(0, i - 1));
        }
        return true;
      }

      if (key.name === "down" || key.name === "j") {
        if (mode === "menu") {
          setMenuIndex((i) => Math.min(menuItems.length - 1, i + 1));
        } else if (mode === "views") {
          setViewIndex((i) => Math.min(editingConfig.views.length + 1, i + 1));
        } else if (mode === "edit-view") {
          setFieldIndex((i) => Math.min(1, i + 1));
        }
        return true;
      }

      if (key.name === "return") {
        if (mode === "menu") {
          handleMenuSelect();
        } else if (mode === "views") {
          handleViewSelect();
        } else if (mode === "edit-view") {
          handleEditViewSelect();
        } else if (mode === "activity") {
          handleActivitySelect();
        } else if (mode === "project") {
          startEditing("project", editingConfig.project);
        }
        return true;
      }

      if (key.name === "d" && mode === "views" && viewIndex < editingConfig.views.length) {
        const newViews = [...editingConfig.views];
        newViews.splice(viewIndex, 1);
        setEditingConfig({ ...editingConfig, views: newViews });
        setViewIndex((i) => Math.min(i, newViews.length));
        return true;
      }

      return true;
    };

    onKeyEvent(handler);
  });

  const applyEdit = () => {
    if (editField === "project") {
      setEditingConfig({ ...editingConfig, project: editValue });
      setMode("menu");
    } else if (editField === "name" && mode === "edit-view") {
      const newViews = [...editingConfig.views];
      if (isNewView) {
        newViews.push({ name: editValue, jql: "" });
        setViewIndex(newViews.length - 1);
      } else {
        const view = newViews[viewIndex];
        if (view) view.name = editValue;
      }
      setEditingConfig({ ...editingConfig, views: newViews });
      if (isNewView) {
        startEditing("jql", "");
        setIsNewView(false);
        return;
      }
    } else if (editField === "jql" && mode === "edit-view") {
      const newViews = [...editingConfig.views];
      const view = newViews[viewIndex];
      if (view) view.jql = editValue;
      setEditingConfig({ ...editingConfig, views: newViews });
    } else if (editField === "interval") {
      const interval = parseInt(editValue, 10);
      if (interval > 0) {
        setEditingConfig({
          ...editingConfig,
          activity: { ...editingConfig.activity!, pollingIntervalMinutes: interval },
        });
      }
    } else if (editField === "activityJql") {
      setEditingConfig({
        ...editingConfig,
        activity: { ...editingConfig.activity!, jql: editValue },
      });
    }
    clearEditState();
  };

  const handleMenuSelect = () => {
    const item = menuItems[menuIndex];
    if (!item) return;
    
    switch (item.action) {
      case "project":
        setMode("project");
        startEditing("project", editingConfig.project);
        break;
      case "views":
        setMode("views");
        setViewIndex(0);
        break;
      case "activity":
        setMode("activity");
        break;
      case "save":
        onSave(editingConfig);
        break;
      case "cancel":
        onClose();
        break;
    }
  };

  const handleViewSelect = () => {
    if (viewIndex === editingConfig.views.length) {
      setMode("edit-view");
      setIsNewView(true);
      setFieldIndex(0);
      startEditing("name", "");
    } else if (viewIndex === editingConfig.views.length + 1) {
      setMode("menu");
    } else {
      setMode("edit-view");
      setIsNewView(false);
      setFieldIndex(0);
    }
  };

  const handleEditViewSelect = () => {
    const view = editingConfig.views[viewIndex];
    if (!view) return;
    
    if (fieldIndex === 0) {
      startEditing("name", view.name);
    } else {
      startEditing("jql", view.jql);
    }
  };

  const handleActivitySelect = () => {
    if (!editingConfig.activity) {
      setEditingConfig({
        ...editingConfig,
        activity: {
          enabled: true,
          pollingIntervalMinutes: 5,
          jql: "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC",
        },
      });
    } else {
      setEditingConfig({
        ...editingConfig,
        activity: { ...editingConfig.activity, enabled: !editingConfig.activity.enabled },
      });
    }
  };

  const renderMenu = () => (
    <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1 }}>
      {menuItems.map((item, i) => (
        <box key={item.action} style={{ backgroundColor: i === menuIndex ? "#3B82F6" : undefined }}>
          <text fg={i === menuIndex ? "#FFFFFF" : "#E5E5E5"}>
            {i === menuIndex ? " > " : "   "}{item.label}
          </text>
        </box>
      ))}
    </box>
  );

  const renderViews = () => {
    const items = [
      ...editingConfig.views.map((v) => v.name),
      "[+ Add View]",
      "[Back]",
    ];
    
    return (
      <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#10B981"><strong>Views</strong></text>
        <text fg="#6B7280">Enter to edit, D to delete</text>
        <box style={{ height: 1 }} />
        {items.map((item, i) => (
          <box key={i} style={{ backgroundColor: i === viewIndex ? "#3B82F6" : undefined }}>
            <text fg={i === viewIndex ? "#FFFFFF" : "#E5E5E5"}>
              {i === viewIndex ? " > " : "   "}{item}
            </text>
          </box>
        ))}
      </box>
    );
  };

  const renderTextWithCursor = (text: string, pos: number): string => {
    return text.slice(0, pos) + "▏" + text.slice(pos);
  };

  const renderEditView = () => {
    const view = editingConfig.views[viewIndex];
    if (!view && !isNewView) return null;

    const nameSelected = fieldIndex === 0 && !editField;
    const jqlSelected = fieldIndex === 1 && !editField;
    
    function getBorderColor(isEditing: boolean, isSelected: boolean): string {
      if (isEditing) return "#FBBF24";
      if (isSelected) return "#3B82F6";
      return "#374151";
    }
    
    const nameBorderColor = getBorderColor(editField === "name", nameSelected);
    const jqlBorderColor = getBorderColor(editField === "jql", jqlSelected);

    return (
      <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#10B981"><strong>{isNewView ? "New View" : `Edit: ${view?.name}`}</strong></text>
        <box style={{ height: 1 }} />
        
        <text fg={nameSelected ? "#FFFFFF" : "#9CA3AF"}>{nameSelected ? "> " : "  "}Name:</text>
        <box
          border
          borderStyle="rounded"
          style={{
            borderColor: nameBorderColor,
            paddingLeft: 1,
            paddingRight: 1,
            marginBottom: 1,
          }}
        >
          <text fg="#E5E5E5">
            {editField === "name" ? renderTextWithCursor(editValue, cursorPos) : (view?.name || "")}
          </text>
        </box>
        
        <text fg={jqlSelected ? "#FFFFFF" : "#9CA3AF"}>{jqlSelected ? "> " : "  "}JQL:</text>
        <box
          border
          borderStyle="rounded"
          style={{
            borderColor: jqlBorderColor,
            paddingLeft: 1,
            paddingRight: 1,
            height: 4,
          }}
        >
          <text fg="#E5E5E5">
            {editField === "jql" ? renderTextWithCursor(editValue, cursorPos) : (view?.jql || "")}
          </text>
        </box>

        {validationError && (
          <text fg="#EF4444">{validationError}</text>
        )}
        {validating && (
          <text fg="#FBBF24">Validating...</text>
        )}
        
        <box style={{ height: 1 }} />
        <text fg="#6B7280">
          {editField ? "←/→: move cursor, Enter: save, ESC: cancel" : "j/k: select field, Enter: edit, ESC: back"}
        </text>
      </box>
    );
  };

  const renderActivity = () => {
    const activity = editingConfig.activity;
    
    return (
      <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#10B981"><strong>Activity Panel</strong></text>
        <box style={{ height: 1 }} />
        
        <box style={{ marginBottom: 1 }}>
          <text fg="#E5E5E5">
            Status: {activity?.enabled ? "Enabled" : "Disabled"} (Enter to toggle)
          </text>
        </box>
        
        {activity?.enabled && (
          <>
            <text fg="#9CA3AF">Polling Interval (minutes):</text>
            <box
              border
              borderStyle="rounded"
              style={{
                borderColor: editField === "interval" ? "#FBBF24" : "#374151",
                paddingLeft: 1,
                paddingRight: 1,
                marginBottom: 1,
                width: 20,
              }}
            >
              <text fg="#E5E5E5">
                {editField === "interval" ? renderTextWithCursor(editValue, cursorPos) : String(activity.pollingIntervalMinutes)}
              </text>
            </box>
            
            <text fg="#9CA3AF">JQL:</text>
            <box
              border
              borderStyle="rounded"
              style={{
                borderColor: editField === "activityJql" ? "#FBBF24" : "#374151",
                paddingLeft: 1,
                paddingRight: 1,
                height: 3,
              }}
            >
              <text fg="#E5E5E5">
                {editField === "activityJql" ? renderTextWithCursor(editValue, cursorPos) : activity.jql}
              </text>
            </box>

            {validationError && (
              <text fg="#EF4444">{validationError}</text>
            )}
            {validating && (
              <text fg="#FBBF24">Validating...</text>
            )}
          </>
        )}
        
        <box style={{ height: 1 }} />
        <text fg="#6B7280">
          {editField ? "Type to edit, Enter to save, ESC to cancel" : "I: interval, J: JQL, ESC: back"}
        </text>
      </box>
    );
  };

  const renderProject = () => (
    <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1 }}>
      <text fg="#10B981"><strong>Project Key</strong></text>
      <box style={{ height: 1 }} />
      
      <box
        border
        borderStyle="rounded"
        style={{
          borderColor: "#FBBF24",
          paddingLeft: 1,
          paddingRight: 1,
          width: 30,
        }}
      >
        <text fg="#E5E5E5">{renderTextWithCursor(editValue, cursorPos)}</text>
      </box>
      
      <box style={{ height: 1 }} />
      <text fg="#6B7280">←/→: move cursor, Enter: save, ESC: cancel</text>
    </box>
  );

  useEffect(() => {
    if (mode === "activity" && !editField) {
      const handler = (key: KeyEvent): boolean => {
        if (!editingConfig.activity?.enabled) return false;
        
        if (key.name === "i") {
          startEditing("interval", String(editingConfig.activity.pollingIntervalMinutes));
          return true;
        }
        if (key.name === "j" || key.name === "J") {
          startEditing("activityJql", editingConfig.activity.jql);
          return true;
        }
        return false;
      };
      onKeyEvent(handler);
    }
  }, [mode, editField, editingConfig.activity]);

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      style={{
        position: "absolute",
        left: Math.floor((width - modalWidth) / 2),
        top: Math.floor((height - modalHeight) / 2),
        width: modalWidth,
        height: modalHeight,
        backgroundColor: "#111827",
        zIndex: 100,
      }}
    >
      <box style={{ paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <text fg="#F59E0B"><strong>Settings</strong></text>
      </box>
      
      <box style={{ flexGrow: 1 }}>
        {mode === "menu" && renderMenu()}
        {mode === "views" && renderViews()}
        {mode === "edit-view" && renderEditView()}
        {mode === "activity" && renderActivity()}
        {mode === "project" && renderProject()}
      </box>
      
      <box style={{ paddingLeft: 1 }}>
        <text fg="#4B5563">j/k: navigate | Enter: select | ESC: back</text>
      </box>
    </box>
  );
}

interface AppProps {
  prevalidated: boolean;
  onExit: (code?: number) => void;
}

function App({ prevalidated, onExit }: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [appState, setAppState] = useState<AppState>(() => loadState());
  const [issueCache, setIssueCache] = useState<IssueCache>({});
  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ViewValidation[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>("created");
  const [newIssueIds, setNewIssueIds] = useState<Set<string>>(new Set());
  const [blinkOn, setBlinkOn] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [showJqlModal, setShowJqlModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  const knownIssueIds = useRef<Set<string>>(new Set());
  const jiraClient = useRef<JiraClient | null>(null);
  const validationDone = useRef(false);
  const settingsKeyHandler = useRef<((key: KeyEvent) => boolean) | null>(null);
  const prevalidatedInitial = useRef(prevalidated);
  const issueCacheRef = useRef<IssueCache>({});

  const flaggedIssueKeys = new Set(appState.flaggedIssueKeys);

  const statusCol = 20;
  
  const tableWidth = width - 6;
  const leadingSpace = 1;
  const separators = 9;
  
  const columns = {
    key: 12,
    owner: 20,
    status: statusCol,
    subject: 0,
  };
  
  const fixedWidth = leadingSpace + columns.key + columns.owner + columns.status + separators;
  columns.subject = Math.max(0, tableWidth - fixedWidth);

  const activityEnabled = config.activity?.enabled ?? false;
  const activityTabName = "Activity";
  const viewTabs = config.views.map((v) => v.name);
  const tabs = [
    ...viewTabs,
    ...(activityEnabled ? [activityTabName] : []),
  ];
  const activityTabIndex = activityEnabled ? tabs.length - 1 : -1;

  const currentEntry = issueCache[selectedTabIndex];
  const currentIssues = currentEntry?.issues ?? [];
  const sortedIssues = sortIssues(currentIssues, sortBy, flaggedIssueKeys);

  const fetchIssuesForTab = async (tabIndex: number): Promise<JiraIssue[]> => {
    if (!jiraClient.current) {
      jiraClient.current = new JiraClient(config.domain);
    }
    
    const client = jiraClient.current;
    
    if (tabIndex === activityTabIndex && config.activity) {
      return client.searchWithProjectConstraint(config.project, config.activity.jql);
    }
    
    const view = config.views[tabIndex];
    if (!view) return [];
    return client.searchWithProjectConstraint(config.project, view.jql);
  };

  const trackNewIssues = (issues: JiraIssue[], isInitial: boolean) => {
    const newIds: string[] = [];
    for (const issue of issues) {
      if (!isInitial && !knownIssueIds.current.has(issue.id)) {
        newIds.push(issue.id);
      }
      knownIssueIds.current.add(issue.id);
    }
    if (newIds.length > 0) {
      setNewIssueIds((prev) => new Set([...prev, ...newIds]));
    }
  };

  const fetchAllTabs = async (isInitial = false, force = false) => {
    try {
      const newCache: IssueCache = {};
      const now = Date.now();
      let didFetch = false;
      
      for (let i = 0; i < tabs.length; i++) {
        if (i === activityTabIndex) continue;
        const cacheEntry = issueCacheRef.current[i];
        const isFresh = !force && !isInitial && cacheEntry && now - cacheEntry.fetchedAt < ISSUE_CACHE_TTL_MS;

        if (isFresh && cacheEntry) {
          newCache[i] = cacheEntry;
          continue;
        }

        setLoadingProgress(`Loading ${tabs[i]}... (${i + 1}/${tabs.length})`);
        const issues = await fetchIssuesForTab(i);
        newCache[i] = { issues, fetchedAt: now };
        trackNewIssues(issues, isInitial);
        didFetch = true;
      }
      
      setIssueCache((prev) => ({ ...prev, ...newCache }));
      if (didFetch || isInitial) {
        setLastRefresh(new Date());
      }
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  };

  useEffect(() => {
    const validateAndFetch = async () => {
      if (validationDone.current) return;
      validationDone.current = true;

      const configValidation = validateConfig(config);
      if (configValidation.errors.length > 0) {
        setError(configValidation.errors.join("\n"));
        setLoading(false);
        return;
      }

      if (prevalidatedInitial.current) {
        prevalidatedInitial.current = false;
        fetchAllTabs(true);
        return;
      }
      
      if (!jiraClient.current) {
        jiraClient.current = new JiraClient(config.domain);
      }
      
      setLoadingProgress("Validating JQL queries...");
      
      const allJql = buildValidationQueries(config);

      if (allJql.length === 0) {
        setError(
          "No views configured. Create config.json (copy config.json.example) or run: bun run start -- --config",
        );
        setLoading(false);
        return;
      }
      
      try {
        const results = await jiraClient.current.validateJql(allJql.map((q) => q.jql));
        
        const validationResults: ViewValidation[] = results
          .map((result, i) => {
            const item = allJql[i];
            if (!item) return null;
            return {
              name: item.name,
              jql: item.jql,
              valid: result.valid,
              errors: result.errors,
              warnings: result.warnings,
            };
          })
          .filter((v): v is ViewValidation => v !== null && (!v.valid || v.warnings.length > 0));
        
        const hasErrors = validationResults.some((v) => !v.valid);
        if (hasErrors) {
          setValidationErrors(validationResults.filter((v) => !v.valid));
          setLoading(false);
          return;
        }
        
        fetchAllTabs(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Validation failed");
        setLoading(false);
      }
    };
    
    validateAndFetch();
  }, [config]);

  useEffect(() => {
    issueCacheRef.current = issueCache;
  }, [issueCache]);

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      fetchAllTabs(false);
    }, 60000);

    return () => clearInterval(refreshInterval);
  }, [config.project, config.views]);

  useEffect(() => {
    if (!activityEnabled || activityTabIndex === -1 || !config.activity) return;
    
    const intervalMs = config.activity.pollingIntervalMinutes * 60 * 1000;

    const fetchActivityIssues = async (isInitial = false) => {
      if (!jiraClient.current || !config.activity) return;
      
      try {
        const issues = await jiraClient.current.searchWithProjectConstraint(
          config.project,
          config.activity.jql
        );
        trackNewIssues(issues, isInitial);
        setIssueCache((prev) => ({
          ...prev,
          [activityTabIndex]: { issues, fetchedAt: Date.now() },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`Activity refresh failed: ${message}`);
      }
    };
    
    fetchActivityIssues(true);
    const activityInterval = setInterval(() => fetchActivityIssues(false), intervalMs);

    return () => clearInterval(activityInterval);
  }, [activityEnabled, activityTabIndex, config.project, config.activity]);

  useEffect(() => {
    if (newIssueIds.size === 0) return;

    const blinkInterval = setInterval(() => {
      setBlinkOn((prev) => !prev);
    }, 500);

    return () => clearInterval(blinkInterval);
  }, [newIssueIds.size]);

  useEffect(() => {
    setSelectedRowIndex(0);
  }, [selectedTabIndex, sortBy]);

  const cycleSortOption = () => {
    const sortOrder: SortOption[] = ["created", "updated", "owner", "flagged"];
    setSortBy((prev) => {
      const nextIndex = (sortOrder.indexOf(prev) + 1) % sortOrder.length;
      return sortOrder[nextIndex] as SortOption;
    });
  };

  const openSelectedIssue = () => {
    const selectedIssue = sortedIssues[selectedRowIndex];
    if (selectedIssue) {
      openUrl(`https://${config.domain}/browse/${selectedIssue.key}`);
    }
  };

  const toggleFlagSelectedIssue = () => {
    const selectedIssue = sortedIssues[selectedRowIndex];
    if (!selectedIssue) return;

    const newFlaggedKeys = new Set(appState.flaggedIssueKeys);
    if (newFlaggedKeys.has(selectedIssue.key)) {
      newFlaggedKeys.delete(selectedIssue.key);
    } else {
      newFlaggedKeys.add(selectedIssue.key);
    }

    const newState: AppState = { flaggedIssueKeys: Array.from(newFlaggedKeys) };
    saveState(newState);
    setAppState(newState);
  };

  const handleSettingsSave = (newConfig: Config) => {
    saveConfig(newConfig);
    setConfig(newConfig);
    setShowSettings(false);
    setLoading(true);
    validationDone.current = false;
    setIssueCache({});
    setNewIssueIds(new Set());
  };

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      onExit(0);
    }

    if (showSettings) {
      if (settingsKeyHandler.current) {
        settingsKeyHandler.current(key);
      }
      return;
    }

    if (key.name === "escape") {
      if (showJqlModal) {
        setShowJqlModal(false);
      } else {
        onExit(0);
      }
      return;
    }

    if (showJqlModal) return;

    switch (key.name) {
      case "tab":
        if (key.shift) {
          setSelectedTabIndex((prev) => (prev > 0 ? prev - 1 : tabs.length - 1));
        } else {
          setSelectedTabIndex((prev) => (prev < tabs.length - 1 ? prev + 1 : 0));
        }
        break;
      case "down":
      case "j":
        setSelectedRowIndex((prev) => Math.min(prev + 1, sortedIssues.length - 1));
        break;
      case "up":
      case "k":
        setSelectedRowIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "s":
        cycleSortOption();
        break;
      case "r":
        setLoading(true);
        fetchAllTabs(false, true);
        break;
      case "c":
        setNewIssueIds(new Set());
        break;
      case "o":
        openSelectedIssue();
        break;
      case "f":
        toggleFlagSelectedIssue();
        break;
      case "e":
        setShowSettings(true);
        break;
      case "d":
        setShowJqlModal(true);
        break;
    }
  });

  if (loading) {
    return (
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        style={{
          width: Math.min(width - 2, 120),
          height: Math.min(height - 2, 30),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text fg="#FFD700">{loadingProgress || "Loading Jira issues..."}</text>
      </box>
    );
  }

  if (validationErrors.length > 0) {
    return (
      <ValidationErrorScreen
        validationErrors={validationErrors}
        width={width}
        height={height}
      />
    );
  }

  if (error) {
    return (
      <box
        flexDirection="column"
        padding={2}
        border
        borderStyle="rounded"
        style={{ width: Math.min(width - 2, 100), height: Math.min(height - 2, 20) }}
      >
        <text fg="#EF4444">
          <strong>Error</strong>
        </text>
        <text fg="#F87171">{error}</text>
        <text fg="#888888">Press Esc to exit</text>
      </box>
    );
  }

  const refreshTime = lastRefresh.toLocaleTimeString();

  const getCurrentJql = (): string => {
    if (selectedTabIndex === activityTabIndex && config.activity) {
      return config.activity.jql;
    }
    return config.views[selectedTabIndex]?.jql ?? "";
  };

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      title={` Jira - ${config.project} `}
      style={{
        width: width - 2,
        height: height - 2,
      }}
    >
      <box style={{ width: "100%", paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <TabBar tabs={tabs} selectedIndex={selectedTabIndex} />
      </box>

      <box style={{ flexGrow: 1, width: "100%" }}>
        <IssueList
          issues={sortedIssues}
          selectedIndex={selectedRowIndex}
          newIssueIds={newIssueIds}
          flaggedIssueKeys={flaggedIssueKeys}
          blinkOn={blinkOn}
          columns={columns}
        />
      </box>

      <box style={{ width: "100%", paddingLeft: 1 }}>
        <text fg="#6B7280">
          {`Tab: Views | j/k: Navigate | o: Open | f: Flag | d: JQL | s: Sort (${SORT_LABELS[sortBy]}) | r: Refresh | c: Clear | e: Settings | ${sortedIssues.length} issues | ${refreshTime}`}
        </text>
      </box>

      {showJqlModal && (
        <JqlModal
          tabName={tabs[selectedTabIndex] ?? ""}
          jql={getCurrentJql()}
          width={width}
          height={height}
        />
      )}

      {showSettings && (
        <SettingsModal
          config={config}
          width={width}
          height={height}
          onSave={handleSettingsSave}
          onClose={() => setShowSettings(false)}
          onKeyEvent={(handler) => { settingsKeyHandler.current = handler; }}
        />
      )}
    </box>
  );
}

function isOnboardingMode(argv: string[]): boolean {
  return argv.includes("--config");
}

async function main() {
  if (isOnboardingMode(process.argv.slice(2))) {
    await runConfigWizard();
    return;
  }

  if (!existsSync(CONFIG_PATH)) {
    await runConfigWizard();
    return;
  }

  try {
    const existingConfig = loadConfigFromDisk();
    if (shouldAutoRunWizard(existingConfig)) {
      await runConfigWizard();
      return;
    }
  } catch {
    // Fall through to preflight to surface parse errors.
  }

  let prevalidated = false;
  try {
    await preflightConfigAndJql();
    prevalidated = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(message);
    process.exit(1);
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  });

  const root = createRoot(renderer);
  const shutdown = (code = 0) => {
    try {
      root.unmount();
    } catch (err) {
      void err;
    }
    try {
      renderer.destroy();
    } catch (err) {
      void err;
    }
    process.exit(code);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  root.render(<App prevalidated={prevalidated} onExit={shutdown} />);
}

main().catch(console.error);
