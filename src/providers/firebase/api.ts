import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { Config } from '../../core/config.js';
import { withRetry } from '../../core/retry.js';
import { resourceContextStorage } from '../../core/context.js';

function resolveFirebaseConfig() {
  const isOffline = Config.isOfflineMode() || Config.isGlobalDryRun();
  const cfg = Config.get().providers.firebase;
  if (cfg?.serviceAccountPath) return cfg;

  // Fallback: auto-configure from FIREBASE_SA env var so the decorator option is optional
  const saPath = process.env.FIREBASE_SA;
  if (saPath) {
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    return { projectId: sa.project_id as string, serviceAccountPath: saPath };
  }

  if (isOffline) {
    return { projectId: "mock-firebase-project", serviceAccountPath: "/mock/sa.json" };
  }

  throw new Error('Firebase not configured. Set FIREBASE_SA=/path/to/sa.json or use @Deploy({ firebase: "..." })');
}

export function getProjectId(): string {
  return resolveFirebaseConfig().projectId;
}

export async function getFirebaseToken(scopes: string[]): Promise<string> {
  if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
    return "mock-firebase-token";
  }
  const { serviceAccountPath } = resolveFirebaseConfig();
  const auth = new GoogleAuth({ keyFile: serviceAccountPath, scopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token!;
}

const HOSTING_SCOPE = 'https://www.googleapis.com/auth/firebase.hosting';
const CLOUD_SCOPE   = 'https://www.googleapis.com/auth/cloud-platform';

function createFirebaseOfflineMock(path: string, opts: RequestInit): any {
  if (path.includes("/versions")) {
    return { name: `${path}/versions/mock-version-id`, status: "FINALIZED" };
  }
  if (path.includes("/releases")) {
    return { name: `${path}/releases/mock-release-id` };
  }
  if (path.includes("/sites/")) {
    return { name: "mock-site-name", defaultUrl: "https://mock-project.web.app" };
  }
  return new Proxy({}, {
    get(target, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "name") return "mock-firebase-name";
      if (prop === "status") return "FINALIZED";
      if (prop === "id") return "mock-firebase-id";
      if (prop.endsWith("s")) return [];
      return `mock-fb-${prop.toLowerCase()}`;
    }
  });
}

export async function hostingFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const context = resourceContextStorage.getStore();
  const abortSignal = context?.abortSignal;

  if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
    return Promise.resolve(createFirebaseOfflineMock(path, opts));
  }

  const fetchOpts = abortSignal ? { ...opts, signal: abortSignal } : opts;

  return withRetry(async () => {
    const token = await getFirebaseToken([HOSTING_SCOPE]);
    const base = 'https://firebasehosting.googleapis.com/v1beta1';
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
      throw new Error(`Firebase Hosting API ${fetchOpts.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
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

export async function cloudFetch(base: string, path: string, opts: RequestInit = {}): Promise<any> {
  const context = resourceContextStorage.getStore();
  const abortSignal = context?.abortSignal;

  if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
    return Promise.resolve(createFirebaseOfflineMock(path, opts));
  }

  const fetchOpts = abortSignal ? { ...opts, signal: abortSignal } : opts;

  return withRetry(async () => {
    const token = await getFirebaseToken([CLOUD_SCOPE]);
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
