import { BUILTIN_THEMES } from "../src/theme/presets";
import { checkTheme } from "../src/theme/contrast";

let failed = 0;
for (const t of BUILTIN_THEMES) {
  console.log(`\n${t.name}`);
  for (const c of checkTheme(t)) {
    if (!c.pass) failed++;
    console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.label.padEnd(28)} ${c.ratio.toFixed(2)} (min ${c.min})`);
  }
}
if (failed) {
  console.log(`\n${failed} check(s) below target`);
  process.exit(1);
}
console.log("\nAll built-in themes meet the contrast targets.");
