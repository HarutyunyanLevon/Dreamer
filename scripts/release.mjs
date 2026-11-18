// npm run release: builds the sidecar + frontend (tauri's beforeBuildCommand) and the NSIS
// installer, then prints where it is.
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// beforeBuildCommand runs `npm run build:sidecar && npm run build`.
execSync("npx tauri build", { cwd: root, stdio: "inherit" });

// Smoke test: start the packaged sidecar the way the installed app does. Tauri hands the app a
// Windows verbatim path (\\?\C:\...) and src-tauri's child_path() (dunce::simplified) strips the
// prefix before it reaches node; node itself fails on the verbatim form. Mirror that here.
function simplified(p) {
  const m = /^\\\\\?\\([A-Za-z]:\\.*)$/.exec(p); // \\?\X:\...  (UNC verbatim is left alone, like dunce)
  return m ? m[1] : p;
}
async function smokeTestSidecar() {
  const dir = join(root, "src-tauri", "target", "release", "sidecar");
  const script = join(dir, "claude-sidecar.mjs");
  if (!existsSync(script)) throw new Error(`packaged sidecar not found at ${script}`);
  const verbatim = process.platform === "win32" ? "\\\\?\\" + resolve(script) : resolve(script);
  const child = spawn(process.execPath, [simplified(verbatim)], { cwd: simplified(resolve(dir)), stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stderr.on("data", (d) => (err += d));
  const ready = await new Promise((done) => {
    const t = setTimeout(() => done(false), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.split("\n").some((l) => { try { return JSON.parse(l).type === "ready"; } catch { return false; } })) { clearTimeout(t); done(true); }
    });
    child.on("exit", () => { clearTimeout(t); done(false); });
  });
  child.stdin.end();
  setTimeout(() => child.kill(), 2000).unref();
  if (!ready) throw new Error(`sidecar did not report ready within 10s.
stdout: ${out}
stderr: ${err}`);
  console.log("sidecar smoke test: ready");
}
try {
  await smokeTestSidecar();
} catch (e) {
  console.error(`
Sidecar smoke test FAILED: ${e.message}`);
  process.exit(1);
}

const exe = join(root, "src-tauri", "target", "release", "bundle", "nsis", `Dreamer_${version}_x64-setup.exe`);
if (!existsSync(exe)) {
  console.error(`\nInstaller not found at ${exe}`);
  process.exit(1);
}
console.log(`\nInstaller: ${exe}`);
