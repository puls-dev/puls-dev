import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretsBuilder, resolveEnvVars } from './secrets.js';
import { Config } from '@puls-dev/core';

describe('SecretsBuilder Unit Tests', () => {
  let originalSend: typeof SecretsManagerClient.prototype.send;
  let calls: { commandName: string; input: any }[] = [];
  let mockResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: 'us-east-1' } } });
    calls = [];
    mockResponses = {};

    originalSend = SecretsManagerClient.prototype.send;
    SecretsManagerClient.prototype.send = async function (command: any) {
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
    SecretsManagerClient.prototype.send = originalSend;
  });

  test('returns null when secret does not exist', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;

    const builder = new SecretsBuilder('my-secret');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(builder.resolvedValue, null);
    assert.strictEqual(builder.resolvedArn, null);
  });

  test('fetches existing secret and populates resolvedValue and resolvedArn', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'my-secret-value',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    await (builder as any).discoveryPromise;

    assert.strictEqual(builder.resolvedValue, 'my-secret-value');
    assert.strictEqual(
      builder.resolvedArn,
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    );
  });

  test('awaitValue returns the resolved plaintext value', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'top-secret',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    const value = await builder.awaitValue();

    assert.strictEqual(value, 'top-secret');
  });

  test('awaitValue extracts a JSON key when jsonKey() is configured', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }),
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret').jsonKey('password');
    const value = await builder.awaitValue();

    assert.strictEqual(value, 'hunter2');
  });

  test('performs dry-run without creating or updating secret', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;

    const builder = new SecretsBuilder('my-secret');
    builder.plainText('new-value');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-secret');
    assert.ok(!calls.some((c) => c.commandName === 'CreateSecretCommand'));
    assert.ok(!calls.some((c) => c.commandName === 'PutSecretValueCommand'));
  });

  test('creates new secret with plainText value and description', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;
    mockResponses['CreateSecretCommand'] = {
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    builder.plainText('my-value').description('A test secret');

    const result = await builder.deploy();

    assert.strictEqual(result.name, 'my-secret');
    assert.ok(result.arn);

    const createCall = calls.find((c) => c.commandName === 'CreateSecretCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.Name, 'my-secret');
    assert.strictEqual(createCall.input.SecretString, 'my-value');
    assert.strictEqual(createCall.input.Description, 'A test secret');
  });

  test('creates new secret with keyValue stored as JSON', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;
    mockResponses['CreateSecretCommand'] = {
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    builder.keyValue({ username: 'admin', password: 'hunter2' });

    await builder.deploy();

    const createCall = calls.find((c) => c.commandName === 'CreateSecretCommand');
    assert.ok(createCall);
    const parsed = JSON.parse(createCall.input.SecretString);
    assert.strictEqual(parsed.username, 'admin');
    assert.strictEqual(parsed.password, 'hunter2');
  });

  test('updates existing secret when plainText value differs', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'old-value',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    builder.plainText('new-value');

    await builder.deploy();

    const putCall = calls.find((c) => c.commandName === 'PutSecretValueCommand');
    assert.ok(putCall);
    assert.strictEqual(putCall.input.SecretId, 'my-secret');
    assert.strictEqual(putCall.input.SecretString, 'new-value');
  });

  test('skips update when value has not changed', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'same-value',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    builder.plainText('same-value');

    await builder.deploy();

    assert.ok(!calls.some((c) => c.commandName === 'PutSecretValueCommand'));
  });

  test('destroys secret with 30-day recovery window by default', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'val',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret');
    await (builder as any).discoveryPromise;
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-secret' });

    const deleteCall = calls.find((c) => c.commandName === 'DeleteSecretCommand');
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.SecretId, 'my-secret');
    assert.strictEqual(deleteCall.input.RecoveryWindowInDays, 30);
    assert.ok(!deleteCall.input.ForceDeleteWithoutRecovery);
  });

  test('destroys secret immediately with forceDelete()', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'val',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123',
    };

    const builder = new SecretsBuilder('my-secret').forceDelete();
    await (builder as any).discoveryPromise;
    await builder.destroy();

    const deleteCall = calls.find((c) => c.commandName === 'DeleteSecretCommand');
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.ForceDeleteWithoutRecovery, true);
    assert.ok(!deleteCall.input.RecoveryWindowInDays);
  });

  test('skips destroy when secret does not exist', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;

    const builder = new SecretsBuilder('my-secret');
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-secret' });
    assert.ok(!calls.some((c) => c.commandName === 'DeleteSecretCommand'));
  });

  test('returns null value when no plainText is set for a non-existing secret', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockResponses['GetSecretValueCommand'] = err;

    const builder = new SecretsBuilder('my-secret');
    const result = await builder.deploy();

    assert.strictEqual(result.arn, null);
    assert.strictEqual(result.value, null);
  });

  test('resolveEnvVars resolves SecretsBuilders and passes plain strings through', async () => {
    mockResponses['GetSecretValueCommand'] = {
      SecretString: 'resolved-db-pass',
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-pass-abc123',
    };

    const secretBuilder = new SecretsBuilder('db-pass');
    await (secretBuilder as any).discoveryPromise;

    const resolved = await resolveEnvVars({
      DB_HOST: 'localhost',
      DB_PASS: secretBuilder,
    });

    assert.strictEqual(resolved.DB_HOST, 'localhost');
    assert.strictEqual(resolved.DB_PASS, 'resolved-db-pass');
  });
});
