import { Config } from '@puls-dev/core';
import { withRetry } from '@puls-dev/core';
import { resourceContextStorage } from '@puls-dev/core';

export class DoApiClient {
  private static readonly BASE = 'https://api.digitalocean.com/v2';

  constructor(private token: string) {}

  private get authHeaders() {
    return { 
      Authorization: `Bearer ${this.token}`, 
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity'
    };
  }

  private createDoOfflineMock(method: string, path: string, body?: unknown): any {
    if (path.includes("/droplets")) {
      return {
        droplet: {
          id: 1234567,
          name: (body as any)?.name ?? "mock-droplet",
          networks: {
            v4: [
              { ip_address: "159.203.12.34", type: "public" },
              { ip_address: "10.132.0.3", type: "private" }
            ]
          }
        },
        droplets: [
          {
            id: 1234567,
            name: (body as any)?.name ?? "mock-droplet",
            networks: {
              v4: [
                { ip_address: "159.203.12.34", type: "public" },
                { ip_address: "10.132.0.3", type: "private" }
              ]
            }
          }
        ]
      };
    }
    if (path.includes("/domains")) {
      return { domain: { name: "mock-domain.com", ttl: 1800 } };
    }
    if (path.includes("/ssh_keys")) {
      return { ssh_key: { id: 12345, name: "mock-key", public_key: "ssh-rsa mock" } };
    }
    return new Proxy({}, {
      get(target, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "id") return 123456;
        if (prop === "name") return "mock-do-name";
        if (prop === "status") return "active";
        if (prop.endsWith("s")) return [];
        return `mock-do-${prop.toLowerCase()}`;
      }
    });
  }

  private async request<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retryable: (err) => {
        const match = err.message.match(/: (\d+)/);
        const status = match ? parseInt(match[1], 10) : null;
        return status === 429 || (status && status >= 500) || err.message.includes("ETIMEDOUT");
      }
    });
  }

  async get<T>(path: string): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && this.token === "mock-do-token")) {
      return Promise.resolve(this.createDoOfflineMock('GET', path) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, { 
        headers: this.authHeaders,
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`DO API GET ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createDoOfflineMock('POST', path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`DO API POST ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createDoOfflineMock('PUT', path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'PUT',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`DO API PUT ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async delete(path: string, body?: unknown): Promise<void> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve();
    }

    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'DELETE',
        headers: this.authHeaders,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DO API DELETE ${path}: ${res.status} ${await res.text()}`);
      }
    });
  }
}

export function getDoApi(): DoApiClient {
  const ctx = resourceContextStorage.getStore();
  const token = ctx?.providers?.do?.token ?? Config.get().providers.do?.token;
  if (!token) {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return new DoApiClient("mock-do-token");
    }
    throw new Error('DO token not configured. Call DO.init({ token: "..." })');
  }
  return new DoApiClient(token);
}
