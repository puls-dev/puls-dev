import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontBuilder } from './cloudfront.js';
import { Config } from '@puls-dev/core';

describe('CloudFrontBuilder Unit Tests', () => {
  let originalSend: typeof CloudFrontClient.prototype.send;
  let calls: { commandName: string; input: any }[] = [];
  let mockResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: 'us-east-1' } } });
    calls = [];
    mockResponses = {};

    originalSend = CloudFrontClient.prototype.send;
    CloudFrontClient.prototype.send = async function (command: any) {
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
    CloudFrontClient.prototype.send = originalSend;
  });

  test('returns null when distribution is not found during discovery', async () => {
    mockResponses['ListDistributionsCommand'] = { DistributionList: { Items: [] } };

    const builder = new CloudFrontBuilder('my-cdn');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(calls[0].commandName, 'ListDistributionsCommand');
  });

  test('discovers existing distribution by comment name', async () => {
    mockResponses['ListDistributionsCommand'] = {
      DistributionList: {
        Items: [
          { Comment: 'my-cdn', Id: 'd-abc123', ARN: 'arn:aws:cloudfront::123:distribution/d-abc123' },
        ],
      },
    };

    const builder = new CloudFrontBuilder('my-cdn');
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(result.Comment, 'my-cdn');
    assert.strictEqual(builder.resolvedId, 'd-abc123');
    assert.strictEqual(builder.resolvedArn, 'arn:aws:cloudfront::123:distribution/d-abc123');
  });

  test('performs dry-run without creating the distribution', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    mockResponses['ListDistributionsCommand'] = { DistributionList: { Items: [] } };

    const builder = new CloudFrontBuilder('my-cdn');
    builder.origin('origin.example.com').dns('cdn.example.com');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-cdn');
    assert.strictEqual(result.id, 'PENDING');

    const writeCalls = calls.filter((c) => c.commandName !== 'ListDistributionsCommand');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('creates new distribution from scratch when not found', async () => {
    mockResponses['ListDistributionsCommand'] = { DistributionList: { Items: [] } };
    mockResponses['CreateDistributionCommand'] = {
      Distribution: {
        Id: 'd-new123',
        ARN: 'arn:aws:cloudfront::123:distribution/d-new123',
        DomainName: 'abcdef.cloudfront.net',
        Status: 'Deployed',
      },
    };
    mockResponses['GetDistributionCommand'] = {
      Distribution: { Status: 'Deployed' },
    };

    const builder = new CloudFrontBuilder('my-cdn');
    builder.origin('origin.example.com');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'd-new123');

    const createCall = calls.find((c) => c.commandName === 'CreateDistributionCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.DistributionConfig.Comment, 'my-cdn');
  });

  test('returns existing distribution without re-creating it', async () => {
    mockResponses['ListDistributionsCommand'] = {
      DistributionList: {
        Items: [{ Comment: 'my-cdn', Id: 'd-abc', ARN: 'arn:aws:cloudfront::123:distribution/d-abc' }],
      },
    };

    const builder = new CloudFrontBuilder('my-cdn');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'd-abc');

    assert.ok(!calls.some((c) => c.commandName === 'CreateDistributionCommand'));
  });

  test('runs cache invalidation on an existing distribution', async () => {
    mockResponses['ListDistributionsCommand'] = {
      DistributionList: {
        Items: [{ Comment: 'my-cdn', Id: 'd-abc', ARN: 'arn:aws:cloudfront::123:distribution/d-abc' }],
      },
    };
    mockResponses['CreateInvalidationCommand'] = { Invalidation: { Id: 'inv-1' } };

    const builder = new CloudFrontBuilder('my-cdn');
    builder.invalidate(['/*', '/index.html']);

    await builder.deploy();

    const invCall = calls.find((c) => c.commandName === 'CreateInvalidationCommand');
    assert.ok(invCall);
    assert.deepStrictEqual(invCall.input.InvalidationBatch.Paths.Items, ['/*', '/index.html']);
    assert.strictEqual(invCall.input.InvalidationBatch.Paths.Quantity, 2);
  });

  test('dry-run prints invalidation plan without executing it', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    mockResponses['ListDistributionsCommand'] = {
      DistributionList: {
        Items: [{ Comment: 'my-cdn', Id: 'd-abc', ARN: 'arn:aws:cloudfront::123:distribution/d-abc' }],
      },
    };

    const builder = new CloudFrontBuilder('my-cdn');
    builder.invalidate(['/assets/*']);

    await builder.deploy();

    assert.ok(!calls.some((c) => c.commandName === 'CreateInvalidationCommand'));
  });

  test('clones config from a reference distribution', async () => {
    mockResponses['ListDistributionsCommand'] = { DistributionList: { Items: [] } };
    mockResponses['GetDistributionConfigCommand'] = {
      DistributionConfig: {
        Comment: 'source-cdn',
        Enabled: true,
        Origins: { Quantity: 1, Items: [{ Id: 'orig-1', DomainName: 'source.example.com' }] },
        DefaultCacheBehavior: {
          TargetOriginId: 'orig-1',
          ViewerProtocolPolicy: 'redirect-to-https',
          CachePolicyId: 'cache-policy-id',
          ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' } },
          MinTTL: 0,
        },
        CallerReference: 'old-ref',
        PriceClass: 'PriceClass_All',
        HttpVersion: 'http2',
      },
    };
    mockResponses['CreateDistributionCommand'] = {
      Distribution: {
        Id: 'd-cloned',
        ARN: 'arn:aws:cloudfront::123:distribution/d-cloned',
        DomainName: 'cloned.cloudfront.net',
        Status: 'Deployed',
      },
    };
    mockResponses['GetDistributionCommand'] = { Distribution: { Status: 'Deployed' } };

    const builder = new CloudFrontBuilder('my-cdn');
    builder.copyFrom('d-source');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'd-cloned');

    const getConfigCall = calls.find((c) => c.commandName === 'GetDistributionConfigCommand');
    assert.ok(getConfigCall);
    assert.strictEqual(getConfigCall.input.Id, 'd-source');

    const createCall = calls.find((c) => c.commandName === 'CreateDistributionCommand');
    assert.ok(createCall);
    // CallerReference from the original clone is deleted; puls inserts a fresh one
    const newRef = createCall.input.DistributionConfig.CallerReference;
    assert.ok(newRef.startsWith('puls-my-cdn-'));
    assert.notStrictEqual(newRef, 'old-ref');
  });
});
