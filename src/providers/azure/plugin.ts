import { registerProvider } from "../../core/provider.js";
import { Config } from "../../core/config.js";

export const azurePlugin = {
  name: "azure",
  isConfigured: (cfg: any) => !!(cfg?.clientId && cfg?.clientSecret && cfg?.tenantId && cfg?.subscriptionId),
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        azure: pOpts,
      },
    });
  }
};

registerProvider(azurePlugin);
