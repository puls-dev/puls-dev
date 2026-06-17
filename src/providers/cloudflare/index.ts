import { Config } from "../../core/config.js";
import { ZoneBuilder } from "./zone.js";
import { WorkerBuilder } from "./worker.js";
import { KVBuilder } from "./kv.js";
import { R2Builder } from "./r2.js";

import { CloudflarePagesBuilder } from "./pages.js";

export const CF = {
  init: (opts: { token: string; accountId?: string }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        cloudflare: opts,
      },
    });
  },
  Zone: (domainName: string) => new ZoneBuilder(domainName),
  Worker: (name: string) => new WorkerBuilder(name),
  KV: (title: string) => new KVBuilder(title),
  R2: (bucketName: string) => new R2Builder(bucketName),
  Pages: (projectName: string) => new CloudflarePagesBuilder(projectName),
};
