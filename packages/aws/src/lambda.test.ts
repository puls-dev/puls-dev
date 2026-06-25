import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaBuilder } from './lambda.js';
import { Config } from '@puls-dev/core';

describe('LambdaBuilder Unit Tests', () => {
  let originalLambdaSend: typeof LambdaClient.prototype.send;
  let originalIamSend: typeof IAMClient.prototype.send;
  let lambdaCalls: { commandName: string; input: any }[] = [];
  let iamCalls: { commandName: string; input: any }[] = [];
  let mockLambdaResponses: Record<string, any> = {};
  let mockIamResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: 'us-east-1' }
      }
    });

    lambdaCalls = [];
    iamCalls = [];
    mockLambdaResponses = {};
    mockIamResponses = {};

    originalLambdaSend = LambdaClient.prototype.send;
    originalIamSend = IAMClient.prototype.send;

    // Command intercept stubs for Lambda and IAM AWS SDK clients
    LambdaClient.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      lambdaCalls.push({ commandName, input });

      if (mockLambdaResponses[commandName]) {
        const handler = mockLambdaResponses[commandName];
        if (typeof handler === 'function') return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    IAMClient.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      iamCalls.push({ commandName, input });

      if (mockIamResponses[commandName]) {
        const handler = mockIamResponses[commandName];
        if (typeof handler === 'function') return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    // FS Mocking to return a fake zip buffer when reading the code package
    mock.method(fs, 'readFileSync', () => {
      return Buffer.from('mock-zip-binary-payload');
    });
  });

  afterEach(() => {
    LambdaClient.prototype.send = originalLambdaSend;
    IAMClient.prototype.send = originalIamSend;
    mock.restoreAll();
  });

  test('gracefully handles discovery when function does not exist', async () => {
    const notFoundError = new Error('Function not found');
    notFoundError.name = 'ResourceNotFoundException';
    mockLambdaResponses['GetFunctionCommand'] = notFoundError;

    const builder = new LambdaBuilder('my-fn');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(lambdaCalls.length, 1);
    assert.strictEqual(lambdaCalls[0].commandName, 'GetFunctionCommand');
    assert.strictEqual(lambdaCalls[0].input.FunctionName, 'my-fn');
  });

  test('discovers function successfully when it exists', async () => {
    mockLambdaResponses['GetFunctionCommand'] = {
      Configuration: { FunctionName: 'my-fn', FunctionArn: 'arn:aws:lambda:us-east-1:12345:function:my-fn' }
    };

    const builder = new LambdaBuilder('my-fn');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.FunctionName, 'my-fn');
    assert.strictEqual(builder.resolvedArn, 'arn:aws:lambda:us-east-1:12345:function:my-fn');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { aws: { region: 'us-east-1' } }
    });

    const notFoundError = new Error('Function not found');
    notFoundError.name = 'ResourceNotFoundException';
    mockLambdaResponses['GetFunctionCommand'] = notFoundError;

    const builder = new LambdaBuilder('my-fn');
    builder
      .code('my-code.zip')
      .runtime('nodejs20.x')
      .memory(256)
      .env({ DB_HOST: 'localhost' });

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fn');
    assert.strictEqual(result.arn, 'arn:aws:lambda:DRYRUN:000000000000:function:my-fn');

    // Verify only the GET discovery occurred, no IAM or Lambda write commands
    assert.strictEqual(lambdaCalls.filter(c => c.commandName !== 'GetFunctionCommand').length, 0);
    assert.strictEqual(iamCalls.length, 0);
  });

  test('deploys new function, generates IAM execution role, and uploads code', async () => {
    const notFoundError = new Error('Function not found');
    notFoundError.name = 'ResourceNotFoundException';
    mockLambdaResponses['GetFunctionCommand'] = notFoundError;

    // Mock role lookup to report it doesn't exist yet, forcing role generation
    const noRoleError = new Error('Role not found');
    noRoleError.name = 'NoSuchEntityException';
    mockIamResponses['GetRoleCommand'] = noRoleError;
    mockIamResponses['CreateRoleCommand'] = { Role: { Arn: 'arn:aws:iam::12345:role/puls-lambda-my-fn-role' } };
    mockIamResponses['AttachRolePolicyCommand'] = {};

    mockLambdaResponses['CreateFunctionCommand'] = {
      FunctionArn: 'arn:aws:lambda:us-east-1:12345:function:my-fn'
    };

    const builder = new LambdaBuilder('my-fn');
    builder
      .code('my-code.zip')
      .runtime('nodejs20.x')
      .memory(256)
      .timeout(60);

    // Bypass long-running IAM propagation timer during testing
    const originalPromise = global.Promise;
    const mockTimeout = mock.method(global, 'setTimeout', (fn: any) => fn());

    const result = await builder.deploy();
    assert.ok(result);
    assert.strictEqual(result.arn, 'arn:aws:lambda:us-east-1:12345:function:my-fn');

    // Assert IAM execution role was created
    const createRoleCall = iamCalls.find(c => c.commandName === 'CreateRoleCommand');
    assert.ok(createRoleCall);
    assert.strictEqual(createRoleCall.input.RoleName, 'puls-lambda-my-fn-role');

    // Assert policy was attached to role
    const attachCall = iamCalls.find(c => c.commandName === 'AttachRolePolicyCommand');
    assert.ok(attachCall);
    assert.strictEqual(attachCall.input.PolicyArn, 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole');

    // Assert Lambda creation was deployed with zip buffer
    const createFnCall = lambdaCalls.find(c => c.commandName === 'CreateFunctionCommand');
    assert.ok(createFnCall);
    assert.strictEqual(createFnCall.input.FunctionName, 'my-fn');
    assert.strictEqual(createFnCall.input.Runtime, 'nodejs20.x');
    assert.strictEqual(createFnCall.input.MemorySize, 256);
    assert.strictEqual(createFnCall.input.Timeout, 60);
    assert.strictEqual(createFnCall.input.Role, 'arn:aws:iam::12345:role/puls-lambda-my-fn-role');
    assert.deepStrictEqual(createFnCall.input.Code.ZipFile, Buffer.from('mock-zip-binary-payload'));
  });

  test('updates existing function code and configurations correctly', async () => {
    mockLambdaResponses['GetFunctionCommand'] = {
      Configuration: { FunctionName: 'my-fn', FunctionArn: 'arn:aws:lambda:us-east-1:12345:function:my-fn' }
    };
    mockIamResponses['GetRoleCommand'] = { Role: { Arn: 'arn:aws:iam::12345:role/existing-role' } };
    mockLambdaResponses['UpdateFunctionConfigurationCommand'] = {};
    mockLambdaResponses['UpdateFunctionCodeCommand'] = {};

    const builder = new LambdaBuilder('my-fn');
    builder
      .code('new-code.zip')
      .runtime('nodejs22.x')
      .memory(512);

    await builder.deploy();

    // Verify config update was sent
    const configCall = lambdaCalls.find(c => c.commandName === 'UpdateFunctionConfigurationCommand');
    assert.ok(configCall);
    assert.strictEqual(configCall.input.MemorySize, 512);
    assert.strictEqual(configCall.input.Runtime, 'nodejs22.x');

    // Verify code update was sent with new zip buffer
    const codeCall = lambdaCalls.find(c => c.commandName === 'UpdateFunctionCodeCommand');
    assert.ok(codeCall);
    assert.deepStrictEqual(codeCall.input.ZipFile, Buffer.from('mock-zip-binary-payload'));
  });

  test('destroys Lambda successfully', async () => {
    mockLambdaResponses['GetFunctionCommand'] = {
      Configuration: { FunctionName: 'my-fn', FunctionArn: 'arn:aws:lambda:us-east-1:12345:function:my-fn' }
    };
    mockLambdaResponses['DeleteFunctionCommand'] = {};

    const builder = new LambdaBuilder('my-fn');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: 'my-fn' });

    const deleteCall = lambdaCalls.find(c => c.commandName === 'DeleteFunctionCommand');
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.FunctionName, 'my-fn');
  });
});
