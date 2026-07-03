import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { APIGatewayBuilder } from './apigateway.js';
import { Config } from '@puls-dev/core';

describe('APIGatewayBuilder Unit Tests', () => {
  let originalGwSend: typeof ApiGatewayV2Client.prototype.send;
  let originalLambdaSend: typeof LambdaClient.prototype.send;
  let calls: { commandName: string; input: any }[] = [];
  let gwResponses: Record<string, any> = {};
  let lambdaResponses: Record<string, any> = {};

  function makeLambda(name: string, arn: string) {
    return { name, resolvedArn: arn } as any;
  }

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: 'us-east-1' } } });
    calls = [];
    gwResponses = {};
    lambdaResponses = {};

    originalGwSend = ApiGatewayV2Client.prototype.send;
    ApiGatewayV2Client.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      calls.push({ commandName, input: command.input });
      const handler = gwResponses[commandName];
      if (handler) {
        if (typeof handler === 'function') return handler(command.input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    originalLambdaSend = LambdaClient.prototype.send;
    LambdaClient.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      calls.push({ commandName, input: command.input });
      const handler = lambdaResponses[commandName];
      if (handler) {
        if (typeof handler === 'function') return handler(command.input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  });

  afterEach(() => {
    ApiGatewayV2Client.prototype.send = originalGwSend;
    LambdaClient.prototype.send = originalLambdaSend;
  });

  test('returns null when no matching API is found', async () => {
    gwResponses['GetApisCommand'] = { Items: [] };

    const builder = new APIGatewayBuilder('my-api');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(builder.resolvedId, null);
    assert.strictEqual(builder.resolvedEndpoint, null);
  });

  test('discovers existing API and populates resolvedId and resolvedEndpoint', async () => {
    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://api-123.execute-api.us-east-1.amazonaws.com' }],
    };

    const builder = new APIGatewayBuilder('my-api');
    await (builder as any).discoveryPromise;

    assert.strictEqual(builder.resolvedId, 'api-123');
    assert.strictEqual(builder.resolvedEndpoint, 'https://api-123.execute-api.us-east-1.amazonaws.com');
  });

  test('performs dry-run without creating the API', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    gwResponses['GetApisCommand'] = { Items: [] };

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.route('GET /hello', fn);

    const result = await builder.deploy();

    assert.ok(result.endpoint!.includes('DRYRUN'));
    assert.ok(!calls.some((c) => c.commandName === 'CreateApiCommand'));
    assert.ok(!calls.some((c) => c.commandName === 'CreateStageCommand'));
  });

  test('creates new HTTP API with $default stage when it does not exist', async () => {
    gwResponses['GetApisCommand'] = { Items: [] };
    gwResponses['CreateApiCommand'] = {
      ApiId: 'new-api-id',
      ApiEndpoint: 'https://new-api-id.execute-api.us-east-1.amazonaws.com',
    };
    gwResponses['CreateStageCommand'] = {};
    gwResponses['GetIntegrationsCommand'] = { Items: [] };
    gwResponses['GetRoutesCommand'] = { Items: [] };
    gwResponses['CreateIntegrationCommand'] = { IntegrationId: 'integ-1' };
    gwResponses['CreateRouteCommand'] = {};

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.route('GET /hello', fn);

    const result = await builder.deploy();

    assert.strictEqual(result.id, 'new-api-id');

    const createApiCall = calls.find((c) => c.commandName === 'CreateApiCommand');
    assert.ok(createApiCall);
    assert.strictEqual(createApiCall.input.Name, 'my-api');
    assert.strictEqual(createApiCall.input.ProtocolType, 'HTTP');

    const createStageCall = calls.find((c) => c.commandName === 'CreateStageCommand');
    assert.ok(createStageCall);
    assert.strictEqual(createStageCall.input.StageName, '$default');
    assert.strictEqual(createStageCall.input.AutoDeploy, true);
  });

  test('creates integration and route for each route entry', async () => {
    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://x.execute-api.us-east-1.amazonaws.com' }],
    };
    gwResponses['GetIntegrationsCommand'] = { Items: [] };
    gwResponses['GetRoutesCommand'] = { Items: [] };
    gwResponses['CreateIntegrationCommand'] = { IntegrationId: 'integ-1' };
    gwResponses['CreateRouteCommand'] = {};

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.route('POST /items', fn);

    await builder.deploy();

    const integCall = calls.find((c) => c.commandName === 'CreateIntegrationCommand');
    assert.ok(integCall);
    assert.strictEqual(integCall.input.IntegrationType, 'AWS_PROXY');
    assert.strictEqual(integCall.input.PayloadFormatVersion, '2.0');

    const routeCall = calls.find((c) => c.commandName === 'CreateRouteCommand');
    assert.ok(routeCall);
    assert.strictEqual(routeCall.input.RouteKey, 'POST /items');
    assert.ok(routeCall.input.Target.includes('integ-1'));
  });

  test('reuses existing integration when Lambda ARN already has one', async () => {
    const fnArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn';
    const integUri = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://x.execute-api.us-east-1.amazonaws.com' }],
    };
    gwResponses['GetIntegrationsCommand'] = {
      Items: [{ IntegrationId: 'existing-integ', IntegrationUri: integUri }],
    };
    gwResponses['GetRoutesCommand'] = { Items: [] };
    gwResponses['CreateRouteCommand'] = {};

    const fn = makeLambda('my-fn', fnArn);
    const builder = new APIGatewayBuilder('my-api');
    builder.route('GET /hello', fn);

    await builder.deploy();

    assert.ok(!calls.some((c) => c.commandName === 'CreateIntegrationCommand'));

    const routeCall = calls.find((c) => c.commandName === 'CreateRouteCommand');
    assert.ok(routeCall);
    assert.ok(routeCall.input.Target.includes('existing-integ'));
  });

  test('skips creating route that already exists', async () => {
    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://x.execute-api.us-east-1.amazonaws.com' }],
    };
    gwResponses['GetIntegrationsCommand'] = { Items: [] };
    gwResponses['GetRoutesCommand'] = { Items: [{ RouteKey: 'GET /hello' }] };
    gwResponses['CreateIntegrationCommand'] = { IntegrationId: 'integ-1' };

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.route('GET /hello', fn);

    await builder.deploy();

    assert.ok(!calls.some((c) => c.commandName === 'CreateRouteCommand'));
  });

  test('swallows ResourceConflictException on AddPermission (idempotent)', async () => {
    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://x.execute-api.us-east-1.amazonaws.com' }],
    };
    gwResponses['GetIntegrationsCommand'] = { Items: [] };
    gwResponses['GetRoutesCommand'] = { Items: [] };
    gwResponses['CreateIntegrationCommand'] = { IntegrationId: 'integ-1' };
    gwResponses['CreateRouteCommand'] = {};

    const conflictErr = new Error('Permission already exists');
    conflictErr.name = 'ResourceConflictException';
    lambdaResponses['AddPermissionCommand'] = conflictErr;

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.route('GET /hello', fn);

    const result = await builder.deploy();
    assert.ok(result.endpoint);
  });

  test('proxy() registers ANY /{proxy+} catch-all route', async () => {
    gwResponses['GetApisCommand'] = { Items: [] };
    gwResponses['CreateApiCommand'] = {
      ApiId: 'api-123',
      ApiEndpoint: 'https://api-123.execute-api.us-east-1.amazonaws.com',
    };
    gwResponses['CreateStageCommand'] = {};
    gwResponses['GetIntegrationsCommand'] = { Items: [] };
    gwResponses['GetRoutesCommand'] = { Items: [] };
    gwResponses['CreateIntegrationCommand'] = { IntegrationId: 'integ-1' };
    gwResponses['CreateRouteCommand'] = {};

    const fn = makeLambda('my-fn', 'arn:aws:lambda:us-east-1:123456789012:function:my-fn');
    const builder = new APIGatewayBuilder('my-api');
    builder.proxy(fn);

    await builder.deploy();

    const routeCall = calls.find((c) => c.commandName === 'CreateRouteCommand');
    assert.ok(routeCall);
    assert.strictEqual(routeCall.input.RouteKey, 'ANY /{proxy+}');
  });

  test('destroys existing API', async () => {
    gwResponses['GetApisCommand'] = {
      Items: [{ ApiId: 'api-123', Name: 'my-api', ApiEndpoint: 'https://x.execute-api.us-east-1.amazonaws.com' }],
    };

    const builder = new APIGatewayBuilder('my-api');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-api' });
    const deleteCall = calls.find((c) => c.commandName === 'DeleteApiCommand');
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.ApiId, 'api-123');
  });

  test('skips destroy when API does not exist', async () => {
    gwResponses['GetApisCommand'] = { Items: [] };

    const builder = new APIGatewayBuilder('my-api');
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-api' });
    assert.ok(!calls.some((c) => c.commandName === 'DeleteApiCommand'));
  });
});
