export interface GlobalConfig {
  dryRun?: boolean;
  parallel?: boolean;
  providers: {
    do?: {
      token: string;
      defaultRegion?: string;
      spacesAccessKey?: string;
      spacesSecretKey?: string;
    };
    aws?: {
      region: string;
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
    };
    firebase?: {
      projectId: string;
      serviceAccountPath: string;
    };
    gcp?: {
      projectId?: string;
      serviceAccountPath?: string;
      region?: string;
    };
  };
}

class ConfigManager {
  private config: GlobalConfig = {
    providers: {},
  };

  set(newConfig: Partial<GlobalConfig>) {
    this.config = { ...this.config, ...newConfig };
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
}

export const Config = new ConfigManager();
