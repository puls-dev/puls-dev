import path from "node:path";
import fs from "node:fs";

export const SESSION_FILE = path.join(process.cwd(), ".puls", "import-session.json");

export function ensurePulsDir(): void {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
