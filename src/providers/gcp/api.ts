import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { Config } from '../../core/config.js';
import { withRetry } from '../../core/retry.js';

export interface GCPConfig {
  projectId: string;
  serviceAccountPath: string;
  region?: string;
}

export function resolveGCPConfig(): GCPConfig {
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
  const { serviceAccountPath } = resolveGCPConfig();
  const auth = new GoogleAuth({ keyFile: serviceAccountPath, scopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error('Failed to retrieve GCP access token');
  }
  return token.token;
}

const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export async function gcpFetch(base: string, path: string, opts: RequestInit = {}): Promise<any> {
  return withRetry(async () => {
    const token = await getGCPToken([CLOUD_SCOPE]);
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
  }, {
    retryable: (err) => {
      const match = err.message.match(/→ (\d+):/);
      const status = match ? parseInt(match[1], 10) : null;
      return status === 429 || (status && status >= 500) || err.message.includes("ETIMEDOUT");
    }
  });
}
