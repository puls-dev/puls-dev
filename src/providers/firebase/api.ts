import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { Config } from '../../core/config.js';
import { withRetry } from '../../core/retry.js';
import { resourceContextStorage } from '../../core/context.js';

function resolveFirebaseConfig() {
  const isOffline = Config.isOfflineMode() || Config.isGlobalDryRun();
  const hasEmulator = !!(process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST);
  const cfg = Config.get().providers.firebase;
  if (cfg?.serviceAccountPath) return cfg;
  if (cfg?.projectId) {
    return { projectId: cfg.projectId, serviceAccountPath: "/mock/sa.json" };
  }

  // Fallback: auto-configure from FIREBASE_SA env var so the decorator option is optional
  const saPath = process.env.FIREBASE_SA;
  if (saPath && fs.existsSync(saPath)) {
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    return { projectId: sa.project_id as string, serviceAccountPath: saPath };
  }

  if (isOffline || hasEmulator) {
    return { projectId: "mock-firebase-project", serviceAccountPath: "/mock/sa.json" };
  }

  throw new Error('Firebase not configured. Set FIREBASE_SA=/path/to/sa.json or use @Deploy({ firebase: "..." })');
}

export function getProjectId(): string {
  return resolveFirebaseConfig().projectId;
}

export async function getFirebaseToken(scopes: string[]): Promise<string> {
  const hasEmulator = !!(process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST);
  if (Config.isOfflineMode() || hasEmulator) {
    return "mock-firebase-token";
  }
  if (Config.isGlobalDryRun()) {
    try {
      const cfg = resolveFirebaseConfig();
      if (cfg.projectId === "mock-firebase-project") {
        return "mock-firebase-token";
      }
    } catch {
      return "mock-firebase-token";
    }
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

  const method = opts.method ?? "GET";
  const isWrite = method !== "GET";
  let isMockClient = false;
  try {
    const cfg = resolveFirebaseConfig();
    if (cfg.projectId === "mock-firebase-project") isMockClient = true;
  } catch {
    isMockClient = true;
  }

  if (Config.isOfflineMode() || (Config.isGlobalDryRun() && (isWrite || isMockClient))) {
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

  const method = opts.method ?? "GET";
  const isWrite = method !== "GET";
  let isMockClient = false;
  try {
    const cfg = resolveFirebaseConfig();
    if (cfg.projectId === "mock-firebase-project") isMockClient = true;
  } catch {
    isMockClient = true;
  }

  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;

  // Intercept and handle Firestore indexes (not supported/required by emulator)
  if (firestoreEmulator && base === 'https://firestore.googleapis.com/v1') {
    if (path.includes('/collectionGroups/') && path.includes('/indexes')) {
      if (method === 'GET') {
        return { indexes: [] };
      }
      if (method === 'POST') {
        return { name: 'mock-index' };
      }
    }
  }

  // Intercept and handle Firestore security rules for the emulator
  if (firestoreEmulator && base === 'https://firebaserules.googleapis.com/v1') {
    const projectId = getProjectId();
    if (method === 'POST' && path.endsWith('/rulesets')) {
      let parsedBody;
      try {
        parsedBody = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
      } catch {}
      const rulesContent = parsedBody?.source?.files?.[0]?.content;
      if (rulesContent) {
        const emulatorRulesUrl = `http://${firestoreEmulator}/emulator/v1/projects/${projectId}:securityRules`;
        const putRes = await fetch(emulatorRulesUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rules: {
              files: [
                {
                  name: 'firestore.rules',
                  content: rulesContent,
                },
              ],
            },
          }),
        });
        if (!putRes.ok) {
          const bodyText = await putRes.text();
          throw new Error(`Firestore Emulator Rules PUT failed: ${putRes.status} ${bodyText}`);
        }
      }
      return { name: `projects/${projectId}/rulesets/mock-ruleset` };
    }
    if (method === 'PUT' && path.includes('/releases/')) {
      return {};
    }
    if (method === 'GET' && path.includes('/releases/')) {
      return { rulesetName: `projects/${projectId}/rulesets/mock-ruleset` };
    }
  }

  // Intercept and handle Auth configuration for the emulator
  if (authEmulator && base === 'https://identitytoolkit.googleapis.com/admin/v2') {
    if (method === 'GET' && path.endsWith('/config')) {
      return { signIn: { email: { enabled: false } } };
    }
    if (method === 'PATCH' && path.includes('/config')) {
      return {};
    }
    if (method === 'GET' && path.includes('/defaultSupportedIdpConfigs/')) {
      return null;
    }
    if (method === 'POST' && path.includes('/defaultSupportedIdpConfigs')) {
      return {};
    }
    if (method === 'PATCH' && path.includes('/defaultSupportedIdpConfigs/')) {
      return {};
    }
  }

  const isTargetingEmulator = (base === 'https://firestore.googleapis.com/v1' && firestoreEmulator) ||
                              (base === 'https://firebaserules.googleapis.com/v1' && firestoreEmulator) ||
                              (base === 'https://identitytoolkit.googleapis.com/admin/v2' && authEmulator);

  if (!isTargetingEmulator) {
    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && (isWrite || isMockClient))) {
      return Promise.resolve(createFirebaseOfflineMock(path, opts));
    }
  }

  const fetchOpts = abortSignal ? { ...opts, signal: abortSignal } : opts;

  return withRetry(async () => {
    const token = await getFirebaseToken([CLOUD_SCOPE]);
    
    let targetUrl = `${base}${path}`;
    if (base === 'https://firestore.googleapis.com/v1' && firestoreEmulator) {
      targetUrl = targetUrl.replace('https://firestore.googleapis.com/v1', `http://${firestoreEmulator}/v1`);
    }

    const res = await fetch(targetUrl, {
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
