import { Config } from '../../core/config.js';

export class DoApiClient {
  private static readonly BASE = 'https://api.digitalocean.com/v2';

  constructor(private token: string) {}

  private get authHeaders() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${DoApiClient.BASE}${path}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`DO API GET ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${DoApiClient.BASE}${path}`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DO API POST ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${DoApiClient.BASE}${path}`, {
      method: 'PUT',
      headers: this.authHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DO API PUT ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${DoApiClient.BASE}${path}`, {
      method: 'DELETE',
      headers: this.authHeaders,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DO API DELETE ${path}: ${res.status} ${await res.text()}`);
    }
  }
}

export function getDoApi(): DoApiClient {
  const token = Config.get().providers.do?.token;
  if (!token) throw new Error('DO token not configured. Call DO.init({ token: "..." })');
  return new DoApiClient(token);
}
