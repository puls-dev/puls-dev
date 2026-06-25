import "./plugin.js";
import { Config } from "@puls-dev/core";
import { ResourceGroupBuilder } from "./resource_group.js";
import { BlobStorageBuilder } from "./blob_storage.js";
import { AppServiceBuilder } from "./app_service.js";
import { AzureVMBuilder } from "./vm.js";
import { AzureSQLBuilder } from "./sql.js";
import { AzureNetworkBuilder } from "./network.js";
import { AzureDNSBuilder } from "./dns.js";
import { AzureFunctionBuilder } from "./function.js";

export const Azure = {
  init: (opts: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    subscriptionId: string;
    defaultLocation?: string;
    sshUser?: string;
  }) => {
    Config.set({
      providers: {
        ...Config.get().providers,
        azure: opts,
      },
    });
  },
  ResourceGroup: (name: string) => new ResourceGroupBuilder(name),
  BlobStorage: (name: string) => new BlobStorageBuilder(name),
  AppService: (name: string) => new AppServiceBuilder(name),
  VM: (name: string) => new AzureVMBuilder(name),
  SQL: (name: string) => new AzureSQLBuilder(name),
  VirtualNetwork: (name: string) => new AzureNetworkBuilder(name),
  DNS: (name: string) => new AzureDNSBuilder(name),
  Function: (name: string) => new AzureFunctionBuilder(name),
};

export {
  ResourceGroupBuilder,
  BlobStorageBuilder,
  AppServiceBuilder,
  AzureVMBuilder,
  AzureSQLBuilder,
  AzureNetworkBuilder,
  AzureDNSBuilder,
  AzureFunctionBuilder,
};

export { getAzureToken } from "./api.js";
