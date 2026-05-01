export interface GlobalConfig {
  dryRun?: boolean;
  providers: {
    do?: {
      token: string;
      defaultRegion?: string;
    };
    aws?: {
      region: string;
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
}

export const Config = new ConfigManager();
