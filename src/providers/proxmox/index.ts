import { Config } from "../../core/config.js";
import { VMBuilder } from "./vm.js";

export const Proxmox = {
  init: (opts: {
    url: string;
    user: string;
    tokenName: string;
    tokenSecret: string;
    nodes?: string[];
    storage?: string;
    dnsDomain?: string;
    dnsServers?: string[];
    verifySsl?: boolean;
  }) => {
    Config.set({
      providers: { ...Config.get().providers, proxmox: opts },
    });
  },
  VM: (name: string) => new VMBuilder(name),
};
