import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { installShell, uninstallShell } from "./install-shell.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function findTsx(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getVersion(): string {
  try {
    const pkg = require(path.join(__dirname, "../../package.json")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

const HELP = `
Usage:
  puls plan             <file>   Dry-run the stack - prints what would change, no API writes
  puls deploy           <file>   Deploy the stack
  puls destroy          <file>   Destroy the stack
  puls diff             <file>   Compare declared intent against live cloud state
  puls install-shell             Add puls to your shell so you never need npx again
  puls uninstall-shell           Remove the puls shell integration

Options:
  --parallel       Enable parallel resource execution
  --dry-run        Force dry-run mode (alias: same as plan)
  --fail-on-drift  Exit with code 1 if drift is detected (diff command only)
  --version        Print version and exit
  --help           Print this help and exit

Examples:
  npx @puls-dev/core install-shell         # one-time setup- then just use "puls" directly
  puls plan    infra/staging.ts
  puls deploy  infra/staging.ts --parallel
  puls destroy infra/staging.ts
  puls diff    infra/staging.ts --fail-on-drift
`.trim();

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      parallel: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "fail-on-drift": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  console.error('Run "puls --help" for usage.');
  process.exit(1);
}

const { values, positionals } = parsed;

if (values.version) {
  console.log(`puls v${getVersion()}`);
  process.exit(0);
}

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const [command, userFile] = positionals;

const COMMANDS = [
  "plan",
  "deploy",
  "destroy",
  "diff",
  "install-shell",
  "uninstall-shell",
] as const;
type Command = (typeof COMMANDS)[number];

if (!COMMANDS.includes(command as Command)) {
  console.error(
    `Error: Unknown command "${command}". Run "puls --help" for usage.`,
  );
  process.exit(1);
}

// Shell management commands run directly- no stack file needed
if (command === "install-shell") {
  installShell();
  process.exit(0);
}
if (command === "uninstall-shell") {
  uninstallShell();
  process.exit(0);
}

if (!userFile) {
  console.error(`Error: Missing file argument.\nUsage: puls ${command} <file>`);
  process.exit(1);
}

const resolvedFile = path.resolve(process.cwd(), userFile);
if (!existsSync(resolvedFile)) {
  console.error(`Error: File not found: ${resolvedFile}`);
  process.exit(1);
}

const childEnv: NodeJS.ProcessEnv = { ...process.env };

if (command === "plan" || values["dry-run"]) {
  childEnv.PULS_DRY_RUN = "true";
}

if (command === "destroy") {
  childEnv.PULS_MODE = "destroy";
}

if (command === "diff") {
  childEnv.PULS_MODE = "diff";
}

if (values.parallel) {
  childEnv.PULS_PARALLEL = "true";
}

if (values["fail-on-drift"]) {
  childEnv.PULS_FAIL_ON_DRIFT = "true";
}

const tsxBin = findTsx() ?? "tsx";

const child = spawn(tsxBin, [resolvedFile], {
  stdio: "inherit",
  env: childEnv,
});

child.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") {
    console.error(
      "Error: Could not find tsx. Install it in your project:\n\n" +
        "  npm install --save-dev tsx\n\n" +
        "or globally:\n\n" +
        "  npm install -g tsx",
    );
  } else {
    console.error(`Error spawning tsx: ${err.message}`);
  }
  process.exit(1);
});

child.on("close", (code: number | null) => {
  process.exit(code ?? 1);
});
