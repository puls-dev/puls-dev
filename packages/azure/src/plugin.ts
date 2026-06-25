import { registerProvider } from "@puls-dev/core";
import { Config } from "@puls-dev/core";

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
