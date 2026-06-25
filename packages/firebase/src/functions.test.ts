import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import cp from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseFunctionsBuilder } from './functions.js';
import { Config } from '@puls-dev/core';

describe('FirebaseFunctionsBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        firebase: {
          projectId: 'my-project',
          serviceAccountPath: '/fake/sa.json'
        }
      }
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      
      let body: any;
      if (init?.body) {
        if (typeof init.body === 'string') {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        } else {
          body = '[Binary/Buffer Body]';
        }
      }

      const headers = init?.headers;
      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses)
        .filter(key => {
          const [mMethod, mPath] = key.split(' ');
          return method === mMethod && url.includes(mPath);
        })
        .sort((a, b) => b.split(' ')[1].length - a.split(' ')[1].length)[0];

      if (matchKey) {
        let resp = mockResponses[matchKey];
        if (typeof resp === 'function') {
          resp = (resp as Function)();
        }
        const status = resp.status;
        const body = resp.body;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { message: `Endpoint not mocked: ${method} ${url}` } }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    // 1. Mock GoogleAuth prototype to completely bypass filesystem SA key loading and OAuth
    mock.method(GoogleAuth.prototype, 'getClient', async () => {
      return {
        getAccessToken: async () => ({ token: 'fake-access-token' })
      };
    });

    // 2. Mock filesystem / subprocesses to prevent real zip generation
    mock.method(fs, 'mkdtempSync', () => '/fake/tmp/puls-fn-123');
    mock.method(fs, 'readFileSync', () => Buffer.from('mock-zip-bytes'));
    mock.method(cp, 'execSync', () => Buffer.from('mock-zip-stdout'));

    // 3. Fast-forward setTimeout to bypass poll timers
    mock.method(global, 'setTimeout', (fn: any) => fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('gracefully handles discovery when function does not exist', async () => {
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 404,
      body: { error: { message: 'Function not found' } }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    const apiCall = fetchCalls.find(c => c.url.includes('/functions/my-fn'));
    assert.ok(apiCall);
    assert.strictEqual(apiCall.method, 'GET');
  });

  test('discovers function successfully when it exists', async () => {
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 200,
      body: {
        name: 'projects/my-project/locations/us-central1/functions/my-fn',
        state: 'ACTIVE',
        serviceConfig: { uri: 'https://my-fn-live-url' }
      }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.name, 'projects/my-project/locations/us-central1/functions/my-fn');
    assert.strictEqual(discoveryResult.state, 'ACTIVE');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: {
        firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' }
      }
    });

    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 404,
      body: { error: { message: 'Function not found' } }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    builder
      .source('./src')
      .entryPoint('main')
      .runtime('nodejs22')
      .region('us-central1')
      .memory('512M')
      .timeout(120)
      .maxInstances(50)
      .minInstances(2)
      .env({ MY_VAR: 'value' });

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fn');
    assert.strictEqual(result.project, 'my-project');
    assert.strictEqual(result.region, 'us-central1');

    // No write calls (POST, PUT, PATCH, DELETE) should be made
    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys new function when missing, performing upload and polling', async () => {
    let getCallCount = 0;
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = (() => {
      getCallCount++;
      if (getCallCount === 1) {
        return {
          status: 404,
          body: { error: { message: 'Function not found' } }
        };
      }
      return {
        status: 200,
        body: {
          name: 'projects/my-project/locations/us-central1/functions/my-fn',
          serviceConfig: { uri: 'https://live-uri.net' }
        }
      };
    }) as any;

    mockResponses['POST /functions:generateUploadUrl'] = {
      status: 200,
      body: {
        uploadUrl: 'https://upload-gcs.googleapis.com/upload-my-zip',
        storageSource: { bucket: 'my-bucket', object: 'my-zip' }
      }
    };

    mockResponses['PUT /upload-my-zip'] = {
      status: 200,
      body: {}
    };

    mockResponses['POST /functions?functionId=my-fn'] = {
      status: 200,
      body: { name: 'projects/my-project/locations/us-central1/operations/op-create-123' }
    };

    mockResponses['GET /operations/op-create-123'] = {
      status: 200,
      body: { done: true }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    builder
      .source('./src')
      .entryPoint('main')
      .env({ API_KEY: 'secret' });

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fn');
    assert.strictEqual(result.url, 'https://live-uri.net');
    assert.strictEqual(result.project, 'my-project');
    assert.strictEqual(result.region, 'us-central1');

    // Assert generateUploadUrl was called
    const uploadUrlCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/functions:generateUploadUrl'));
    assert.ok(uploadUrlCall);

    // Assert zip upload call was sent via PUT to the generated upload URL
    const uploadCall = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('/upload-my-zip'));
    assert.ok(uploadCall);
    assert.strictEqual(uploadCall.body, '[Binary/Buffer Body]');

    // Assert POST create function was called with configuration
    const createCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/functions?functionId=my-fn'));
    assert.ok(createCall);
    assert.strictEqual(createCall.body.buildConfig.entryPoint, 'main');
    assert.deepStrictEqual(createCall.body.buildConfig.environmentVariables, { API_KEY: 'secret' });
    assert.strictEqual(createCall.body.serviceConfig.availableMemory, '256M');

    // Assert polling call was sent
    const pollCall = fetchCalls.find(c => c.method === 'GET' && c.url.endsWith('/operations/op-create-123'));
    assert.ok(pollCall);
  });

  test('updates existing function code and configurations correctly', async () => {
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 200,
      body: {
        name: 'projects/my-project/locations/us-central1/functions/my-fn',
        state: 'ACTIVE',
        serviceConfig: { uri: 'https://my-fn-live-url' }
      }
    };

    mockResponses['POST /functions:generateUploadUrl'] = {
      status: 200,
      body: {
        uploadUrl: 'https://upload-gcs.googleapis.com/upload-my-zip',
        storageSource: { bucket: 'my-bucket', object: 'my-zip' }
      }
    };

    mockResponses['PUT /upload-my-zip'] = {
      status: 200,
      body: {}
    };

    mockResponses['PATCH /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 200,
      body: { name: 'projects/my-project/locations/us-central1/operations/op-update-456' }
    };

    mockResponses['GET /operations/op-update-456'] = {
      status: 200,
      body: { done: true }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    builder
      .source('./src')
      .entryPoint('updatedMain')
      .runtime('nodejs22')
      .memory('512M');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fn');

    // Assert PATCH call was made
    const patchCall = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('/functions/my-fn'));
    assert.ok(patchCall);
    assert.ok(patchCall.url.includes('updateMask='));
    assert.strictEqual(patchCall.body.buildConfig.entryPoint, 'updatedMain');
    assert.strictEqual(patchCall.body.buildConfig.runtime, 'nodejs22');
    assert.strictEqual(patchCall.body.serviceConfig.availableMemory, '512M');

    // Assert polling occurred
    const pollCall = fetchCalls.find(c => c.method === 'GET' && c.url.endsWith('/operations/op-update-456'));
    assert.ok(pollCall);
  });

  test('destroys existing function successfully', async () => {
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 200,
      body: {
        name: 'projects/my-project/locations/us-central1/functions/my-fn',
        state: 'ACTIVE'
      }
    };

    mockResponses['DELETE /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 200,
      body: { name: 'projects/my-project/locations/us-central1/operations/op-delete-789' }
    };

    mockResponses['GET /operations/op-delete-789'] = {
      status: 200,
      body: { done: true }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-fn' });

    // Assert DELETE was called
    const deleteCall = fetchCalls.find(c => c.method === 'DELETE' && c.url.includes('/functions/my-fn'));
    assert.ok(deleteCall);

    // Assert polling occurred
    const pollCall = fetchCalls.find(c => c.method === 'GET' && c.url.endsWith('/operations/op-delete-789'));
    assert.ok(pollCall);
  });

  test('destroys does nothing when function does not exist', async () => {
    mockResponses['GET /projects/my-project/locations/us-central1/functions/my-fn'] = {
      status: 404,
      body: { error: { message: 'Function not found' } }
    };

    const builder = new FirebaseFunctionsBuilder('my-fn');
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'my-fn' });

    // Verify no DELETE call was placed
    const deleteCall = fetchCalls.find(c => c.method === 'DELETE');
    assert.strictEqual(deleteCall, undefined);
  });
});
