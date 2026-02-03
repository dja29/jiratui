import { createInterface } from "readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function escapeForJson(jql: string): string {
  return jql
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatConfigEntry(name: string, jql: string): string {
  const escaped = escapeForJson(jql);
  return `{\n  "name": "${name}",\n  "jql": "${escaped}"\n}`;
}

console.log("JQL to Config Helper");
console.log("====================\n");
console.log("Paste your JQL query (can be multiple lines).");
console.log("When done, enter an empty line.\n");

let jqlLines: string[] = [];
let awaitingName = false;
let collectedJql = "";

rl.on("line", (line) => {
  if (awaitingName) {
    const name = line.trim() || "My View";
    console.log("\n--- Config Entry ---\n");
    console.log(formatConfigEntry(name, collectedJql));
    console.log("\n--- Raw Escaped JQL ---\n");
    console.log(escapeForJson(collectedJql));
    console.log("\n");
    
    jqlLines = [];
    awaitingName = false;
    collectedJql = "";
    
    console.log("Enter another JQL query, or Ctrl+C to exit.\n");
    return;
  }

  if (line === "") {
    if (jqlLines.length === 0) return;
    
    collectedJql = jqlLines.join(" ");
    awaitingName = true;
    console.log("\nEnter a name for this view (default: My View):");
    return;
  }

  jqlLines.push(line);
});

rl.on("close", () => {
  process.exit(0);
});
