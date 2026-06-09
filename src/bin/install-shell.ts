import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "# added by puls-dev";
const LAUNCHER_CONTENT = `#!/bin/sh
exec npx --yes puls-dev "$@"
`;

function detectShellConfig(): { shell: string; configFile: string } | null {
  const shellBin = process.env.SHELL ?? "";

  if (shellBin.endsWith("zsh")) {
    return { shell: "zsh", configFile: path.join(os.homedir(), ".zshrc") };
  }
  if (shellBin.endsWith("bash")) {
    // macOS uses ~/.bash_profile for login shells; Linux uses ~/.bashrc
    const isMac = process.platform === "darwin";
    const configFile = isMac
      ? path.join(os.homedir(), ".bash_profile")
      : path.join(os.homedir(), ".bashrc");
    return { shell: "bash", configFile };
  }
  if (shellBin.endsWith("fish")) {
    return {
      shell: "fish",
      configFile: path.join(os.homedir(), ".config", "fish", "config.fish"),
    };
  }
  return null;
}

function buildPathLine(shell: string): string {
  if (shell === "fish") {
    return `fish_add_path "$HOME/.puls/bin"`;
  }
  return `export PATH="$HOME/.puls/bin:$PATH"`;
}

export function installShell(): void {
  const home = os.homedir();
  const launcherDir = path.join(home, ".puls", "bin");
  const launcherPath = path.join(launcherDir, "puls");

  // 1. Create launcher
  const launcherExists = fs.existsSync(launcherPath);
  if (!launcherExists) {
    fs.mkdirSync(launcherDir, { recursive: true });
    fs.writeFileSync(launcherPath, LAUNCHER_CONTENT, { encoding: "utf8" });
    fs.chmodSync(launcherPath, 0o755);
    console.log(`✅ Created launcher at ${launcherPath}`);
  } else {
    console.log(`   Launcher already exists at ${launcherPath}`);
  }

  // 2. Detect shell config
  const detected = detectShellConfig();
  if (!detected) {
    console.log(
      `\n⚠️  Could not detect your shell from $SHELL="${process.env.SHELL ?? ""}".`,
    );
    console.log(`   Add this line manually to your shell config:\n`);
    console.log(`     export PATH="$HOME/.puls/bin:$PATH"\n`);
    return;
  }

  const { shell, configFile } = detected;
  const pathLine = buildPathLine(shell);

  // 3. Ensure config file exists
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "", "utf8");
  }

  // 4. Check if already present (idempotent)
  const existing = fs.readFileSync(configFile, "utf8");
  if (existing.includes(MARKER)) {
    console.log(`   Shell config already updated (${configFile})`);
    console.log(`\n✅ puls is already set up. Open a new terminal or run:\n`);
    console.log(`   source ${configFile}\n`);
    return;
  }

  // 5. Append PATH entry with marker
  const addition = `\n${MARKER}\n${pathLine}\n`;
  fs.appendFileSync(configFile, addition, "utf8");
  console.log(`✅ Added puls to PATH in ${configFile}`);
  console.log(`\n🎉 All done! Activate now by running:\n`);
  console.log(`   source ${configFile}`);
  console.log(`\nThen use puls directly:\n`);
  console.log(`   puls plan   infra/stack.ts`);
  console.log(`   puls deploy infra/stack.ts`);
  console.log(`   puls diff   infra/stack.ts\n`);
}

export function uninstallShell(): void {
  const home = os.homedir();
  const launcherPath = path.join(home, ".puls", "bin", "puls");
  const launcherDir = path.join(home, ".puls", "bin");

  // 1. Remove launcher
  if (fs.existsSync(launcherPath)) {
    fs.rmSync(launcherPath);
    console.log(`✅ Removed launcher at ${launcherPath}`);
    // Clean up empty dirs
    try {
      fs.rmdirSync(launcherDir);
      fs.rmdirSync(path.join(home, ".puls"));
    } catch {
      // Non-empty dirs left behind (user may have other files)- that's fine
    }
  } else {
    console.log(`   Launcher not found at ${launcherPath}- nothing to remove.`);
  }

  // 2. Remove PATH line from shell config
  const detected = detectShellConfig();
  if (!detected) {
    console.log(
      `\n⚠️  Could not detect shell config. Remove the puls PATH line manually.`,
    );
    return;
  }

  const { configFile } = detected;
  if (!fs.existsSync(configFile)) {
    console.log(
      `   Shell config not found at ${configFile}- nothing to clean up.`,
    );
    return;
  }

  const content = fs.readFileSync(configFile, "utf8");
  if (!content.includes(MARKER)) {
    console.log(
      `   Shell config at ${configFile} has no puls entry- nothing to remove.`,
    );
    return;
  }

  // Remove the marker line and the PATH line that follows it
  const cleaned = content
    .split("\n")
    .reduce<{ out: string[]; skip: boolean }>(
      (acc, line) => {
        if (line.trim() === MARKER) return { out: acc.out, skip: true };
        if (acc.skip) return { out: acc.out, skip: false }; // skip the PATH line
        return { out: [...acc.out, line], skip: false };
      },
      { out: [], skip: false },
    )
    .out.join("\n")
    .replace(/\n{3,}/g, "\n\n"); // collapse triple+ blank lines

  fs.writeFileSync(configFile, cleaned, "utf8");
  console.log(`✅ Removed puls PATH entry from ${configFile}`);
  console.log(`\n   Restart your terminal for changes to take effect.\n`);
}
