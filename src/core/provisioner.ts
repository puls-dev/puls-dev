import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";

export function checkPort(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });
}

function resolveSshKeyPath(sshKeys?: string | string[]): string {
  const keyInput = Array.isArray(sshKeys) ? null : sshKeys;
  return (
    keyInput &&
    !keyInput.startsWith("ssh-") &&
    !keyInput.startsWith("ecdsa-") &&
    !keyInput.startsWith("sk-")
      ? keyInput.replace(/\.pub$/, "")
      : `${homedir()}/.ssh/id_ed25519`
  ).replace(/^~/, homedir());
}

export function runAnsible(
  ip: string,
  user: string,
  sshKeys: string | string[] | undefined,
  playbook: string
): Promise<void> {
  console.log(`   🔧 Running Ansible: ${playbook} → ${ip}`);
  const keyPath = resolveSshKeyPath(sshKeys);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ansible-playbook",
      [
        playbook,
        "-i",
        `${ip},`,
        "-u",
        user,
        "--private-key",
        keyPath,
        "--ssh-extra-args",
        "-o StrictHostKeyChecking=no -o ConnectTimeout=30",
      ],
      { stdio: "inherit" },
    );
    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`   ✅ Provisioning complete`);
        resolve();
      } else reject(new Error(`ansible-playbook exited with code ${code}`));
    });

    proc.on("error", (err) =>
      reject(new Error(`Failed to run ansible-playbook: ${err.message}`)),
    );
  });
}

export function runPuppet(
  ip: string,
  user: string,
  sshKeys: string | string[] | undefined,
  manifest: string
): Promise<void> {
  console.log(`   🔧 Applying Puppet manifest: ${manifest} → ${ip}`);
  const keyPath = resolveSshKeyPath(sshKeys);
  // Copy manifest then apply it
  return new Promise((resolve, reject) => {
    const scp = spawn(
      "scp",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=no",
        manifest,
        `${user}@${ip}:/tmp/manifest.pp`,
      ],
      { stdio: "inherit" },
    );

    scp.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`scp exited with code ${code}`));
        return;
      }
      const puppet = spawn(
        "ssh",
        [
          "-i",
          keyPath,
          "-o",
          "StrictHostKeyChecking=no",
          `${user}@${ip}`,
          "puppet apply /tmp/manifest.pp",
        ],
        { stdio: "inherit" },
      );
      puppet.on("close", (c) => {
        if (c === 0) {
          console.log(`   ✅ Provisioning complete`);
          resolve();
        } else reject(new Error(`puppet apply exited with code ${c}`));
      });
      puppet.on("error", (err) =>
        reject(new Error(`Failed to run puppet: ${err.message}`)),
      );
    });
    scp.on("error", (err) =>
      reject(new Error(`Failed to run scp: ${err.message}`)),
    );
  });
}

export function runProvisioner(
  ip: string,
  user: string,
  sshKeys: string | string[] | undefined,
  scriptPath: string
): Promise<void> {
  const ext = scriptPath.split(".").pop()?.toLowerCase();

  if (ext === "sh") {
    throw new Error(
      `Shell script provisioning (.sh) is no longer supported. ` +
        `Please migrate "${scriptPath}" to an Ansible playbook (.yaml/.yml).`,
    );
  }
  if (ext === "pp") return runPuppet(ip, user, sshKeys, scriptPath);
  return runAnsible(ip, user, sshKeys, scriptPath); // .yml / .yaml
}
