import { Config } from "../../core/config.js";
import { DropletBuilder } from "./droplet.js";
import { DomainBuilder } from "./domain.js";
import { FirewallBuilder } from "./firewall.js";
import { CertificateBuilder } from "./certificate.js";
import { LoadBalancerBuilder } from "./load_balancer.js";

export const DO = {
  init: (opts: { token: string }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        do: opts,
      },
    });
  },
  Droplet: (name: string) => new DropletBuilder(name),
  Domain: (name: string) => new DomainBuilder(name),
  Firewall: (name: string) => new FirewallBuilder(name),
  Certificate: (name: string) => new CertificateBuilder(name),
  LoadBalancer: (name: string) => new LoadBalancerBuilder(name),
};

export * from "../../types/do.js";

