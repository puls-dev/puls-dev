import { GCPCloudRunBuilder } from './cloudrun.js';
import { GCPCloudSQLBuilder } from './cloudsql.js';
import { GCPSecretBuilder, resolveGCPEnvVars } from './secrets.js';
import { GCPPubSubTopicBuilder, GCPPubSubSubscriptionBuilder } from './pubsub.js';
import { GCPCloudDNSZoneBuilder } from './clouddns.js';
import { GCPServiceAccountBuilder, GCPIAMBindingBuilder } from './iam.js';
import { GCPVMBuilder } from './vm.js';

export {
  GCPSecretBuilder,
  resolveGCPEnvVars,
  GCPPubSubTopicBuilder,
  GCPPubSubSubscriptionBuilder,
  GCPCloudDNSZoneBuilder,
  GCPServiceAccountBuilder,
  GCPIAMBindingBuilder,
  GCPVMBuilder
};

export const GCP = {
  CloudRun: (serviceId: string) => new GCPCloudRunBuilder(serviceId),
  CloudSQL: (instanceId: string) => new GCPCloudSQLBuilder(instanceId),
  Secret: (secretId: string) => new GCPSecretBuilder(secretId),
  CloudDNS: (zoneName: string) => new GCPCloudDNSZoneBuilder(zoneName),
  ServiceAccount: (saId: string) => new GCPServiceAccountBuilder(saId),
  IAMBinding: (name: string) => new GCPIAMBindingBuilder(name),
  PubSub: {
    Topic: (topicId: string) => new GCPPubSubTopicBuilder(topicId),
    Subscription: (subscriptionId: string) => new GCPPubSubSubscriptionBuilder(subscriptionId),
  },
  VM: (instanceId: string) => new GCPVMBuilder(instanceId),
};


