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

class ConfigManager {
  private config: GlobalConfig = {
    providers: {},
  };

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
