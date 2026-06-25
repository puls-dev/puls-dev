import "./plugin.js";
import { Config } from "@puls-dev/core";
import { DropletBuilder } from "./droplet.js";
import { DomainBuilder } from "./domain.js";
import { FirewallBuilder } from "./firewall.js";
import { CertificateBuilder } from "./certificate.js";
import { LoadBalancerBuilder } from "./load_balancer.js";
import { SpacesBuilder } from "./spaces.js";
import { DatabaseBuilder } from "./database.js";
import { AppPlatformBuilder } from "./app.js";
import { VPCBuilder } from "./vpc.js";

export const DO = {
  init: (opts: { token: string; defaultRegion?: string; spacesAccessKey?: string; spacesSecretKey?: string }) => {
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
  Spaces: (name: string) => new SpacesBuilder(name),
  Database: (name: string) => new DatabaseBuilder(name),
  App: (name: string) => new AppPlatformBuilder(name),
  VPC: (name: string) => new VPCBuilder(name),
};

export * from "./types/do.js";

