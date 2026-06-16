import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { Config } from '../../core/config.js';
import { withRetry } from '../../core/retry.js';
import { resourceContextStorage } from '../../core/context.js';

export interface GCPConfig {
  projectId: string;
  serviceAccountPath: string;
  region?: string;
}

export function resolveGCPConfig(): GCPConfig {
  const isOffline = Config.isOfflineMode() || Config.isGlobalDryRun();

  // 1. Check Config.providers.gcp
  const gcpCfg = Config.get().providers.gcp;
  if (gcpCfg?.serviceAccountPath) {
    if (gcpCfg.projectId) {
      return {
        projectId: gcpCfg.projectId,
        serviceAccountPath: gcpCfg.serviceAccountPath,
        region: gcpCfg.region,
      };
    }
    try {
      const sa = JSON.parse(fs.readFileSync(gcpCfg.serviceAccountPath, 'utf8'));
      return {
        projectId: sa.project_id as string,
        serviceAccountPath: gcpCfg.serviceAccountPath,
        region: gcpCfg.region,
      };
    } catch (e) {
      // Continue to next fallback
    }
  }

  // 2. Fallback to Config.providers.firebase
  const fbCfg = Config.get().providers.firebase;
  if (fbCfg?.serviceAccountPath) {
    if (fbCfg.projectId) {
      return {
        projectId: fbCfg.projectId,
        serviceAccountPath: fbCfg.serviceAccountPath,
      };
    }
    try {
      const sa = JSON.parse(fs.readFileSync(fbCfg.serviceAccountPath, 'utf8'));
      return {
        projectId: sa.project_id as string,
        serviceAccountPath: fbCfg.serviceAccountPath,
      };
    } catch (e) {
      // Continue to next fallback
    }
  }

  // 3. Fallback to process.env.GCP_SA
  const gcpSa = process.env.GCP_SA;
  if (gcpSa && fs.existsSync(gcpSa)) {
    try {
      const sa = JSON.parse(fs.readFileSync(gcpSa, 'utf8'));
      return {
        projectId: sa.project_id as string,
        serviceAccountPath: gcpSa,
      };
    } catch (e) {
      // Continue to next fallback
    }
  }

  // 4. Fallback to process.env.FIREBASE_SA
  const fbSa = process.env.FIREBASE_SA;
  if (fbSa && fs.existsSync(fbSa)) {
    try {
      const sa = JSON.parse(fs.readFileSync(fbSa, 'utf8'));
      return {
        projectId: sa.project_id as string,
        serviceAccountPath: fbSa,
      };
    } catch (e) {
      // Continue to next fallback
    }
  }

  if (isOffline) {
    return {
      projectId: "mock-gcp-project",
      serviceAccountPath: "/mock/sa.json",
      region: gcpCfg?.region ?? "us-central1"
    };
  }

  throw new Error(
    'GCP credentials not configured. Please set GCP_SA or FIREBASE_SA env var, or configure providers.gcp or providers.firebase in Config.'
  );
}

export function getProjectId(): string {
  return resolveGCPConfig().projectId;
}

export function getRegion(): string {
  const gcpCfg = Config.get().providers.gcp;
  return gcpCfg?.region ?? 'us-central1';
}

export async function getGCPToken(scopes: string[]): Promise<string> {
  if (Config.isOfflineMode()) {
    return "mock-gcp-token";
  }
  if (Config.isGlobalDryRun()) {
    try {
      const cfg = resolveGCPConfig();
      if (cfg.projectId === "mock-gcp-project") {
        return "mock-gcp-token";
      }
    } catch {
      return "mock-gcp-token";
    }
  }
  const { serviceAccountPath } = resolveGCPConfig();
  const auth = new GoogleAuth({ keyFile: serviceAccountPath, scopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error('Failed to retrieve GCP access token');
  }
  return token.token;
}

function createGcpOfflineMock(base: string, path: string, opts: RequestInit): any {
  if (path.includes("/secrets/")) {
    return {
      payload: {
        data: Buffer.from("mock-gcp-secret-value").toString("base64")
      }
    };
  }
  if (path.includes("/instances")) {
    // Specific instance GET (discovery path: /instances/{name}) - return not-found so
    // builders plan creation rather than treating the mock VM as already existing
    const afterInstances = path.split("/instances")[1] ?? "";
    if (afterInstances.startsWith("/") && afterInstances.length > 1) {
      throw new Error(`GCP API GET ${path} → 404: Not Found`);
    }
    return {
      status: "RUNNING",
      id: "mock-gcp-instance-id",
      networkInterfaces: [
        {
          networkIP: "10.128.0.2",
          accessConfigs: [
            {
              natIP: "34.56.78.90"
            }
          ]
        }
      ]
    };
  }
  if (path.includes("/global/networks")) {
    return { status: "READY", name: "mock-network" };
  }
  if (path.includes("/subnetworks")) {
    return { status: "READY", name: "mock-subnetwork" };
  }
  // Generic fallback proxy
  return new Proxy({}, {
    get(target, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "id") return "mock-gcp-id-12345";
      if (prop === "name") return "mock-gcp-name";
      if (prop === "status" || prop === "status") return "RUNNING";
      if (prop.endsWith("s")) return [];
      return `mock-gcp-${prop.toLowerCase()}`;
    }
  });
}

const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export async function gcpFetch(base: string, path: string, opts: RequestInit = {}): Promise<any> {
  const context = resourceContextStorage.getStore();
  const abortSignal = context?.abortSignal;

  const method = opts.method ?? "GET";
  const isWrite = method !== "GET";
  let isMockClient = false;
  try {
    const cfg = resolveGCPConfig();
    if (cfg.projectId === "mock-gcp-project") isMockClient = true;
  } catch {
    isMockClient = true;
  }

  if (Config.isOfflineMode() || (Config.isGlobalDryRun() && (isWrite || isMockClient))) {
    return Promise.resolve(createGcpOfflineMock(base, path, opts));
  }

  const fetchOpts = abortSignal ? { ...opts, signal: abortSignal } : opts;

  return withRetry(async () => {
    const token = await getGCPToken([CLOUD_SCOPE]);
    const res = await fetch(`${base}${path}`, {
      ...fetchOpts,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(fetchOpts.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GCP API ${fetchOpts.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }, {
    retryable: (err) => {
      const match = err.message.match(/→ (\d+):/);
      const status = match ? parseInt(match[1], 10) : null;
      return status === 429 || (status && status >= 500) || err.message.includes("ETIMEDOUT");
    }
  });
}
