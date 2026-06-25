import fs from "node:fs";
import path from "node:path";

/**
 * Strips comments from a YAML/JSON line while preserving comment hashes inside quotes.
 */
function stripComments(line: string): string {
  const hashIdx = line.indexOf("#");
  if (hashIdx < 0) return line;

  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < hashIdx; i++) {
    const char = line[i];
    if (char === '"' || char === "'") {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
      }
    }
  }

  if (inQuotes) {
    return line;
  }
  return line.slice(0, hashIdx);
}

/**
 * Robust, zero-dependency, indentation-aware YAML parser.
 * Parses sequences of key-value maps and nested string arrays.
 */
export function parseYaml(content: string): any[] {
  const list: any[] = [];
  const lines = content.split(/\r?\n/);
  let currentItem: any = null;
  let activeKey: string | null = null;
  let rootIndent = 0;

  for (let line of lines) {
    line = stripComments(line);
    if (!line.trim()) continue;

    const leadingSpaces = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Check if it's a bullet item list entry
    if (trimmed.startsWith("-")) {
      const rest = trimmed.slice(1).trim();

      // If it is indented more than the root item and does not match a key-value pattern,
      // treat it as an array item under the active key.
      const isRestKeyValue = /^[a-zA-Z0-9_-]+\s*:/.test(rest);
      if (leadingSpaces > rootIndent && !isRestKeyValue) {
        if (currentItem && activeKey) {
          if (!Array.isArray(currentItem[activeKey])) {
            currentItem[activeKey] = [];
          }
          let val = rest;
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          currentItem[activeKey].push(val);
        }
        continue;
      }

      // Otherwise, it represents a new item at the root list level
      if (currentItem) {
        list.push(currentItem);
      }
      currentItem = {};
      rootIndent = leadingSpaces;
      activeKey = null;

      if (rest) {
        const colonIdx = rest.indexOf(":");
        if (colonIdx > 0 && isRestKeyValue) {
          const key = rest.slice(0, colonIdx).trim();
          let value = rest.slice(colonIdx + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          // Convert to number if numeric
          if (/^\d+$/.test(value)) {
            currentItem[key] = parseInt(value, 10);
          } else {
            currentItem[key] = value;
          }
          activeKey = key;
        }
      }
    } else {
      // Key-value pair or list start
      const isKeyValue = /^[a-zA-Z0-9_-]+\s*:/.test(trimmed);
      if (isKeyValue && currentItem) {
        const colonIdx = trimmed.indexOf(":");
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();

        if (value === "") {
          // Starts a nested list/array
          currentItem[key] = [];
          activeKey = key;
        } else {
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (/^\d+$/.test(value)) {
            currentItem[key] = parseInt(value, 10);
          } else {
            currentItem[key] = value;
          }
          activeKey = key;
        }
      }
    }
  }

  if (currentItem) {
    list.push(currentItem);
  }
  return list;
}

/**
 * Resolves a file path relative to the current working directory,
 * reads its content, and parses it according to its extension (.json vs .yaml/.yml).
 */
export function loadRecordsFromFile(filePath: string): any[] {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const fileContent = fs.readFileSync(absolutePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    const parsed = JSON.parse(fileContent);
    return Array.isArray(parsed) ? parsed : [parsed];
  } else if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(fileContent);
  } else {
    throw new Error(
      `Unsupported configuration file format: ${filePath}. Only JSON and YAML/YML files are supported.`
    );
  }
}
