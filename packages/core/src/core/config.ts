import "dotenv/config";

export interface GlobalConfig {
  dryRun?: boolean;
  parallel?: boolean;
  offline?: boolean;
  providers: {
    do?: {
      token: string;
      defaultRegion?: string;
      spacesAccessKey?: string;
      spacesSecretKey?: string;
      sshUser?: string;
    };
    aws?: {
      region?: string;
      endpoint?: string;
    };
    proxmox?: {
      url: string; // e.g. https://10.8.4.39:8006
      user: string; // e.g. terraform@pve
      tokenName: string; // e.g. provider
      tokenSecret: string; // the secret UUID
      nodes?: string[]; // cluster nodes; auto-detected if omitted
      storage?: string; // default: rbd_pool
      dnsDomain?: string; // e.g. 'nolimit.int' - search domain + auto-resolves <vm>.domain for IP
      dnsServers?: string[]; // e.g. ['10.8.10.11', '10.8.10.12', '10.8.10.13']
      verifySsl?: boolean; // default: true
      sshUser?: string; // SSH user for Ansible provisioning
    };
    firebase?: {
      projectId: string;
      serviceAccountPath?: string;
    };
    gcp?: {
      projectId?: string;
      serviceAccountPath?: string;
      region?: string;
      sshUser?: string;
    };
    hcloud?: {
      token: string;
      region?: string;
      defaultLocation?: string;
      sshUser?: string;
    };
    cloudflare?: {
      token: string;
      accountId?: string;
    };
    azure?: {
      clientId: string;
      clientSecret: string;
      tenantId: string;
      subscriptionId: string;
      defaultLocation?: string;
      sshUser?: string;
    };
    [key: string]: any;
  };
}

type DeepPartial<T> = {
  [P in keyof T]?: NonNullable<T[P]> extends object ? DeepPartial<NonNullable<T[P]>> : T[P];
};

function loadEnvDefaults(): GlobalConfig {
  const providers: any = {};

  if (process.env.DO_TOKEN || process.env.DIGITALOCEAN_TOKEN) {
    providers.do = {
      token: process.env.DO_TOKEN || process.env.DIGITALOCEAN_TOKEN,
      spacesAccessKey: process.env.SPACES_ACCESS_KEY_ID,
      spacesSecretKey: process.env.SPACES_SECRET_ACCESS_KEY,
    };
  }

  if (
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_ENDPOINT_URL
  ) {
    providers.aws = {
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL,
    };
  }

  if (process.env.HCLOUD_TOKEN) {
    providers.hcloud = {
      token: process.env.HCLOUD_TOKEN,
    };
  }

  if (process.env.CLOUDFLARE || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN) {
    providers.cloudflare = {
      token: process.env.CLOUDFLARE || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN,
    };
  }

  if (process.env.PROXMOX_URL) {
    providers.proxmox = {
      url: process.env.PROXMOX_URL,
      user: process.env.PROXMOX_USER,
      tokenName: process.env.PROXMOX_TOKEN_NAME,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
      nodes: process.env.PROXMOX_NODES?.split(","),
      dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
      dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(","),
      // Proxmox ships with self-signed certs — default false, opt-in to strict with PROXMOX_VERIFY_SSL=true
      verifySsl: process.env.PROXMOX_VERIFY_SSL === "true",
    };
  }

  if (process.env.FIREBASE_SA) {
    providers.firebase = {
      serviceAccountPath: process.env.FIREBASE_SA,
    };
  }

  if (process.env.GCP_SA || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) {
    providers.gcp = {
      serviceAccountPath: process.env.GCP_SA,
      projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    };
  }

  if (process.env.AZURE_CLIENT_ID) {
    providers.azure = {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      tenantId: process.env.AZURE_TENANT_ID,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      defaultLocation: process.env.AZURE_LOCATION || process.env.AZURE_DEFAULT_LOCATION || "eastus",
    };
  }

  return { providers };
}

class ConfigManager {
  private config: GlobalConfig = {
    providers: {},
  };

  constructor() {
    this.config = loadEnvDefaults();
  }

  set(newConfig: DeepPartial<GlobalConfig>) {
    const mergedProviders = { ...this.config.providers };
    if (newConfig.providers) {
      for (const [key, value] of Object.entries(newConfig.providers)) {
        if (value && typeof value === "object") {
          mergedProviders[key] = {
            ...mergedProviders[key],
            ...value,
          };
        } else {
          mergedProviders[key] = value;
        }
      }
    }
    this.config = {
      ...this.config,
      ...newConfig,
      providers: mergedProviders,
    };
  }

  get() {
    return this.config;
  }

  isGlobalDryRun() {
    return this.config.dryRun ?? false;
  }

  isParallelActive() {
    return this.config.parallel ?? false;
  }

  isOfflineMode() {
    return this.config.offline ?? false;
  }
}

export const Config = new ConfigManager();
