import {
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  CreateQueueCommand,
  SetQueueAttributesCommand,
  DeleteQueueCommand,
  QueueAttributeName,
} from '@aws-sdk/client-sqs';
import { BaseBuilder } from '../../core/resource.ts';
import { getSQSClient } from './api.ts';

export class SQSBuilder extends BaseBuilder {
  private _fifo: boolean = false;
  private _deduplication: boolean = false;
  private _visibilityTimeout: number = 30;
  private _retentionDays: number = 4;
  private _delaySeconds: number = 0;
  private _dlqName?: string;
  private _dlqMaxReceives: number = 3;
  resolvedUrl: string | null = null;
  resolvedArn: string | null = null;
  resolvedDlqUrl: string | null = null;
  resolvedDlqArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverQueue(name);
  }

  fifo(enabled: boolean = true)         { this._fifo = enabled; return this; }
  deduplication(enabled: boolean = true){ this._deduplication = enabled; return this; }
  timeout(seconds: number)              { this._visibilityTimeout = seconds; return this; }
  retention(days: number)               { this._retentionDays = days; return this; }
  delay(seconds: number)                { this._delaySeconds = seconds; return this; }

  dlq(name: string, maxReceives: number = 3) {
    this._dlqName = name;
    this._dlqMaxReceives = maxReceives;
    return this;
  }

  private queueName(): string {
    const base = this.name;
    if (this._fifo && !base.endsWith('.fifo')) return `${base}.fifo`;
    return base;
  }

  private async discoverQueue(name: string): Promise<any> {
    const sqs = getSQSClient();
    const qName = this._fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name;
    try {
      const urlResult = await sqs.send(new GetQueueUrlCommand({ QueueName: qName }));
      this.resolvedUrl = urlResult.QueueUrl!;

      const attrResult = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.resolvedUrl,
        AttributeNames: [QueueAttributeName.QueueArn],
      }));
      this.resolvedArn = attrResult.Attributes?.QueueArn ?? null;
      return { url: this.resolvedUrl, arn: this.resolvedArn };
    } catch (e: any) {
      if (e.name === 'QueueDoesNotExist' || e.name === 'AWS.SimpleQueueService.NonExistentQueue') return null;
      if (e.name === 'CredentialsProviderError') return null;
      throw e;
    }
  }

  private async ensureQueue(queueName: string, attrs: Record<string, string>): Promise<{ url: string; arn: string }> {
    const sqs = getSQSClient();
    try {
      const urlResult = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      const url = urlResult.QueueUrl!;
      const attrResult = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [QueueAttributeName.QueueArn],
      }));
      return { url, arn: attrResult.Attributes?.QueueArn! };
    } catch (e: any) {
      if (e.name !== 'QueueDoesNotExist' && e.name !== 'AWS.SimpleQueueService.NonExistentQueue') throw e;
    }

    const created = await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: attrs }));
    const url = created.QueueUrl!;
    const attrResult = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [QueueAttributeName.QueueArn],
    }));
    return { url, arn: attrResult.Attributes?.QueueArn! };
  }

  private buildAttributes(redrivePolicy?: string): Record<string, string> {
    const attrs: Record<string, string> = {
      VisibilityTimeout:       String(this._visibilityTimeout),
      MessageRetentionPeriod:  String(this._retentionDays * 86400),
      DelaySeconds:            String(this._delaySeconds),
    };
    if (this._fifo) {
      attrs.FifoQueue = 'true';
      if (this._deduplication) attrs.ContentBasedDeduplication = 'true';
    }
    if (redrivePolicy) attrs.RedrivePolicy = redrivePolicy;
    return attrs;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const queueName = this.queueName();

    console.log(`\n⚡ Finalizing SQS Queue "${queueName}"...`);

    if (dryRun) {
      const dlqName = this._dlqName ? (this._fifo && !this._dlqName.endsWith('.fifo') ? `${this._dlqName}.fifo` : this._dlqName) : undefined;
      console.log(`   📝 [PLAN] ${existing ? 'Update' : 'Create'} queue "${queueName}"`);
      console.log(`      └─ Type: ${this._fifo ? 'FIFO' : 'Standard'}`);
      console.log(`      └─ Visibility timeout: ${this._visibilityTimeout}s | Retention: ${this._retentionDays}d`);
      if (this._delaySeconds) console.log(`      └─ Delivery delay: ${this._delaySeconds}s`);
      if (dlqName) console.log(`      └─ DLQ: ${dlqName} (after ${this._dlqMaxReceives} receives)`);
      this.resolvedUrl = `https://sqs.DRYRUN.amazonaws.com/000000000000/${queueName}`;
      this.resolvedArn = `arn:aws:sqs:DRYRUN:000000000000:${queueName}`;
      return { name: queueName, url: this.resolvedUrl, arn: this.resolvedArn };
    }

    const sqs = getSQSClient();

    // Create DLQ first so we have its ARN for the redrive policy
    let redrivePolicy: string | undefined;
    if (this._dlqName) {
      const dlqQueueName = this._fifo && !this._dlqName.endsWith('.fifo')
        ? `${this._dlqName}.fifo`
        : this._dlqName;

      const dlqAttrs: Record<string, string> = {
        VisibilityTimeout:      String(this._visibilityTimeout),
        MessageRetentionPeriod: String(this._retentionDays * 86400),
      };
      if (this._fifo) dlqAttrs.FifoQueue = 'true';

      const dlq = await this.ensureQueue(dlqQueueName, dlqAttrs);
      this.resolvedDlqUrl = dlq.url;
      this.resolvedDlqArn = dlq.arn;
      redrivePolicy = JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: this._dlqMaxReceives });
      console.log(`   ✅ DLQ ready: ${dlqQueueName}`);
    }

    const attrs = this.buildAttributes(redrivePolicy);

    if (existing) {
      // FIFO queues reject attribute updates that change queue type — only update mutable attrs
      const mutableAttrs: Record<string, string> = {
        VisibilityTimeout:      attrs.VisibilityTimeout,
        MessageRetentionPeriod: attrs.MessageRetentionPeriod,
        DelaySeconds:           attrs.DelaySeconds,
      };
      if (redrivePolicy) mutableAttrs.RedrivePolicy = redrivePolicy;

      await sqs.send(new SetQueueAttributesCommand({
        QueueUrl: this.resolvedUrl!,
        Attributes: mutableAttrs,
      }));
      console.log(`   ✅ Updated queue "${queueName}"`);
    } else {
      const created = await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: attrs }));
      this.resolvedUrl = created.QueueUrl!;

      const arnResult = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.resolvedUrl,
        AttributeNames: [QueueAttributeName.QueueArn],
      }));
      this.resolvedArn = arnResult.Attributes?.QueueArn ?? null;
      console.log(`🚀 Created queue "${queueName}"`);
    }

    console.log(`   🔗 URL: ${this.resolvedUrl}`);
    await this.deploySidecars();
    return { name: queueName, url: this.resolvedUrl, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying SQS Queue "${this.queueName()}"...`);

    if (!existing) {
      console.log(`   ✅ Queue "${this.queueName()}" does not exist — nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete queue "${this.queueName()}"`);
      return { destroyed: this.name };
    }

    await getSQSClient().send(new DeleteQueueCommand({ QueueUrl: this.resolvedUrl! }));
    console.log(`   ✅ Deleted queue "${this.queueName()}"`);
    return { destroyed: this.name };
  }
}
