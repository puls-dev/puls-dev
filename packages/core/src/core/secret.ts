import { Output } from "./output.js";
import { Config } from "./config.js";
import { resourceContextStorage } from "./context.js";

export const resolvedSecrets = new Set<string>();

export function clearResolvedSecrets(): void {
  resolvedSecrets.clear();
}

/**
 * Secret represents a lazy, secure credential that is fetched asynchronously
 * at deployment time instead of during the eager construction phase.
 */
export class Secret extends Output<string> {
  constructor(public readonly secretName: string, fetcher: () => Promise<string>) {
    super();
    this.startFetching(fetcher);
  }

  private async startFetching(fetcher: () => Promise<string>) {
    try {
      if (Config.isGlobalDryRun()) {
        // Resolve immediately to a secure placeholder during dry-run testing
        const placeholder = `[SECRET:${this.secretName}]`;
        this.resolve(placeholder);
        resolvedSecrets.add(placeholder);
        return;
      }
      const val = await fetcher();
      this.resolve(val);
      if (val && val.length >= 3) {
        resolvedSecrets.add(val);
        resourceContextStorage.getStore()?.secrets.add(val);
      }
    } catch (err: any) {
      this.reject(err);
    }
  }

  /**
   * Helper method to seamlessly unpack either a static string, a standard Output, or a Secret.
   * Call this within resource builder deploy() methods.
   */
  static async resolve(val: string | Output<string> | Secret): Promise<string> {
    if (val instanceof Output) {
      const resolved = await val.get();
      if (val instanceof Secret && resolved && resolved.length >= 3) {
        resolvedSecrets.add(resolved);
        resourceContextStorage.getStore()?.secrets.add(resolved);
      }
      return resolved;
    }
    return val;
  }

  /**
   * Fetches a secret from a local environment variable.
   */
  static env(envName: string, fallback?: string): Secret {
    return new Secret(envName, async () => {
      const val = process.env[envName] ?? fallback;
      if (val === undefined) {
        throw new Error(`Environment secret "${envName}" is not set and has no fallback.`);
      }
      return val;
    });
  }

  /**
   * Fetches a secret from AWS Secrets Manager.
   * Uses dynamic imports so AWS SDK is only loaded if this helper is actually called.
   */
  static aws(secretId: string, options?: { region?: string }): Secret {
    return new Secret(secretId, async () => {
      if (Config.isOfflineMode()) return `[SECRET:${secretId}]`;
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const client = new SecretsManagerClient({ region: options?.region ?? process.env.AWS_REGION ?? "us-east-1" });
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!result.SecretString) {
        throw new Error(`AWS Secret "${secretId}" is empty or not a string.`);
      }
      return result.SecretString;
    });
  }

  /**
   * Fetches a parameter from AWS SSM Parameter Store.
   * Uses dynamic imports so AWS SDK is only loaded if this helper is actually called.
   */
  static ssm(parameterName: string, options?: { region?: string }): Secret {
    return new Secret(parameterName, async () => {
      if (Config.isOfflineMode()) return `[SECRET:${parameterName}]`;
      const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
      const client = new SSMClient({ region: options?.region ?? process.env.AWS_REGION ?? "us-east-1" });
      const result = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
      if (!result.Parameter?.Value) {
        throw new Error(`AWS SSM Parameter "${parameterName}" is empty.`);
      }
      return result.Parameter.Value;
    });
  }

  /**
   * Fetches a secret from GCP Secret Manager.
   * Uses dynamic imports so GCP config/fetch tools are only loaded if this helper is actually called.
   */
  static gcp(secretId: string, options?: { projectId?: string }): Secret {
    return new Secret(secretId, async () => {
      if (Config.isOfflineMode()) return `[SECRET:${secretId}]`;
      const { gcpFetch, getProjectId } = await import("@puls-dev/gcp" as any);
      const project = options?.projectId ?? getProjectId();
      const payload = await gcpFetch(
        "https://secretmanager.googleapis.com",
        `/v1/projects/${project}/secrets/${secretId}/versions/latest:access`
      );
      if (!payload?.payload?.data) {
        throw new Error(`GCP Secret "${secretId}" payload is empty.`);
      }
      return Buffer.from(payload.payload.data, "base64").toString("utf8");
    });
  }

  /**
   * Fetches a secret from Azure Key Vault.
   * Uses dynamic imports so Azure config/fetch tools are only loaded if this helper is actually called.
   */
  static azure(secretName: string, vaultName: string): Secret {
    return new Secret(secretName, async () => {
      const { getAzureToken } = await import("@puls-dev/azure" as any);
      const isOffline = Config.isOfflineMode() || Config.isGlobalDryRun();
      if (isOffline) {
        return "mock-azure-vault-secret-value";
      }

      const token = await getAzureToken("https://vault.azure.net/.default");
      const url = `https://${vaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Azure Key Vault Secret "${secretName}" fetch failed: ${res.status} ${await res.text()}`);
      }

      const data = (await res.json()) as { value: string };
      return data.value;
    });
  }

  /**
   * Transforms this Secret by extracting a specific JSON key from its value.
   */
  jsonKey(key: string): Output<string> {
    return this.apply(val => {
      const parsed = extractJsonKey(val, key);
      if (parsed === null) {
        throw new Error(`Failed to extract JSON key "${key}" from secret "${this.secretName}"`);
      }
      return parsed;
    });
  }
}

export function extractJsonKey(value: string | null, key: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed[key] !== undefined ? String(parsed[key]) : null;
    }
  } catch {}

  try {
    const normalized = trimmed.replace(/'/g, '"');
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object") {
      return parsed[key] !== undefined ? String(parsed[key]) : null;
    }
  } catch {}

  const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  const match = trimmed.match(new RegExp(`(?:['"]?${escapedKey}['"]?\\s*:\\s*['"])([^'"]+)`));
  if (match && match[1]) {
    return match[1];
  }

  return null;
}

