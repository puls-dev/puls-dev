import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseRemoteConfigBuilder } from './remoteconfig.js';
import { Config } from '@puls-dev/core';

describe('FirebaseRemoteConfigBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: Record<string, string> }[] = [];
  let mockResponses: Record<string, { status: number; body: any; etag?: string }> = {};

  function matchResponse(method: string, url: string) {
    const key = Object.keys(mockResponses)
      .filter((k) => {
        const [m, path] = k.split(' ');
        return method === m && url.includes(path);
      })
      .sort((a, b) => b.split(' ')[1].length - a.split(' ')[1].length)[0];
    return key ? mockResponses[key] : null;
  }

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: { firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' } },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    // Default GET returns an empty template with an ETag
    mockResponses['GET /remoteConfig'] = {
      status: 200,
      body: { parameters: {}, conditions: [], parameterGroups: {} },
      etag: '"etag-abc123"',
    };

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: any;
      if (init?.body && typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      fetchCalls.push({ url, method, body, headers });

      const resp = matchResponse(method, url);
      const etag = resp?.etag ?? '"etag-xyz"';
      if (resp) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
          headers: { get: (name: string) => (name === 'etag' ? etag : null) },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
        headers: { get: (name: string) => (name === 'etag' ? '"etag-default"' : null) },
      } as unknown as Response;
    };

    mock.method(GoogleAuth.prototype, 'getClient', async () => ({
      getAccessToken: async () => ({ token: 'fake-token' }),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('performs dry-run without any API calls', async () => {
    Config.set({
      dryRun: true,
      providers: { firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' } },
    });

    const builder = new FirebaseRemoteConfigBuilder();
    builder.string('app_name', 'MyApp').bool('dark_mode', true).number('max_items', 50);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.project, 'my-project');
    assert.strictEqual(fetchCalls.length, 0);
  });

  test('publishes string, bool, and number parameters via GET then PUT', async () => {
    const builder = new FirebaseRemoteConfigBuilder();
    builder
      .string('app_name', 'MyApp', 'The application name')
      .bool('dark_mode', true)
      .number('max_items', 50);

    const result = await builder.deploy();

    assert.strictEqual(result.project, 'my-project');

    const getCall = fetchCalls.find((c) => c.method === 'GET');
    assert.ok(getCall);
    assert.ok(getCall.url.includes('/remoteConfig'));

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    assert.ok(putCall.url.includes('/remoteConfig'));

    const params = putCall.body.parameters;
    assert.strictEqual(params.app_name.defaultValue.value, 'MyApp');
    assert.strictEqual(params.app_name.valueType, 'STRING');
    assert.strictEqual(params.app_name.description, 'The application name');
    assert.strictEqual(params.dark_mode.defaultValue.value, 'true');
    assert.strictEqual(params.dark_mode.valueType, 'BOOLEAN');
    assert.strictEqual(params.max_items.defaultValue.value, '50');
    assert.strictEqual(params.max_items.valueType, 'NUMBER');
  });

  test('publishes JSON parameter correctly', async () => {
    const builder = new FirebaseRemoteConfigBuilder();
    builder.json('feature_flags', { newUI: true, betaFeature: false });

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    const parsed = JSON.parse(putCall.body.parameters.feature_flags.defaultValue.value);
    assert.strictEqual(parsed.newUI, true);
    assert.strictEqual(parsed.betaFeature, false);
  });

  test('infers type via param() helper', async () => {
    const builder = new FirebaseRemoteConfigBuilder();
    builder.param('is_enabled', true).param('threshold', 42).param('label', 'hello');

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    const params = putCall.body.parameters;
    assert.strictEqual(params.is_enabled.valueType, 'BOOLEAN');
    assert.strictEqual(params.threshold.valueType, 'NUMBER');
    assert.strictEqual(params.label.valueType, 'STRING');
  });

  test('sends ETag from GET in If-Match header of PUT', async () => {
    mockResponses['GET /remoteConfig'] = {
      status: 200,
      body: { parameters: {}, conditions: [], parameterGroups: {} },
      etag: '"etag-from-server"',
    };

    const builder = new FirebaseRemoteConfigBuilder();
    builder.bool('flag', false);

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    assert.strictEqual(putCall.headers!['If-Match'], '"etag-from-server"');
  });

  test('merges new parameters with existing ones (non-destructive)', async () => {
    mockResponses['GET /remoteConfig'] = {
      status: 200,
      body: {
        parameters: {
          existing_param: { defaultValue: { value: 'keep-me' }, valueType: 'STRING' },
        },
        conditions: [],
        parameterGroups: {},
      },
      etag: '"etag-abc"',
    };

    const builder = new FirebaseRemoteConfigBuilder();
    builder.string('new_param', 'hello');

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    assert.ok(putCall.body.parameters.existing_param, 'existing parameter should be preserved');
    assert.ok(putCall.body.parameters.new_param, 'new parameter should be added');
  });

  test('wires conditionalValues via override()', async () => {
    const builder = new FirebaseRemoteConfigBuilder();
    builder.condition('ios_users', "device.os == 'ios'");
    builder.string('app_name', 'MyApp');
    builder.override('app_name', 'ios_users', 'MyApp for iOS');

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);

    const appNameParam = putCall.body.parameters.app_name;
    assert.ok(appNameParam.conditionalValues);
    assert.strictEqual(appNameParam.conditionalValues.ios_users.value, 'MyApp for iOS');
  });

  test('merges new conditions with existing ones', async () => {
    mockResponses['GET /remoteConfig'] = {
      status: 200,
      body: {
        parameters: {},
        conditions: [{ name: 'existing_cond', expression: "platform == 'android'" }],
        parameterGroups: {},
      },
      etag: '"etag-abc"',
    };

    const builder = new FirebaseRemoteConfigBuilder();
    builder.condition('new_cond', "platform == 'ios'");
    builder.bool('flag', true);

    await builder.deploy();

    const putCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(putCall);
    assert.ok(putCall.body.conditions.some((c: any) => c.name === 'existing_cond'));
    assert.ok(putCall.body.conditions.some((c: any) => c.name === 'new_cond'));
  });

  test('override() throws when param is not defined first', () => {
    const builder = new FirebaseRemoteConfigBuilder();

    assert.throws(
      () => builder.override('undefined_param', 'some_cond', 'value'),
      /param "undefined_param" not defined/,
    );
  });

  test('destroy returns info message without making API calls', async () => {
    const builder = new FirebaseRemoteConfigBuilder();
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'remoteconfig' });
    assert.strictEqual(fetchCalls.length, 0);
  });
});
