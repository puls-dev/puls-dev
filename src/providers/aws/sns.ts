import {
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListTopicsCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from "@aws-sdk/client-sns";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getSNSClient } from "./api.js";

export class SNSTopicBuilder extends BaseBuilder {
  readonly out = {
    arn: new Output<string>(),
  };

  private _displayName?: string;
  private _subscriptions: Array<{ protocol: string; endpoint: string }> = [];
  resolvedArn: string | null = null;
  resolvedDisplayName: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverTopic(name);
  }

  displayName(name: string) {
    this._displayName = name;
    return this;
  }

  subscribe(protocol: "email" | "sms" | "lambda" | "sqs" | "https", endpoint: string) {
    this._subscriptions.push({ protocol, endpoint });
    return this;
  }

  private async discoverTopic(name: string): Promise<any> {
    const sns = getSNSClient();
    try {
      let nextToken: string | undefined;
      do {
        const result = await sns.send(new ListTopicsCommand({ NextToken: nextToken }));
        const match = (result.Topics ?? []).find(
          (t) => t.TopicArn?.split(":").pop() === name
        );
        if (match) {
          this.resolvedArn = match.TopicArn ?? null;
          if (this.resolvedArn) {
            this.out.arn.resolve(this.resolvedArn);
            try {
              const attrsResult = await sns.send(
                new GetTopicAttributesCommand({ TopicArn: this.resolvedArn })
              );
              this.resolvedDisplayName = attrsResult.Attributes?.DisplayName ?? null;
            } catch (err) {
              // Ignore attribute fetch errors (e.g. permission or not found)
            }
          }
          return match;
        }
        nextToken = result.NextToken;
      } while (nextToken);
      return null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const sns = getSNSClient();

    console.log(`\n📢 Finalizing SNS Topic "${this.name}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? "Update" : "Create"} SNS topic "${this.name}"`);
      if (this._displayName) {
        console.log(`      └─ Display Name: ${this._displayName}`);
      }
      for (const sub of this._subscriptions) {
        console.log(`      └─ Subscribe: ${sub.protocol} to ${sub.endpoint}`);
      }
      this.resolvedArn = existing?.TopicArn ?? `arn:aws:sns:us-east-1:000000000000:DRYRUN-${this.name}`;
      this.out.arn.resolve(this.resolvedArn!);
      return { name: this.name, arn: this.resolvedArn };
    }

    const topicAttrs: Record<string, string> = {};
    if (this._displayName) {
      topicAttrs.DisplayName = this._displayName;
    }

    if (!existing) {
      const result = await sns.send(
        new CreateTopicCommand({
          Name: this.name,
          Attributes: topicAttrs,
        })
      );
      this.resolvedArn = result.TopicArn!;
      this.out.arn.resolve(this.resolvedArn!);
      console.log(`🚀 Created SNS Topic "${this.name}" (arn=${this.resolvedArn})`);
    } else {
      this.resolvedArn = existing.TopicArn!;
      this.out.arn.resolve(this.resolvedArn!);

      if (this._displayName && this._displayName !== this.resolvedDisplayName) {
        await sns.send(
          new SetTopicAttributesCommand({
            TopicArn: this.resolvedArn!,
            AttributeName: "DisplayName",
            AttributeValue: this._displayName,
          })
        );
        console.log(`   ✅ Updated SNS topic display name to "${this._displayName}"`);
      } else {
        console.log(`   ✅ SNS topic "${this.name}" already exists`);
      }
    }

    // Sync subscriptions
    const activeSubsResult = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: this.resolvedArn! })
    );
    const activeSubs = activeSubsResult.Subscriptions ?? [];

    // 1. Unsubscribe stale subscriptions
    for (const sub of activeSubs) {
      if (!sub.SubscriptionArn || sub.SubscriptionArn === "PendingConfirmation") continue;
      const isStillWanted = this._subscriptions.some(
        (s) => s.protocol === sub.Protocol && s.endpoint === sub.Endpoint
      );
      if (!isStillWanted) {
        await sns.send(new UnsubscribeCommand({ SubscriptionArn: sub.SubscriptionArn }));
        console.log(`   🧹 Unsubscribed stale subscription: ${sub.Protocol} to ${sub.Endpoint}`);
      }
    }

    // 2. Subscribe new subscriptions
    for (const target of this._subscriptions) {
      const alreadyExists = activeSubs.some(
        (sub) => sub.Protocol === target.protocol && sub.Endpoint === target.endpoint
      );
      if (!alreadyExists) {
        await sns.send(
          new SubscribeCommand({
            TopicArn: this.resolvedArn!,
            Protocol: target.protocol,
            Endpoint: target.endpoint,
          })
        );
        console.log(`   ➕ Subscribed: ${target.protocol} to ${target.endpoint}`);
      }
    }

    await this.deploySidecars();
    return { name: this.name, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying SNS Topic "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ Topic "${this.name}" does not exist - nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete SNS Topic "${this.name}"`);
      return { destroyed: this.name };
    }

    const sns = getSNSClient();
    await sns.send(new DeleteTopicCommand({ TopicArn: this.resolvedArn! }));
    console.log(`   ✅ Deleted SNS Topic "${this.name}"`);
    return { destroyed: this.name };
  }
}
