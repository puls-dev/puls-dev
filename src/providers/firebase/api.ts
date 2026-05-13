import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { Config } from '../../core/config.ts';

function resolveFirebaseConfig() {
  const cfg = Config.get().providers.firebase;
  if (cfg?.serviceAccountPath) return cfg;

  // Fallback: auto-configure from FIREBASE_SA env var so the decorator option is optional
  const saPath = process.env.FIREBASE_SA;
  if (saPath) {
    const sa = JSON.parse(readFileSync(saPath, 'utf8'));
    return { projectId: sa.project_id as string, serviceAccountPath: saPath };
  }

  throw new Error('Firebase not configured. Set FIREBASE_SA=/path/to/sa.json or use @Deploy({ firebase: "..." })');
}

export function getProjectId(): string {
  return resolveFirebaseConfig().projectId;
}

export async function getFirebaseToken(scopes: string[]): Promise<string> {
  const { serviceAccountPath } = resolveFirebaseConfig();
  const auth = new GoogleAuth({ keyFile: serviceAccountPath, scopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token!;
}

const HOSTING_SCOPE = 'https://www.googleapis.com/auth/firebase.hosting';
const CLOUD_SCOPE   = 'https://www.googleapis.com/auth/cloud-platform';

export async function hostingFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const token = await getFirebaseToken([HOSTING_SCOPE]);
  const base = 'https://firebasehosting.googleapis.com/v1beta1';
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firebase Hosting API ${opts.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function cloudFetch(base: string, path: string, opts: RequestInit = {}): Promise<any> {
  const token = await getFirebaseToken([CLOUD_SCOPE]);
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GCP API ${opts.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
