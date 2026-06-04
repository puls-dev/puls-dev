import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
    const pkg = require(path.join(__dirname, "../../package.json")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

const HELP = `
Usage:
  puls plan    <file>   Dry-run the stack — prints what would change, no API writes
  puls deploy  <file>   Deploy the stack
  puls destroy <file>   Destroy the stack

Options:
  --parallel   Enable parallel resource execution
  --dry-run    Force dry-run mode (alias: same as plan)
  --version    Print version and exit
  --help       Print this help and exit

Examples:
  puls plan    infra/staging.ts
  puls deploy  infra/staging.ts --parallel
  puls destroy infra/staging.ts
`.trim();

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      parallel:  { type: "boolean" },
      "dry-run": { type: "boolean" },
      version:   { type: "boolean", short: "v" },
      help:      { type: "boolean", short: "h" },
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

const COMMANDS = ["plan", "deploy", "destroy"] as const;
type Command = (typeof COMMANDS)[number];

if (!COMMANDS.includes(command as Command)) {
  console.error(`Error: Unknown command "${command}". Expected: plan, deploy, or destroy.`);
  console.error('Run "puls --help" for usage.');
  process.exit(1);
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

if (values.parallel) {
  childEnv.PULS_PARALLEL = "true";
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
      "  npm install -g tsx"
    );
  } else {
    console.error(`Error spawning tsx: ${err.message}`);
  }
  process.exit(1);
});

child.on("close", (code: number | null) => {
  process.exit(code ?? 1);
});
