#!/usr/bin/env node
// One command for the reliability harness (docs/reliability-report.md):
//
//   npm run reliability                      every scenario: S1-S6 local x10, S7 Claude x2, S8 faults x3
//   npm run reliability -- --local           S1-S6 only (no Claude usage)
//   npm run reliability -- --scenarios S1,S3 --runs 3
//
// It builds the headless harness (src-tauri/src/harness.rs) and runs it against a temp copy of the
// workspace in %USERPROFILE%\Dreamer (never the original). Output: a run folder under %TEMP% with
// summary.md (the tables), results.jsonl (one line per run) and logs/sidecar.log (diagnostics).
// Other flags are passed through: --out <dir>, --project <slug>, --cap <seconds>, --label <text>.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_LOCAL = "S1,S2,S3,S4,S5,S6";
const CLAUDE = "S7-chat,S7-think,S7-retry";
const FAULTS = "S8-kill-ollama,S8-tool-delay,S8-kill-claude-code,S8-silent-local,S8-stall-local,S8-silent-claude,S8-error-claude";

const args = process.argv.slice(2);
const pass = [];
let scenarios = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--local") scenarios = ALL_LOCAL;
  else if (args[i] === "--faults") scenarios = FAULTS;
  else if (args[i] === "--claude") scenarios = CLAUDE;
  else if (args[i] === "--scenarios") scenarios = args[++i];
  else pass.push(args[i]);
}
scenarios ??= `${ALL_LOCAL},${CLAUDE},${FAULTS}`;

console.log("[reliability] building the harness…");
const build = spawnSync("cargo", ["build", "--bin", "reliability"], { cwd: join(root, "src-tauri"), stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) process.exit(build.status ?? 1);
const exe = join(root, "src-tauri", "target", "debug", process.platform === "win32" ? "reliability.exe" : "reliability");
if (!existsSync(exe)) {
  console.error(`[reliability] ${exe} is missing`);
  process.exit(1);
}
console.log(`[reliability] scenarios: ${scenarios}`);
const run = spawnSync(exe, ["--scenarios", scenarios, ...pass], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
