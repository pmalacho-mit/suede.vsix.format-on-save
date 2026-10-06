// Package and install into whichever editor's command line is on the path.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vsix = path.join(here, "format-on-save.vsix");

execFileSync(
  "npx",
  [
    "--yes",
    "@vscode/vsce",
    "package",
    "--no-dependencies",
    "--skip-license",
    "--allow-missing-repository",
    "-o",
    vsix,
  ],
  { stdio: "inherit", cwd: here },
);

const cli = ["codium", "code", "code-insiders", "cursor"].find(
  (candidate) =>
    spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0,
);
if (!cli) {
  console.log(
    `packaged → ${vsix}\ninstall it with: Command Palette → "Extensions: Install from VSIX..."`,
  );
  process.exit(0);
}
execFileSync(cli, ["--install-extension", vsix, "--force"], {
  stdio: "inherit",
});
console.log(`installed into ${cli}`);
