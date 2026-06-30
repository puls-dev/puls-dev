import "./plugin.js";
import { Config } from "@puls-dev/core";
import { ServerBuilder } from "./server.js";
import { SSHKeyBuilder } from "./ssh_key.js";
import { NetworkBuilder } from "./network.js";
import { FirewallBuilder } from "./firewall.js";
import { VolumeBuilder } from "./volume.js";
import { LoadBalancerBuilder } from "./load_balancer.js";

export const HCloud = {
  init: (opts: { token: string; defaultLocation?: string; sshUser?: string }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        hcloud: opts,
      },
    });
  },
  Server: (name: string) => new ServerBuilder(name),
  SSHKey: (name: string) => new SSHKeyBuilder(name),
  Network: (name: string) => new NetworkBuilder(name),
  Firewall: (name: string) => new FirewallBuilder(name),
  Volume: (name: string) => new VolumeBuilder(name),
  LoadBalancer: (name: string) => new LoadBalancerBuilder(name),
};

export * from "./types/hcloud.js";
export { ServerBuilder } from "./server.js";
export { SSHKeyBuilder } from "./ssh_key.js";
export { NetworkBuilder } from "./network.js";
export { FirewallBuilder } from "./firewall.js";
export { VolumeBuilder } from "./volume.js";
export { LoadBalancerBuilder } from "./load_balancer.js";
export { HCloudApiClient, getHCloudApi } from "./api.js";
export { listHCloudResources } from "./list.js";
