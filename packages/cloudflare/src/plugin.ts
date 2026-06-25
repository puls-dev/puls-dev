import { registerProvider } from "@puls-dev/core";
import { Config } from "@puls-dev/core";

export const cloudflarePlugin = {
  name: "cloudflare",
  isConfigured: (cfg: any) => !!cfg?.token,
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        cloudflare: pOpts,
      },
    });
  }
};

registerProvider(cloudflarePlugin);
