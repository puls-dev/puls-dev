import { Config } from "../../core/config.js";
import { ResourceGroupBuilder } from "./resource_group.js";
import { BlobStorageBuilder } from "./blob_storage.js";
import { AppServiceBuilder } from "./app_service.js";
import { AzureVMBuilder } from "./vm.js";

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
};

export { ResourceGroupBuilder, BlobStorageBuilder, AppServiceBuilder, AzureVMBuilder };
