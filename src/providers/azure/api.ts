import { Config } from "../../core/config.js";
import { withRetry } from "../../core/retry.js";
import { resourceContextStorage } from "../../core/context.js";

export interface AzureConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  subscriptionId: string;
  defaultLocation?: string;
  sshUser?: string;
}

interface TokenCacheEntry {
  token: string;
  expiry: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

export function resolveAzureConfig(): AzureConfig {
  const isOffline = Config.isOfflineMode() || Config.isGlobalDryRun();
  const cfg = Config.get().providers.azure;

  const clientId = cfg?.clientId ?? process.env.AZURE_CLIENT_ID;
  const clientSecret = cfg?.clientSecret ?? process.env.AZURE_CLIENT_SECRET;
  const tenantId = cfg?.tenantId ?? process.env.AZURE_TENANT_ID;
  const subscriptionId = cfg?.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID;
  const defaultLocation = cfg?.defaultLocation ?? process.env.AZURE_DEFAULT_LOCATION ?? process.env.AZURE_LOCATION ?? "eastus";
  const sshUser = cfg?.sshUser ?? process.env.AZURE_SSH_USER ?? "azureuser";

  if (clientId && clientSecret && tenantId && subscriptionId) {
    return { clientId, clientSecret, tenantId, subscriptionId, defaultLocation, sshUser };
  }

  if (isOffline) {
    return {
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
      tenantId: "mock-tenant-id",
      subscriptionId: "mock-subscription-id",
      defaultLocation,
      sshUser,
    };
  }

  throw new Error(
    "Azure credentials not configured. Please set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, and AZURE_SUBSCRIPTION_ID env vars, or configure providers.azure in Stack."
  );
}

export async function getAzureToken(scope = "https://management.azure.com/.default"): Promise<string> {
  if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
    return "mock-azure-token";
  }

  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (cached && now < cached.expiry - 60000) {
    return cached.token;
  }

  const { clientId, clientSecret, tenantId } = resolveAzureConfig();

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Azure OAuth token request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const token = data.access_token;
  tokenCache.set(scope, {
    token,
    expiry: now + data.expires_in * 1000,
  });

  return token;
}

function createAzureOfflineMock(method: string, path: string, body?: unknown): any {
  // Discovery 404 mocks (so resource creation planning works correctly)
  if (method === "GET") {
    // If getting details of a specific resource instance that we expect to create, return 404
    const isInstanceGet =
      (path.includes("/resourcegroups/") && !path.endsWith("/resourcegroups") && !path.endsWith("/mock-rg") && !path.includes("/mock-rg?")) ||
      (path.includes("/resourceGroups/") &&
        (path.includes("/providers/Microsoft.Compute/virtualMachines/") ||
          path.includes("/providers/Microsoft.Storage/storageAccounts/") ||
          path.includes("/providers/Microsoft.Web/serverfarms/") ||
          path.includes("/providers/Microsoft.Web/sites/") ||
          path.includes("/providers/Microsoft.Network/networkInterfaces/") ||
          path.includes("/providers/Microsoft.Network/virtualNetworks/") ||
          path.includes("/providers/Microsoft.Network/publicIPAddresses/") ||
          path.includes("/providers/Microsoft.Sql/servers/") ||
          path.includes("/providers/Microsoft.Network/dnsZones/") ||
          path.includes("/providers/Microsoft.Network/networkSecurityGroups/")));

    // Check if it's querying list vs specific resource
    const parts = path.split("/");
    const lastPart = parts[parts.length - 1];
    const secondLastPart = parts[parts.length - 2];

    const isSpecificInstance =
      isInstanceGet &&
      lastPart !== "virtualMachines" &&
      lastPart !== "storageAccounts" &&
      lastPart !== "serverfarms" &&
      lastPart !== "sites" &&
      lastPart !== "networkInterfaces" &&
      lastPart !== "virtualNetworks" &&
      lastPart !== "publicIPAddresses" &&
      lastPart !== "servers" &&
      lastPart !== "dnsZones" &&
      lastPart !== "networkSecurityGroups" &&
      lastPart !== "databases" &&
      secondLastPart !== "providers" &&
      !path.endsWith("/containers");

    if (isSpecificInstance) {
      throw new Error(`Azure API GET ${path} → 404: Resource Not Found`);
    }
  }

  if (path.includes("/resourcegroups/")) {
    return {
      id: `/subscriptions/mock-sub/resourcegroups/mock-rg`,
      name: "mock-rg",
      location: "eastus",
      properties: { provisioningState: "Succeeded" },
    };
  }

  if (path.endsWith("/containers")) {
    return { value: [] };
  }

  return new Proxy({}, {
    get(target, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "id") return `/subscriptions/mock-sub/resourcegroups/mock-rg/providers/mock/mock-name`;
      if (prop === "name") return "mock-azure-resource";
      if (prop === "properties") {
        return {
          provisioningState: "Succeeded",
          ipConfigurations: [
            {
              properties: {
                privateIPAddress: "10.0.0.4",
                publicIPAddress: { id: "mock-public-ip-id" }
              }
            }
          ],
          ipAddress: "34.56.78.90",
          dnsNames: ["mock-app.azurewebsites.net"]
        };
      }
      if (prop === "value" || prop === "buckets" || prop === "containers") return [];
      return `mock-azure-${prop.toLowerCase()}`;
    }
  });
}

export class AzureApiClient {
  private static readonly BASE = "https://management.azure.com";

  constructor(private subscriptionId: string) {}

  private async request<T>(method: string, path: string, body?: unknown, apiVersion?: string): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(createAzureOfflineMock(method, path, body) as T);
    }

    return withRetry(async () => {
      const token = await getAzureToken();
      const urlQuery = apiVersion ? `?api-version=${apiVersion}` : "";
      const url = `${AzureApiClient.BASE}${path}${urlQuery}`;

      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(abortSignal && { signal: abortSignal }),
      });

      if (!res.ok) {
        if (method === "DELETE" && res.status === 404) {
          return null as any;
        }
        const text = await res.text();
        throw new Error(`Azure API ${method} ${path} → ${res.status}: ${text}`);
      }

      if (res.status === 204 || res.status === 202) {
        return null as any;
      }

      const text = await res.text();
      return text ? (JSON.parse(text) as T) : (null as any);
    }, {
      retryable: (err) => {
        const match = err.message.match(/→ (\d+):/);
        const status = match ? parseInt(match[1], 10) : null;
        return status === 429 || (status && status >= 500) || err.message.includes("ETIMEDOUT");
      }
    });
  }

  async get<T>(path: string, apiVersion: string): Promise<T> {
    return this.request<T>("GET", path, undefined, apiVersion);
  }

  async put<T>(path: string, body: unknown, apiVersion: string): Promise<T> {
    return this.request<T>("PUT", path, body, apiVersion);
  }

  async post<T>(path: string, body: unknown, apiVersion: string): Promise<T> {
    return this.request<T>("POST", path, body, apiVersion);
  }

  async patch<T>(path: string, body: unknown, apiVersion: string): Promise<T> {
    return this.request<T>("PATCH", path, body, apiVersion);
  }

  async delete(path: string, apiVersion: string): Promise<void> {
    await this.request<void>("DELETE", path, undefined, apiVersion);
  }
}

export function getAzureApi(): AzureApiClient {
  const { subscriptionId } = resolveAzureConfig();
  return new AzureApiClient(subscriptionId);
}
