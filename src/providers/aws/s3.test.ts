import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { S3BucketBuilder } from './s3.js';
import { Config } from '../../core/config.js';

describe('S3BucketBuilder Unit Tests', () => {
  let originalSend: typeof S3Client.prototype.send;
  let s3Calls: { commandName: string; input: any }[] = [];
  let mockS3Responses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: 'us-east-1' }
      }
    });

    s3Calls = [];
    mockS3Responses = {};

    originalSend = S3Client.prototype.send;

    // Zero-dependency override on prototype to intercept S3 commands
    S3Client.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      s3Calls.push({ commandName, input });

      if (mockS3Responses[commandName]) {
        const handler = mockS3Responses[commandName];
        if (typeof handler === 'function') {
          return handler(input);
        }
        if (handler instanceof Error) {
          throw handler;
        }
        return handler;
      }
      return {};
    } as any;

    mock.method(fs, 'readFileSync', () => {
      return Buffer.from('hello from s3 site');
    });
  });

  afterEach(() => {
    S3Client.prototype.send = originalSend;
    mock.restoreAll();
  });

  test('gracefully handles discovery when bucket does not exist', async () => {
    const notFoundError = new Error('NoSuchBucket');
    notFoundError.name = 'NotFound';
    (notFoundError as any).$metadata = { httpStatusCode: 404 };
    mockS3Responses['HeadBucketCommand'] = notFoundError;

    const builder = new S3BucketBuilder('my-bucket');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, false);
    assert.strictEqual(s3Calls.length, 1);
    assert.strictEqual(s3Calls[0].commandName, 'HeadBucketCommand');
    assert.strictEqual(s3Calls[0].input.Bucket, 'my-bucket');
  });

  test('discovers bucket successfully when it exists', async () => {
    mockS3Responses['HeadBucketCommand'] = {};

    const builder = new S3BucketBuilder('my-bucket');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, true);
    assert.strictEqual(s3Calls.length, 1);
    assert.strictEqual(s3Calls[0].commandName, 'HeadBucketCommand');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { aws: { region: 'us-east-1' } }
    });

    const notFoundError = new Error('NoSuchBucket');
    notFoundError.name = 'NotFound';
    (notFoundError as any).$metadata = { httpStatusCode: 404 };
    mockS3Responses['HeadBucketCommand'] = notFoundError;

    const builder = new S3BucketBuilder('my-bucket');
    builder.versioning().upload('/path/to/index.html');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-bucket');

    // Asserts HeadBucket was called for discovery, but no CreateBucket or PutObject
    assert.strictEqual(s3Calls.filter(c => c.commandName !== 'HeadBucketCommand').length, 0);
  });

  test('deploys new bucket when missing', async () => {
    const notFoundError = new Error('NoSuchBucket');
    notFoundError.name = 'NotFound';
    (notFoundError as any).$metadata = { httpStatusCode: 404 };
    mockS3Responses['HeadBucketCommand'] = notFoundError;
    mockS3Responses['CreateBucketCommand'] = {};

    const builder = new S3BucketBuilder('my-bucket');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-bucket');

    const createCall = s3Calls.find(c => c.commandName === 'CreateBucketCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.Bucket, 'my-bucket');
  });

  test('deploys static site with public access unblocking, website configuration, and public read policy', async () => {
    const notFoundError = new Error('NoSuchBucket');
    notFoundError.name = 'NotFound';
    (notFoundError as any).$metadata = { httpStatusCode: 404 };
    mockS3Responses['HeadBucketCommand'] = notFoundError;
    mockS3Responses['CreateBucketCommand'] = {};
    mockS3Responses['PutPublicAccessBlockCommand'] = {};
    mockS3Responses['PutBucketWebsiteCommand'] = {};
    mockS3Responses['GetBucketPolicyCommand'] = new Error('NoSuchBucketPolicy');
    mockS3Responses['GetBucketPolicyCommand'].name = 'NoSuchBucketPolicy';
    mockS3Responses['PutBucketPolicyCommand'] = {};

    const builder = new S3BucketBuilder('my-web-bucket');
    builder.staticSite('index.html', 'error.html');

    const result = await builder.deploy();
    assert.ok(result);

    // Verify Public Access Block removal
    const blockCall = s3Calls.find(c => c.commandName === 'PutPublicAccessBlockCommand');
    assert.ok(blockCall);
    assert.deepStrictEqual(blockCall.input.PublicAccessBlockConfiguration, {
      BlockPublicAcls: false,
      IgnorePublicAcls: false,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: false,
    });

    // Verify website configurations
    const websiteCall = s3Calls.find(c => c.commandName === 'PutBucketWebsiteCommand');
    assert.ok(websiteCall);
    assert.deepStrictEqual(websiteCall.input.WebsiteConfiguration, {
      IndexDocument: { Suffix: 'index.html' },
      ErrorDocument: { Key: 'error.html' },
    });

    // Verify public read bucket policy upload
    const policyCall = s3Calls.find(c => c.commandName === 'PutBucketPolicyCommand');
    assert.ok(policyCall);
    const parsedPolicy = JSON.parse(policyCall.input.Policy);
    const stmt = parsedPolicy.Statement.find((s: any) => s.Sid === 'PublicReadGetObject');
    assert.ok(stmt);
    assert.strictEqual(stmt.Effect, 'Allow');
    assert.strictEqual(stmt.Principal, '*');
    assert.strictEqual(stmt.Resource, 'arn:aws:s3:::my-web-bucket/*');
  });

  test('attaches OAC CloudFront policy integration correctly', async () => {
    mockS3Responses['HeadBucketCommand'] = {};
    mockS3Responses['GetBucketPolicyCommand'] = new Error('NoSuchBucketPolicy');
    mockS3Responses['GetBucketPolicyCommand'].name = 'NoSuchBucketPolicy';
    mockS3Responses['PutBucketPolicyCommand'] = {};

    const mockCdn: any = {
      name: 'my-cdn',
      resolvedArn: 'arn:aws:cloudfront::123456789012:distribution/ED12345'
    };

    const builder = new S3BucketBuilder('my-bucket');
    builder.allowFrom(mockCdn);

    await builder.deploy();

    const policyCall = s3Calls.find(c => c.commandName === 'PutBucketPolicyCommand');
    assert.ok(policyCall);
    const parsedPolicy = JSON.parse(policyCall.input.Policy);
    const stmt = parsedPolicy.Statement.find((s: any) => s.Principal.Service === 'cloudfront.amazonaws.com');
    assert.ok(stmt);
    assert.strictEqual(stmt.Effect, 'Allow');
    const sourceArns = stmt.Condition.StringEquals['AWS:SourceArn'];
    assert.deepStrictEqual(sourceArns, ['arn:aws:cloudfront::123456789012:distribution/ED12345']);
  });

  test('uploads local file with mapped content type', async () => {
    mockS3Responses['HeadBucketCommand'] = {};
    mockS3Responses['PutObjectCommand'] = {};

    const builder = new S3BucketBuilder('my-bucket');
    builder.upload('/path/to/my-page.html');

    await builder.deploy();

    const uploadCall = s3Calls.find(c => c.commandName === 'PutObjectCommand');
    assert.ok(uploadCall);
    assert.strictEqual(uploadCall.input.Bucket, 'my-bucket');
    assert.strictEqual(uploadCall.input.Key, 'my-page.html');
    assert.strictEqual(uploadCall.input.ContentType, 'text/html');
    assert.deepStrictEqual(uploadCall.input.Body, Buffer.from('hello from s3 site'));
  });
});
