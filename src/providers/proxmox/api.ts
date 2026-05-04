import { Config } from "../../core/config.ts";

export class ProxmoxApiClient {
  private baseUrl: string;
  private authToken: string;

  constructor(
    url: string,
    user: string,
    tokenName: string,
    tokenSecret: string,
    verifySsl: boolean = true,
  ) {
    this.baseUrl = `${url.replace(/\/$/, "")}/api2/json`;
    // PVE token format: USER@REALM!TOKENNAME=SECRET
    this.authToken = `${user}!${tokenName}=${tokenSecret}`;
    if (!verifySsl) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.authToken}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const opts: RequestInit = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, opts);
    if (!res.ok)
      throw new Error(
        `Proxmox ${method} ${path}: ${res.status} ${await res.text()}`,
      );

    const json = (await res.json()) as any;
    return json.data ?? null;
  }

  async get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request("PUT", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path);
  }
}

export function getPMClient(): ProxmoxApiClient {
  const cfg = Config.get().providers.proxmox;
  if (!cfg?.url || !cfg?.user || !cfg?.tokenName || !cfg?.tokenSecret)
    throw new Error(
      "Proxmox not configured. Set proxmox: { url, user, tokenName, tokenSecret } in @Deploy",
    );
  return new ProxmoxApiClient(
    cfg.url,
    cfg.user,
    cfg.tokenName,
    cfg.tokenSecret,
    cfg.verifySsl ?? true,
  );
}
