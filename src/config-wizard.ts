import * as readline from "readline";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { JiraClient, injectProjectConstraintAtEnd } from "./jira-client.js";

interface View {
  name: string;
  jql: string;
}

interface Config {
  project: string;
  domain: string;
  views: View[];
  activity: {
    enabled: boolean;
    pollingIntervalMinutes: number;
    jql: string;
  };
}

const CONFIG_PATH = join(process.cwd(), "config.json");

function disableMouseReporting(): void {
  process.stdout.write("\x1b[?1000l");
  process.stdout.write("\x1b[?1002l");
  process.stdout.write("\x1b[?1003l");
  process.stdout.write("\x1b[?1006l");
}

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function askYesNo(rl: readline.Interface, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => resolve(answer.toLowerCase().startsWith("y")));
  });
}

async function askMenu(rl: readline.Interface, options: string[]): Promise<number> {
  console.log("");
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  console.log("");
  
  const answer = await ask(rl, "Enter choice: ");
  const choice = parseInt(answer.trim(), 10);
  
  if (choice >= 1 && choice <= options.length) {
    return choice - 1;
  }
  return -1;
}

async function readMultilineJql(rl: readline.Interface): Promise<string> {
  console.log("Enter JQL (paste multi-line, then press Enter twice to finish):");
  console.log("───────────────────────────────────────────────────────────────");
  
  const lines: string[] = [];
  let emptyLineCount = 0;
  
  return new Promise((resolve) => {
    const lineHandler = (line: string) => {
      if (line === "") {
        emptyLineCount++;
        if (emptyLineCount >= 1 && lines.length > 0) {
          rl.removeListener("line", lineHandler);
          resolve(lines.join("\n").trim());
          return;
        }
      } else {
        emptyLineCount = 0;
        lines.push(line);
      }
    };
    
    rl.on("line", lineHandler);
  });
}

async function validateJql(
  domain: string,
  jql: string,
  project: string,
): Promise<{ valid: boolean; errors: string[] }> {
  try {
    if (!domain.trim()) {
      return { valid: false, errors: ["Missing domain in config.json. Set it first."] };
    }
    const client = new JiraClient(domain);
    const injected = injectProjectConstraintAtEnd(jql, project);
    const [result] = await client.validateJql([injected]);
    
    if (!result) {
      return { valid: false, errors: ["Validation failed - no response"] };
    }
    
    return { valid: result.valid, errors: result.errors };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : "Unknown error"] };
  }
}

function loadExistingConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`\n✓ Config saved to ${CONFIG_PATH}`);
}

function printHeader(title: string): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  ${title}`);
  console.log("════════════════════════════════════════════════════════════════");
}

function printSubHeader(title: string): void {
  console.log("");
  console.log("────────────────────────────────────────────────────────────────");
  console.log(`  ${title}`);
  console.log("────────────────────────────────────────────────────────────────");
}

async function addView(rl: readline.Interface, config: Config): Promise<void> {
  printSubHeader("Add New View");
  
  const viewName = await ask(rl, "View name: ");
  if (!viewName.trim()) {
    console.log("Cancelled - no name provided.");
    return;
  }
  
  console.log("");
  const jql = await readMultilineJql(rl);
  if (!jql.trim()) {
    console.log("Cancelled - no JQL provided.");
    return;
  }
  
  console.log("\nValidating JQL...");
  const validation = await validateJql(config.domain, jql, config.project);
  
  if (!validation.valid) {
    console.log("\n❌ Invalid JQL:");
    for (const err of validation.errors) {
      console.log(`   ${err}`);
    }
    return;
  }
  
  console.log("✓ JQL is valid");
  
  config.views.push({ name: viewName.trim(), jql: jql.trim() });
  saveConfig(config);
}

async function editView(rl: readline.Interface, config: Config): Promise<void> {
  if (config.views.length === 0) {
    console.log("\nNo views to edit.");
    return;
  }
  
  printSubHeader("Edit View");
  
  const viewNames = config.views.map((v) => v.name);
  viewNames.push("Cancel");
  
  const choice = await askMenu(rl, viewNames);
  if (choice === -1 || choice === viewNames.length - 1) {
    console.log("Cancelled.");
    return;
  }
  
  const view = config.views[choice];
  if (!view) return;
  
  console.log(`\nEditing: ${view.name}`);
  console.log(`Current JQL:\n  ${view.jql.replace(/\n/g, "\n  ")}`);
  
  const editOptions = ["Edit name", "Edit JQL", "Edit both", "Cancel"];
  const editChoice = await askMenu(rl, editOptions);
  
  if (editChoice === -1 || editChoice === 3) {
    console.log("Cancelled.");
    return;
  }
  
  if (editChoice === 0 || editChoice === 2) {
    const newName = await ask(rl, `New name (Enter to keep "${view.name}"): `);
    if (newName.trim()) {
      view.name = newName.trim();
    }
  }
  
  if (editChoice === 1 || editChoice === 2) {
    console.log("");
    const newJql = await readMultilineJql(rl);
    if (newJql.trim()) {
    console.log("\nValidating JQL...");
      const validation = await validateJql(config.domain, newJql, config.project);
      
      if (!validation.valid) {
        console.log("\n❌ Invalid JQL:");
        for (const err of validation.errors) {
          console.log(`   ${err}`);
        }
        console.log("\nJQL not updated.");
        return;
      }
      
      console.log("✓ JQL is valid");
      view.jql = newJql.trim();
    }
  }
  
  saveConfig(config);
}

async function removeView(rl: readline.Interface, config: Config): Promise<void> {
  if (config.views.length === 0) {
    console.log("\nNo views to remove.");
    return;
  }
  
  if (config.views.length === 1) {
    console.log("\nCannot remove the last view. At least one view is required.");
    return;
  }
  
  printSubHeader("Remove View");
  
  const viewNames = config.views.map((v) => v.name);
  viewNames.push("Cancel");
  
  const choice = await askMenu(rl, viewNames);
  if (choice === -1 || choice === viewNames.length - 1) {
    console.log("Cancelled.");
    return;
  }
  
  const view = config.views[choice];
  if (!view) return;
  
  const confirm = await askYesNo(rl, `Remove "${view.name}"?`);
  if (!confirm) {
    console.log("Cancelled.");
    return;
  }
  
  config.views.splice(choice, 1);
  saveConfig(config);
  console.log(`✓ Removed "${view.name}"`);
}

async function configureActivity(rl: readline.Interface, config: Config): Promise<void> {
  printSubHeader("Activity Panel");
  
  const currentStatus = config.activity.enabled ? "enabled" : "disabled";
  console.log(`\nCurrent status: ${currentStatus}`);
  if (config.activity.enabled) {
    console.log(`Polling interval: ${config.activity.pollingIntervalMinutes} minutes`);
    console.log(`JQL: ${config.activity.jql.replace(/\n/g, "\n     ")}`);
  }
  
  const options = config.activity.enabled
    ? ["Disable", "Change polling interval", "Change JQL", "Cancel"]
    : ["Enable with defaults", "Enable with custom JQL", "Cancel"];
  
  const choice = await askMenu(rl, options);
  
  if (config.activity.enabled) {
    switch (choice) {
      case 0:
        config.activity.enabled = false;
        config.activity.jql = "";
        saveConfig(config);
        console.log("✓ Activity panel disabled");
        break;
      case 1:
        const intervalInput = await ask(rl, `New polling interval in minutes (current: ${config.activity.pollingIntervalMinutes}): `);
        const parsed = parseInt(intervalInput.trim(), 10);
        if (parsed > 0) {
          config.activity.pollingIntervalMinutes = parsed;
          saveConfig(config);
          console.log(`✓ Polling interval set to ${parsed} minutes`);
        } else {
          console.log("Invalid interval. Cancelled.");
        }
        break;
      case 2:
        console.log("");
        const newJql = await readMultilineJql(rl);
        if (newJql.trim()) {
        console.log("\nValidating JQL...");
          const validation = await validateJql(config.domain, newJql, config.project);
          if (!validation.valid) {
            console.log("\n❌ Invalid JQL:");
            for (const err of validation.errors) {
              console.log(`   ${err}`);
            }
            return;
          }
          console.log("✓ JQL is valid");
          config.activity.jql = newJql.trim();
          saveConfig(config);
        }
        break;
      default:
        console.log("Cancelled.");
    }
  } else {
    const defaultJql = "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC";
    
    switch (choice) {
      case 0:
        config.activity.enabled = true;
        config.activity.pollingIntervalMinutes = 5;
        config.activity.jql = defaultJql;
        saveConfig(config);
        console.log("✓ Activity panel enabled with defaults");
        break;
      case 1:
        console.log("");
        const customJql = await readMultilineJql(rl);
        if (customJql.trim()) {
          console.log("\nValidating JQL...");
          const validation = await validateJql(config.domain, customJql, config.project);
          if (!validation.valid) {
            console.log("\n❌ Invalid JQL:");
            for (const err of validation.errors) {
              console.log(`   ${err}`);
            }
            return;
          }
          console.log("✓ JQL is valid");
          
          const intervalInput = await ask(rl, "Polling interval in minutes (default 5): ");
          const parsed = parseInt(intervalInput.trim(), 10);
          
          config.activity.enabled = true;
          config.activity.pollingIntervalMinutes = parsed > 0 ? parsed : 5;
          config.activity.jql = customJql.trim();
          saveConfig(config);
          console.log("✓ Activity panel enabled");
        } else {
          console.log("Cancelled - no JQL provided.");
        }
        break;
      default:
        console.log("Cancelled.");
    }
  }
}

async function changeProject(rl: readline.Interface, config: Config): Promise<void> {
  printSubHeader("Change Project Key");
  
  console.log(`\nCurrent project: ${config.project}`);
  
  const newProject = await ask(rl, "New project key (Enter to cancel): ");
  if (!newProject.trim()) {
    console.log("Cancelled.");
    return;
  }
  
  const confirm = await askYesNo(rl, `Change project from "${config.project}" to "${newProject.trim()}"?`);
  if (!confirm) {
    console.log("Cancelled.");
    return;
  }
  
  config.project = newProject.trim();
  saveConfig(config);
  console.log(`✓ Project changed to "${config.project}"`);
}

async function runFullWizard(rl: readline.Interface): Promise<Config | null> {
  printHeader("Jira TUI Config Wizard");

  const defaultDomain = loadExistingConfig()?.domain?.trim() || "";
  const domainAnswer = await ask(
    rl,
    defaultDomain
      ? `Enter your Jira domain (default: ${defaultDomain}): `
      : "Enter your Jira domain (e.g., your-company.atlassian.net): "
  );
  const domain = (domainAnswer.trim() || defaultDomain).trim();
  if (!domain) {
    console.log("Error: Domain is required.");
    return null;
  }

  console.log(`\nDomain: ${domain}\n`);

  const project = await ask(rl, "Enter your Jira project key (e.g., PROJ): ");
  if (!project.trim()) {
    console.log("Error: Project key is required.");
    return null;
  }
  
  console.log(`\nProject: ${project.trim()}\n`);
  
  const views: View[] = [];
  let addMore = true;
  
  while (addMore) {
    printSubHeader(`Adding View #${views.length + 1}`);
    
    const viewName = await ask(rl, "View name (e.g., My Work): ");
    if (!viewName.trim()) {
      console.log("Error: View name is required.");
      continue;
    }
    
    console.log("");
    const jql = await readMultilineJql(rl);
    if (!jql.trim()) {
      console.log("Error: JQL is required.");
      continue;
    }
    
    console.log("\nValidating JQL...");
    const validation = await validateJql(domain, jql, project.trim());
    
    if (!validation.valid) {
      console.log("\n❌ Invalid JQL:");
      for (const err of validation.errors) {
        console.log(`   ${err}`);
      }
      console.log("");
      await askYesNo(rl, "Try again with different JQL?");
      continue;
    }
    
    console.log("✓ JQL is valid\n");

    views.push({ name: viewName.trim(), jql: jql.trim() });
    
    console.log(`✓ Added view: "${viewName.trim()}"`);
    console.log(`  Views so far: ${views.length}\n`);
    
    addMore = await askYesNo(rl, "Add another view?");
  }
  
  if (views.length === 0) {
    console.log("Error: At least one view is required.");
    return null;
  }
  
  printSubHeader("Activity Panel");
  
  console.log("\nThe Activity panel shows recently updated issues across all views");
  console.log("and polls more frequently than the main refresh cycle.\n");
  
  const enableActivity = await askYesNo(rl, "Enable Activity panel?");
  
  let activityJql = "";
  let activityPollingMinutes = 5;
  
  if (enableActivity) {
    console.log("\nDefault Activity JQL monitors issues you're involved with:");
    console.log("  (assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h\n");
    
    const useDefault = await askYesNo(rl, "Use default Activity JQL?");
    
    if (useDefault) {
      activityJql = "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC";
    } else {
      console.log("");
      activityJql = await readMultilineJql(rl);
      
      if (activityJql.trim()) {
        console.log("\nValidating Activity JQL...");
        const validation = await validateJql(domain, activityJql, project.trim());
        
        if (!validation.valid) {
          console.log("\n❌ Invalid Activity JQL:");
          for (const err of validation.errors) {
            console.log(`   ${err}`);
          }
          console.log("\nUsing default Activity JQL instead.");
          activityJql = "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC";
        } else {
          console.log("✓ Activity JQL is valid");
          activityJql = activityJql.trim();
        }
      } else {
        activityJql = "(assignee = currentUser() OR reporter = currentUser()) AND updated >= -1h ORDER BY updated DESC";
      }
    }
    
    console.log("");
    const pollingInput = await ask(rl, "Polling interval in minutes (default 5): ");
    const parsed = parseInt(pollingInput.trim(), 10);
    activityPollingMinutes = parsed > 0 ? parsed : 5;
    
    console.log(`✓ Activity panel enabled (polling every ${activityPollingMinutes} min)`);
  } else {
    console.log("✓ Activity panel disabled");
  }
  
  return {
    project: project.trim(),
    domain,
    views,
    activity: {
      enabled: enableActivity,
      pollingIntervalMinutes: activityPollingMinutes,
      jql: activityJql,
    },
  };
}

async function runMainMenu(rl: readline.Interface, config: Config): Promise<boolean> {
  printHeader("Jira TUI Settings");
  
  console.log(`\nProject: ${config.project}`);
  console.log(`Domain: ${config.domain}`);
  console.log(`Views: ${config.views.map((v) => v.name).join(", ")}`);
  console.log(`Activity: ${config.activity.enabled ? `enabled (${config.activity.pollingIntervalMinutes}min)` : "disabled"}`);
  
  const options = [
    "Add view",
    "Edit view",
    "Remove view",
    "Configure Activity panel",
    "Change project key",
    "Re-run full wizard",
    "Exit",
  ];
  
  const choice = await askMenu(rl, options);
  
  switch (choice) {
    case 0:
      await addView(rl, config);
      return true;
    case 1:
      await editView(rl, config);
      return true;
    case 2:
      await removeView(rl, config);
      return true;
    case 3:
      await configureActivity(rl, config);
      return true;
    case 4:
      await changeProject(rl, config);
      return true;
    case 5: {
      const newConfig = await runFullWizard(rl);
      if (newConfig) {
        saveConfig(newConfig);
      }
      return false;
    }
    case 6:
    default:
      return false;
  }
}

export async function runConfigWizard(): Promise<void> {
  disableMouseReporting();
  const rl = createPrompt();
  
  try {
    const existingConfig = loadExistingConfig();
    
    if (existingConfig && existingConfig.views.length > 0) {
      let continueMenu = true;
      while (continueMenu) {
        continueMenu = await runMainMenu(rl, existingConfig);
      }
    } else {
      const newConfig = await runFullWizard(rl);
      if (newConfig) {
        if (existsSync(CONFIG_PATH)) {
          console.log(`\n⚠️  ${CONFIG_PATH} already exists.`);
          const overwrite = await askYesNo(rl, "Overwrite?");
          if (!overwrite) {
            console.log("Aborted.");
            rl.close();
            process.exit(0);
          }
        }
        saveConfig(newConfig);
        
        console.log("\nViews configured:");
        for (const view of newConfig.views) {
          console.log(`  • ${view.name}`);
        }
        console.log("\nRun the TUI with: bun run start");
      }
    }
    
    console.log("");
    rl.close();
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    rl.close();
    process.exit(1);
  }
}
