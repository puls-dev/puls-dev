import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseAuthBuilder } from './auth.js';
import { Config } from '../../core/config.js';

describe('FirebaseAuthBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

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

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: any;
      if (init?.body && typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      fetchCalls.push({ url, method, body });

      const resp = matchResponse(method, url);
      if (resp) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
      } as Response;
    };

    mock.method(GoogleAuth.prototype, 'getClient', async () => ({
      getAccessToken: async () => ({ token: 'fake-token' }),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('performs dry-run without any API write calls', async () => {
    Config.set({
      dryRun: true,
      providers: { firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' } },
    });

    const builder = new FirebaseAuthBuilder();
    builder.emailPassword().anonymous().phone();

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.project, 'my-project');

    const writeCalls = fetchCalls.filter((c) => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('configures email/password and anonymous sign-in via PATCH', async () => {
    const builder = new FirebaseAuthBuilder();
    builder.emailPassword({ passwordRequired: false }).anonymous();

    await builder.deploy();

    const patchCall = fetchCalls.find((c) => c.method === 'PATCH' && c.url.includes('/config'));
    assert.ok(patchCall);
    assert.ok(patchCall.url.includes('signIn.email'));
    assert.ok(patchCall.url.includes('signIn.anonymous'));
    assert.strictEqual(patchCall.body.signIn.email.enabled, true);
    assert.strictEqual(patchCall.body.signIn.email.passwordRequired, false);
    assert.strictEqual(patchCall.body.signIn.anonymous.enabled, true);
  });

  test('enables phone sign-in via PATCH', async () => {
    const builder = new FirebaseAuthBuilder();
    builder.phone();

    await builder.deploy();

    const patchCall = fetchCalls.find((c) => c.method === 'PATCH' && c.url.includes('/config'));
    assert.ok(patchCall);
    assert.ok(patchCall.url.includes('signIn.phoneNumber'));
    assert.strictEqual(patchCall.body.signIn.phoneNumber.enabled, true);
  });

  test('configures OAuth provider via POST when IDP does not exist', async () => {
    // getIdp returns 404 (not configured yet)
    mockResponses['GET /defaultSupportedIdpConfigs/google.com'] = {
      status: 404,
      body: { error: { message: 'not found' } },
    };

    const builder = new FirebaseAuthBuilder();
    builder.google({ clientId: 'client-id-123', clientSecret: 'secret-456' });

    await builder.deploy();

    const postCall = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.includes('defaultSupportedIdpConfigs'),
    );
    assert.ok(postCall);
    assert.ok(postCall.url.includes('idpId=google.com'));
    assert.strictEqual(postCall.body.clientId, 'client-id-123');
    assert.strictEqual(postCall.body.clientSecret, 'secret-456');
    assert.strictEqual(postCall.body.enabled, true);
  });

  test('updates OAuth provider via PATCH when IDP already exists', async () => {
    mockResponses['GET /defaultSupportedIdpConfigs/github.com'] = {
      status: 200,
      body: { name: 'projects/my-project/defaultSupportedIdpConfigs/github.com', enabled: true },
    };

    const builder = new FirebaseAuthBuilder();
    builder.github({ clientId: 'gh-id', clientSecret: 'gh-secret' });

    await builder.deploy();

    const patchCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('defaultSupportedIdpConfigs/github.com'),
    );
    assert.ok(patchCall);
    assert.strictEqual(patchCall.body.clientId, 'gh-id');
  });

  test('sets authorized domains via PATCH', async () => {
    const builder = new FirebaseAuthBuilder();
    builder.authorizedDomains(['example.com', 'app.example.com', 'localhost']);

    await builder.deploy();

    const patchCall = fetchCalls.find((c) => c.method === 'PATCH' && c.url.includes('/config'));
    assert.ok(patchCall);
    assert.ok(patchCall.url.includes('authorizedDomains'));
    assert.deepStrictEqual(patchCall.body.authorizedDomains, [
      'example.com',
      'app.example.com',
      'localhost',
    ]);
  });

  test('destroy returns without making API calls', async () => {
    const builder = new FirebaseAuthBuilder();
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: 'auth' });
    assert.strictEqual(fetchCalls.filter((c) => c.method !== 'GET').length, 0);
  });
});
