// Builds src-tauri/sidecar-dist/: the Claude sidecar script plus a production-only node_modules,
// shipped by the installer as the "sidecar" resource. The installed app never touches the repo.
// Optional deps are omitted: they are the SDK's per-platform bundled claude.exe (~350 MB); the
// app uses the user's installed Claude Code instead (DREAMER_CLAUDE_EXE, see sidecar.rs).
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "sidecar-dist");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const DEPS = ["@anthropic-ai/claude-agent-sdk", "zod"];

// Pin to exactly what the repo has locked, so dev and release run the same SDK.
const dependencies = Object.fromEntries(
  DEPS.map((d) => [d, lock.packages?.[`node_modules/${d}`]?.version ?? rootPkg.dependencies[d]]),
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "sidecar"), out, { recursive: true, filter: (p) => !/package.json$|node_modules/.test(p) });
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "dreamer-sidecar", private: true, type: "module", version: rootPkg.version, dependencies }, null, 2) + "\n",
);
// Under `npm run`, the parent's npm_config_* (e.g. allow-scripts) leak in and a nested project
// install rejects some of them; start clean. No install scripts are needed (or allowed) here.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
execSync("npm install --omit=dev --omit=optional --omit=peer --ignore-scripts --no-audit --no-fund --no-package-lock", { cwd: out, stdio: "inherit", env });
await checkStarts(out);
console.log(`sidecar built: ${out} (${Object.entries(dependencies).map(([k, v]) => `${k}@${v}`).join(", ")})`);

/**
 * The packaged sidecar must start on its own: run it from its folder with the repo's node_modules
 * out of reach (cwd = the dist folder; ESM resolves from the script's location), expect
 * {type:"ready"} on stdout, then close stdin and expect a clean exit. A module missing from the
 * package fails the import before "ready" and fails the release here instead of on a user's machine.
 */
function checkStarts(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["main.mjs"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let ready = false;
    const fail = (why) => {
      child.kill();
      reject(new Error(`packaged sidecar check failed: ${why}\n--- stderr ---\n${err.trim()}`));
    };
    const timer = setTimeout(() => fail("no {type:\"ready\"} within 20 s"), 20000);
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      out += d;
      const isReady = (l) => {
        try {
          return JSON.parse(l).type === "ready";
        } catch {
          return false;
        }
      };
      if (!ready && out.split("\n").some(isReady)) {
        ready = true;
        child.stdin.end();
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!ready) return fail(`exited with code ${code} before "ready"`);
      if (code !== 0) return fail(`exited with code ${code} after stdin closed`);
      console.log("packaged sidecar check: ready, clean exit");
      resolve();
    });
  });
}
