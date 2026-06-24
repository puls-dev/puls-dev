import { registerProvider } from "../../core/provider.js";
import { Config } from "../../core/config.js";

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
