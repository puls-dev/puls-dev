import { AsyncLocalStorage } from "node:async_hooks";

export interface HostEntry {
  name: string;
  ip: string;
  user: string;
  sshKey?: string;
  provider: string;
}

export interface ResourceContext {
  abortSignal?: AbortSignal;
  hosts?: HostEntry[];
  stackName?: string;
}

export const resourceContextStorage = new AsyncLocalStorage<ResourceContext>();
