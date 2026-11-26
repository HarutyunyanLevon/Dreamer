// Renders the app icon sources to PNG, then regenerates every bundle size with `tauri icon`.
//   src-tauri/icons/source.svg -> icon-source.png (1024) -> tauri icon
import { Resvg } from "@resvg/resvg-js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const render = (svg, size, out) => {
  const png = new Resvg(readFileSync(join(icons, svg)), { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(join(icons, out), png);
};
render("source.svg", 1024, "icon-source.png");
execSync(`npx tauri icon "${join(icons, "icon-source.png")}"`, { stdio: "inherit", cwd: join(icons, "..", "..") });
