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
  secrets: Set<string>;
  providers?: Record<string, any>;
  aws?: {
    region?: string;
    profile?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
  };
  gcp?: {
    projectId?: string;
    serviceAccountPath?: string;
    region?: string;
    sshUser?: string;
  };
}

export const resourceContextStorage = new AsyncLocalStorage<ResourceContext>();
