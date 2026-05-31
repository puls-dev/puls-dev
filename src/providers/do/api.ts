import { Config } from '../../core/config.js';
import { withRetry } from '../../core/retry.js';

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
    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, { headers: this.authHeaders });
      if (!res.ok) throw new Error(`DO API GET ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`DO API POST ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'PUT',
        headers: this.authHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`DO API PUT ${path}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<T>;
    });
  }

  async delete(path: string, body?: unknown): Promise<void> {
    return this.request(async () => {
      const res = await fetch(`${DoApiClient.BASE}${path}`, {
        method: 'DELETE',
        headers: this.authHeaders,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DO API DELETE ${path}: ${res.status} ${await res.text()}`);
      }
    });
  }
}

export function getDoApi(): DoApiClient {
  const token = Config.get().providers.do?.token;
  if (!token) throw new Error('DO token not configured. Call DO.init({ token: "..." })');
  return new DoApiClient(token);
}
