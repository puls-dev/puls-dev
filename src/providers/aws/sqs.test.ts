import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SQSBuilder } from './sqs.js';
import { Config } from '../../core/config.js';

describe('SQSBuilder Unit Tests', () => {
  let originalSend: typeof SQSClient.prototype.send;
  let calls: { commandName: string; input: any }[] = [];
  let mockResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: 'us-east-1' } } });
    calls = [];
    mockResponses = {};

    originalSend = SQSClient.prototype.send;
    SQSClient.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      calls.push({ commandName, input: command.input });
      const handler = mockResponses[commandName];
      if (handler) {
        if (typeof handler === 'function') return handler(command.input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  });

  afterEach(() => {
    SQSClient.prototype.send = originalSend;
  });

  test('returns null when queue does not exist', async () => {
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';
    mockResponses['GetQueueUrlCommand'] = err;

    const builder = new SQSBuilder('my-queue');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(calls[0].commandName, 'GetQueueUrlCommand');
  });

  test('discovers existing queue and populates resolvedUrl and resolvedArn', async () => {
    mockResponses['GetQueueUrlCommand'] = {
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    };
    mockResponses['GetQueueAttributesCommand'] = {
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue' },
    };

    const builder = new SQSBuilder('my-queue');
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(builder.resolvedUrl, 'https://sqs.us-east-1.amazonaws.com/123/my-queue');
    assert.strictEqual(builder.resolvedArn, 'arn:aws:sqs:us-east-1:123:my-queue');
  });

  test('performs dry-run without creating the queue', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';
    mockResponses['GetQueueUrlCommand'] = err;

    const builder = new SQSBuilder('my-queue');
    builder.retention(7).timeout(60);

    const result = await builder.deploy();

    assert.ok(result);
    assert.ok(result.url!.includes('DRYRUN'));
    assert.ok(result.arn!.includes('DRYRUN'));

    const writeCalls = calls.filter((c) => c.commandName === 'CreateQueueCommand');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('creates new standard queue with configured attributes', async () => {
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';
    mockResponses['GetQueueUrlCommand'] = err;

    mockResponses['CreateQueueCommand'] = {
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    };
    mockResponses['GetQueueAttributesCommand'] = {
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue' },
    };

    const builder = new SQSBuilder('my-queue');
    builder.retention(7).timeout(45).delay(5);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-queue');
    assert.strictEqual(result.url, 'https://sqs.us-east-1.amazonaws.com/123/my-queue');

    const createCall = calls.find((c) => c.commandName === 'CreateQueueCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.Attributes.VisibilityTimeout, '45');
    assert.strictEqual(createCall.input.Attributes.MessageRetentionPeriod, String(7 * 86400));
    assert.strictEqual(createCall.input.Attributes.DelaySeconds, '5');
  });

  test('creates FIFO queue with .fifo suffix appended automatically', async () => {
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';
    mockResponses['GetQueueUrlCommand'] = err;

    mockResponses['CreateQueueCommand'] = {
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue.fifo',
    };
    mockResponses['GetQueueAttributesCommand'] = {
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue.fifo' },
    };

    const builder = new SQSBuilder('my-queue');
    builder.fifo().deduplication();

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-queue.fifo');

    const createCall = calls.find((c) => c.commandName === 'CreateQueueCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.QueueName, 'my-queue.fifo');
    assert.strictEqual(createCall.input.Attributes.FifoQueue, 'true');
    assert.strictEqual(createCall.input.Attributes.ContentBasedDeduplication, 'true');
  });

  test('creates DLQ before main queue and wires redrive policy', async () => {
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';

    let getUrlCallCount = 0;
    mockResponses['GetQueueUrlCommand'] = (input: any) => {
      getUrlCallCount++;
      if (getUrlCallCount === 1) throw err; // discovery: queue not found
      // DLQ lookup in ensureQueue: also not found
      if (input.QueueName === 'my-dlq') throw err;
      return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/123/${input.QueueName}` };
    };

    mockResponses['CreateQueueCommand'] = (input: any) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/123/${input.QueueName}`,
    });
    mockResponses['GetQueueAttributesCommand'] = (input: any) => ({
      Attributes: { QueueArn: `arn:aws:sqs:us-east-1:123:${input.QueueUrl?.split('/').pop()}` },
    });

    const builder = new SQSBuilder('my-queue');
    builder.dlq('my-dlq', 5);

    const result = await builder.deploy();

    assert.ok(result);

    const dlqCreate = calls.find(
      (c) => c.commandName === 'CreateQueueCommand' && c.input.QueueName === 'my-dlq',
    );
    assert.ok(dlqCreate);

    const mainCreate = calls.find(
      (c) => c.commandName === 'CreateQueueCommand' && c.input.QueueName === 'my-queue',
    );
    assert.ok(mainCreate);

    const redrivePolicy = JSON.parse(mainCreate.input.Attributes.RedrivePolicy);
    assert.strictEqual(redrivePolicy.maxReceiveCount, 5);
    assert.ok(redrivePolicy.deadLetterTargetArn.includes('my-dlq'));
  });

  test('updates mutable attributes on existing queue', async () => {
    mockResponses['GetQueueUrlCommand'] = {
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    };
    mockResponses['GetQueueAttributesCommand'] = {
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue' },
    };

    const builder = new SQSBuilder('my-queue');
    builder.retention(14).timeout(120);

    await builder.deploy();

    const setAttr = calls.find((c) => c.commandName === 'SetQueueAttributesCommand');
    assert.ok(setAttr);
    assert.strictEqual(setAttr.input.Attributes.VisibilityTimeout, '120');
    assert.strictEqual(setAttr.input.Attributes.MessageRetentionPeriod, String(14 * 86400));
  });

  test('deletes queue on destroy', async () => {
    mockResponses['GetQueueUrlCommand'] = {
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    };
    mockResponses['GetQueueAttributesCommand'] = {
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue' },
    };

    const builder = new SQSBuilder('my-queue');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: 'my-queue' });

    const deleteCall = calls.find((c) => c.commandName === 'DeleteQueueCommand');
    assert.ok(deleteCall);
    assert.strictEqual(
      deleteCall.input.QueueUrl,
      'https://sqs.us-east-1.amazonaws.com/123/my-queue',
    );
  });

  test('skips destroy when queue does not exist', async () => {
    const err = new Error('no queue');
    err.name = 'QueueDoesNotExist';
    mockResponses['GetQueueUrlCommand'] = err;

    const builder = new SQSBuilder('my-queue');
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-queue' });
    assert.ok(!calls.some((c) => c.commandName === 'DeleteQueueCommand'));
  });
});
