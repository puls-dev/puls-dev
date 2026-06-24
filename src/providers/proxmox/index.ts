import "./plugin.js";
import { Config } from "../../core/config.js";
import { VMBuilder } from "./vm.js";
import { TemplateBuilder } from "./template.js";
import { createBuilderArray, BuilderGroup } from "../../core/resource.js";

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
  VM: <T extends string | string[]>(
    name: T
  ): T extends string[] ? BuilderGroup<VMBuilder> : VMBuilder => {
    if (Array.isArray(name)) {
      return createBuilderArray(name.map((n) => new VMBuilder(n))) as any;
    }
    return new VMBuilder(name as string) as any;
  },
  Template: <T extends string | string[]>(
    name: T
  ): T extends string[] ? BuilderGroup<TemplateBuilder> : TemplateBuilder => {
    if (Array.isArray(name)) {
      return createBuilderArray(name.map((n) => new TemplateBuilder(n))) as any;
    }
    return new TemplateBuilder(name as string) as any;
  },
};

export * from "../../types/proxmox.js";

