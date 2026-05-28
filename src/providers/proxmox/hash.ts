import fs from "node:fs";
import crypto from "node:crypto";

export function getFileHash(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      // Stable hash fallback for virtual playbooks or missing dry-run files
      return crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12);
    }
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

export function parseProvisionMetadata(description: string): Record<string, string> {
  if (!description) return {};
  const match = description.match(/\[puls-provision:\s*([^\]]+)\]/);
  if (!match) return {};
  const record: Record<string, string> = {};
  const entries = match[1].split(",");
  for (const entry of entries) {
    const parts = entry.trim().split("=");
    if (parts.length === 2) {
      const [name, hash] = parts;
      if (name && hash) {
        record[name.trim()] = hash.trim();
      }
    }
  }
  return record;
}

export function mergeProvisionMetadata(description: string, metadata: Record<string, string>): string {
  const metaString = Object.entries(metadata)
    .map(([name, hash]) => `${name}=${hash}`)
    .join(",");
  const block = `[puls-provision: ${metaString}]`;

  const regex = /\[puls-provision:\s*[^\]]+\]/;
  if (regex.test(description)) {
    return description.replace(regex, block);
  }

  const trimmed = description.trim();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}
