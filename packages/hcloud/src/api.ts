import { Config } from '@puls-dev/core';
import { withRetry } from '@puls-dev/core';
import { resourceContextStorage } from '@puls-dev/core';

export class HCloudApiClient {
  private static readonly BASE = 'https://api.hetzner.cloud/v1';

  constructor(private token: string) {}

  private get authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity'
    };
  }

  private createOfflineMock(method: string, path: string, body?: unknown): any {
    if (path.includes("/servers")) {
      const name = (body as any)?.name ?? "mock-server";
      return {
        server: {
          id: 123456,
          name,
          status: "running",
          public_net: {
            ipv4: { ip: "159.69.1.2" }
          },
          private_net: [],
          server_type: { name: (body as any)?.server_type ?? "cx22" },
          image: { name: (body as any)?.image ?? "ubuntu-24.04" },
          datacenter: { location: { name: (body as any)?.location ?? "nbg1" } }
        },
        servers: [
          {
            id: 123456,
            name,
            status: "running",
            public_net: {
              ipv4: { ip: "159.69.1.2" }
            },
            private_net: [],
            server_type: { name: "cx22" },
            image: { name: "ubuntu-24.04" },
            datacenter: { location: { name: "nbg1" } }
          }
        ],
        action: { id: 7890, status: "success" }
      };
    }
    if (path.includes("/ssh_keys")) {
      return {
        ssh_key: {
          id: 12345,
          name: (body as any)?.name ?? "mock-key",
          public_key: (body as any)?.public_key ?? "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL...",
          fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff"
        },
        ssh_keys: []
      };
    }
    if (path.includes("/networks")) {
      return {
        network: {
          id: 5678,
          name: (body as any)?.name ?? "mock-net",
          ip_range: (body as any)?.ip_range ?? "10.0.0.0/16"
        },
        networks: []
      };
    }
    if (path.includes("/firewalls")) {
      return {
        firewall: {
          id: 9012,
          name: (body as any)?.name ?? "mock-fw",
          rules: (body as any)?.rules ?? []
        },
        firewalls: []
      };
    }
    if (path.includes("/volumes")) {
      return {
        volume: {
          id: 8080,
          name: (body as any)?.name ?? "mock-volume",
          size: (body as any)?.size ?? 10,
          linux_device: "/dev/disk/by-id/scsi-0HC_Volume_8080"
        },
        volumes: [],
        action: { id: 7890, status: "success" }
      };
    }
    if (path.includes("/load_balancers")) {
      return {
        load_balancer: {
          id: 9090,
          name: (body as any)?.name ?? "mock-lb",
          public_net: {
            ipv4: { ip: "1.2.3.4" }
          }
        },
        load_balancers: [],
        action: { id: 7890, status: "success" }
      };
    }
    if (path.includes("/actions/")) {
      return { action: { id: 7890, status: "success" } };
    }
    return new Proxy({}, {
      get(target, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "id") return 123456;
        if (prop === "name") return "mock-hcloud-name";
        if (prop === "status") return "success";
        if (prop.endsWith("s")) return [];
        return `mock-hcloud-${prop.toLowerCase()}`;
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

    if (Config.isOfflineMode() || (Config.isGlobalDryRun() && this.token === "mock-hcloud-token")) {
      return Promise.resolve(this.createOfflineMock('GET', path) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${HCloudApiClient.BASE}${path}`, {
        headers: this.authHeaders,
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`HCloud API GET ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createOfflineMock('POST', path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${HCloudApiClient.BASE}${path}`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`HCloud API POST ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve(this.createOfflineMock('PUT', path, body) as T);
    }

    return this.request(async () => {
      const res = await fetch(`${HCloudApiClient.BASE}${path}`, {
        method: 'PUT',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok) throw new Error(`HCloud API PUT ${path}: ${res.status} ${await res.text()}`);
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
      const res = await fetch(`${HCloudApiClient.BASE}${path}`, {
        method: 'DELETE',
        headers: this.authHeaders,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(abortSignal && { signal: abortSignal })
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HCloud API DELETE ${path}: ${res.status} ${await res.text()}`);
      }
    });
  }

  async waitForAction(actionId: number): Promise<void> {
    if (Config.isOfflineMode() || Config.isGlobalDryRun()) {
      return Promise.resolve();
    }

    const context = resourceContextStorage.getStore();
    const abortSignal = context?.abortSignal;

    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Action wait aborted");
      }

      const res = await this.get<{ action: { status: string; error?: { message: string } } }>(`/actions/${actionId}`);
      if (res.action.status === 'success') {
        return;
      }
      if (res.action.status === 'error') {
        throw new Error(`HCloud Action ${actionId} failed: ${res.action.error?.message}`);
      }

      // Wait 1 second before polling again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function getHCloudApi(): HCloudApiClient {
  const ctx = resourceContextStorage.getStore();
  const token = process.env.HCLOUD_TOKEN || ctx?.providers?.hcloud?.token || Config.get().providers.hcloud?.token;
  if (!token && !Config.isOfflineMode()) {
    throw new Error("Hetzner Cloud token not configured. Set HCLOUD_TOKEN environment variable.");
  }
  return new HCloudApiClient(token || "mock-hcloud-token");
}
