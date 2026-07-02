import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { DiscoveredResource } from "../../core/provider.js";
import { HTML_CONTENT } from "./html.js";
import { SESSION_FILE, ensurePulsDir } from "./session.js";
import { generateInfrastructureCode } from "./codegen.js";

const _require = createRequire(import.meta.url);

// ─── Shared scan state ────────────────────────────────────────────────────────
// All fields are mutated by the scan loop in importer-wizard.ts while the
// server reads them from request handlers. Passing by-object-reference means
// the server always sees the latest values without additional messaging.

export interface ScanState {
  sseClients:   Set<http.ServerResponse>;
  sseEvents:    Array<{ event: string; data: any }>;
  rawResources: DiscoveredResource[];
  scanComplete: boolean;
  sessionData:  any;
  token:        string;
  port:         number;
}

export function sendAll(state: ScanState, event: string, data: any): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  state.sseEvents.push({ event, data });
  for (const client of state.sseClients) {
    try { client.write(msg); } catch { state.sseClients.delete(client); }
  }
}

// ─── Dependency expansion ─────────────────────────────────────────────────────

function isConnected(res: DiscoveredResource, other: DiscoveredResource): boolean {
  const otherId = String(other.id);
  if (String(res.original?.vpc_uuid) === otherId) return true;
  if (String(res.original?.vpcId)    === otherId) return true;
  if (String(res.original?.subnetId) === otherId) return true;
  if (res.type === "AWS.CloudFront") {
    const aliases: string[] = res.original?.aliases || [];
    const origins: any[]    = res.original?.origins  || [];
    const zoneName = other.name.replace(/\.$/, "");
    if (other.type === "AWS.Route53" && aliases.some(a => a.endsWith(zoneName))) return true;
    if (other.type === "AWS.S3"      && origins.some((o: any) => o.domainName && o.domainName.includes(other.name))) return true;
  }
  if (res.type === "DO.Firewall" && other.type === "DO.Droplet") {
    if ((res.original?.dropletIds || []).some((d: any) => String(d) === otherId)) return true;
  }
  return false;
}

function expandWithConnections(chosen: DiscoveredResource[], allResources: DiscoveredResource[]): DiscoveredResource[] {
  const ids = new Set(chosen.map(r => String(r.id)));
  for (const res of chosen) {
    for (const other of allResources) {
      if (!ids.has(String(other.id)) && (isConnected(res, other) || isConnected(other, res))) {
        ids.add(String(other.id));
      }
    }
  }
  return allResources.filter(r => ids.has(String(r.id)));
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createImporterServer(state: ScanState): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", `http://localhost:${state.port}`);

    // ── Vendor assets (no token required) ──────────────────────────────────
    if (req.method === "GET" && url.pathname === "/vendor/vis-network.js") {
      try {
        const pkgRoot = path.dirname(_require.resolve("vis-network/package.json"));
        const content = fs.readFileSync(path.join(pkgRoot, "standalone/umd/vis-network.min.js"));
        res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=86400" });
        res.end(content);
      } catch {
        res.writeHead(404); res.end("// vis-network not found");
      }
      return;
    }

    // ── Token guard ─────────────────────────────────────────────────────────
    if (url.searchParams.get("token") !== state.token) {
      res.writeHead(403); res.end("Forbidden"); return;
    }

    // ── Routes ──────────────────────────────────────────────────────────────

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML_CONTENT);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.sessionData));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          state.sessionData = JSON.parse(body);
          ensurePulsDir();
          fs.writeFileSync(SESSION_FILE, JSON.stringify(state.sessionData, null, 2));
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      });
      // Replay buffer lets a late-connecting or refreshing browser catch up.
      for (const { event, data } of state.sseEvents) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      if (state.scanComplete) {
        res.write("event: done\ndata: {}\n\n");
        // Do NOT call res.end() here — that causes EventSource to auto-reconnect,
        // replaying all events as duplicates on every retry.
        req.on("close", () => {});
        return;
      }
      state.sseClients.add(res);
      req.on("close", () => state.sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const { selectedIds, renames, strategy } = JSON.parse(body);
          const directly = state.rawResources.filter((r) =>
            (selectedIds as string[]).includes(String(r.id)),
          );
          const chosen = expandWithConnections(directly, state.rawResources);
          const added = chosen.length - directly.length;
          if (added > 0) {
            console.log(`\n  ↳  Auto-included ${added} connected resource(s) required for code generation.`);
          }
          for (const r of chosen) {
            const renamed = renames?.[r.id] ?? renames?.[String(r.id)];
            if (renamed) r.propertyName = renamed;
          }
          const count = generateInfrastructureCode(chosen, strategy ?? "By Tier");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ count }));
          // Give the browser time to receive the response before the server closes.
          setTimeout(() => server.close(), 1200);
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(err.message);
        }
      });
      return;
    }

    res.writeHead(404); res.end("Not found");
  });

  return server;
}
