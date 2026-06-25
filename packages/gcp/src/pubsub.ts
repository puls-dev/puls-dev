import { BaseBuilder } from "@puls-dev/core";
import { gcpFetch, getProjectId } from "./api.js";

const PUBSUB_BASE = "https://pubsub.googleapis.com";

export class GCPPubSubTopicBuilder extends BaseBuilder {
  resolvedTopicName: string | null = null;

  constructor(topicId: string) {
    super(topicId);
    this.discoveryPromise = this.discoverTopic();
  }

  private async discoverTopic(): Promise<any> {
    try {
      const project = getProjectId();
      const res = await gcpFetch(
        PUBSUB_BASE,
        `/v1/projects/${project}/topics/${this.name}`
      );
      this.resolvedTopicName = res.name ?? null;
      return res;
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const topicId = this.name;
    const existing = await this.discoveryPromise;

    console.log(`\n📢 Finalizing GCP Pub/Sub Topic "${topicId}"...`);

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} Pub/Sub topic "${topicId}"`
      );
      this.resolvedTopicName = `projects/${project}/topics/${topicId}`;
      return {
        name: topicId,
        topicName: this.resolvedTopicName,
      };
    }

    if (!existing) {
      console.log(`🚀 Creating GCP Pub/Sub topic "${topicId}"...`);
      const topic = await gcpFetch(
        PUBSUB_BASE,
        `/v1/projects/${project}/topics/${topicId}`,
        {
          method: "PUT",
          body: JSON.stringify({}),
        }
      );
      this.resolvedTopicName = topic.name ?? null;
      console.log(`🚀 Created Pub/Sub topic "${topicId}"`);
    } else {
      this.resolvedTopicName = existing.name ?? null;
      console.log(`   ✅ GCP Pub/Sub topic "${topicId}" already exists.`);
    }

    await this.deploySidecars();
    return {
      name: topicId,
      topicName: this.resolvedTopicName,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const topicId = this.name;

    console.log(`\n🗑️  Destroying GCP Pub/Sub Topic "${topicId}"...`);

    const existing = await this.discoverTopic();
    if (!existing) {
      console.log(`   ✅ Topic "${topicId}" does not exist - nothing to do.`);
      return { destroyed: topicId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Pub/Sub topic "${topicId}"`);
      return { destroyed: topicId };
    }

    console.log(`   🔄 Deleting Pub/Sub topic "${topicId}"...`);
    await gcpFetch(
      PUBSUB_BASE,
      `/v1/projects/${project}/topics/${topicId}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   ✅ Pub/Sub topic "${topicId}" deleted.`);

    await this.destroySidecars();
    return { destroyed: topicId };
  }
}

export class GCPPubSubSubscriptionBuilder extends BaseBuilder {
  private _topic?: string | GCPPubSubTopicBuilder;
  private _pushEndpoint?: string;
  private _ackDeadlineSeconds: number = 10;
  resolvedSubscriptionName: string | null = null;

  constructor(subscriptionId: string) {
    super(subscriptionId);
    this.discoveryPromise = this.discoverSubscription();
  }

  topic(t: string | GCPPubSubTopicBuilder) {
    this._topic = t;
    return this;
  }

  pushEndpoint(url: string) {
    this._pushEndpoint = url;
    return this;
  }

  ackDeadline(seconds: number) {
    this._ackDeadlineSeconds = seconds;
    return this;
  }

  private async discoverSubscription(): Promise<any> {
    try {
      const project = getProjectId();
      const res = await gcpFetch(
        PUBSUB_BASE,
        `/v1/projects/${project}/subscriptions/${this.name}`
      );
      this.resolvedSubscriptionName = res.name ?? null;
      return res;
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const subscriptionId = this.name;

    console.log(`\n📥 Finalizing GCP Pub/Sub Subscription "${subscriptionId}"...`);

    if (!this._topic) {
      throw new Error(`[GCP.PubSub.Subscription:${subscriptionId}] .topic(...) is required`);
    }

    const existing = await this.discoveryPromise;

    // Resolve full topic name
    let targetTopicName: string;
    if (this._topic instanceof GCPPubSubTopicBuilder) {
      targetTopicName = this._topic.resolvedTopicName ?? `projects/${project}/topics/${this._topic.name}`;
    } else {
      targetTopicName = this._topic.includes("/")
        ? this._topic
        : `projects/${project}/topics/${this._topic}`;
    }

    const pushConfig = this._pushEndpoint
      ? { pushEndpoint: this._pushEndpoint }
      : {};

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} Pub/Sub subscription "${subscriptionId}"`
      );
      console.log(`      └─ Topic: ${targetTopicName}`);
      if (this._pushEndpoint) {
        console.log(`      └─ Push Endpoint: ${this._pushEndpoint}`);
      } else {
        console.log(`      └─ Pull Subscription`);
      }
      this.resolvedSubscriptionName = `projects/${project}/subscriptions/${subscriptionId}`;
      return {
        name: subscriptionId,
        subscriptionName: this.resolvedSubscriptionName,
      };
    }

    // Determine if update is needed
    let needsUpdate = !existing;
    if (existing) {
      const existingEndpoint = existing.pushConfig?.pushEndpoint ?? "";
      const targetEndpoint = this._pushEndpoint ?? "";

      const hasEndpointChange = existingEndpoint !== targetEndpoint;
      const hasTopicChange = existing.topic !== targetTopicName;
      const hasAckChange = (existing.ackDeadlineSeconds ?? 10) !== this._ackDeadlineSeconds;

      needsUpdate = hasEndpointChange || hasTopicChange || hasAckChange;
    }

    const subscriptionBody = {
      topic: targetTopicName,
      pushConfig,
      ackDeadlineSeconds: this._ackDeadlineSeconds,
    };

    if (!existing) {
      console.log(`🚀 Creating GCP Pub/Sub subscription "${subscriptionId}"...`);
      const sub = await gcpFetch(
        PUBSUB_BASE,
        `/v1/projects/${project}/subscriptions/${subscriptionId}`,
        {
          method: "PUT",
          body: JSON.stringify(subscriptionBody),
        }
      );
      this.resolvedSubscriptionName = sub.name ?? null;
      console.log(`🚀 Created Pub/Sub subscription "${subscriptionId}"`);
    } else if (needsUpdate) {
      console.log(`🔄 Updating GCP Pub/Sub subscription "${subscriptionId}"...`);
      const sub = await gcpFetch(
        PUBSUB_BASE,
        `/v1/projects/${project}/subscriptions/${subscriptionId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            subscription: {
              name: `projects/${project}/subscriptions/${subscriptionId}`,
              ...subscriptionBody,
            },
            updateMask: "topic,pushConfig,ackDeadlineSeconds",
          }),
        }
      );
      this.resolvedSubscriptionName = sub.name ?? null;
      console.log(`🔄 Updated Pub/Sub subscription "${subscriptionId}"`);
    } else {
      this.resolvedSubscriptionName = existing.name ?? null;
      console.log(`   ✅ GCP Pub/Sub subscription "${subscriptionId}" is up to date.`);
    }

    await this.deploySidecars();
    return {
      name: subscriptionId,
      subscriptionName: this.resolvedSubscriptionName,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const subscriptionId = this.name;

    console.log(`\n🗑️  Destroying GCP Pub/Sub Subscription "${subscriptionId}"...`);

    const existing = await this.discoverSubscription();
    if (!existing) {
      console.log(`   ✅ Subscription "${subscriptionId}" does not exist - nothing to do.`);
      return { destroyed: subscriptionId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Pub/Sub subscription "${subscriptionId}"`);
      return { destroyed: subscriptionId };
    }

    console.log(`   🔄 Deleting Pub/Sub subscription "${subscriptionId}"...`);
    await gcpFetch(
      PUBSUB_BASE,
      `/v1/projects/${project}/subscriptions/${subscriptionId}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   ✅ Pub/Sub subscription "${subscriptionId}" deleted.`);

    await this.destroySidecars();
    return { destroyed: subscriptionId };
  }
}
