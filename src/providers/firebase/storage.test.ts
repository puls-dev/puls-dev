import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseStorageBuilder } from './storage.js';
import { Config } from '../../core/config.js';

describe('FirebaseStorageBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};
  // Real temp file: storage.ts uses a named ESM import that bypasses mock.method on the fs object
  const tmpRulesFile = path.join(os.tmpdir(), 'puls-storage-test.rules');

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
        ok: true, status: 200, json: async () => ({}), text: async () => '{}',
      } as Response;
    };

    mock.method(GoogleAuth.prototype, 'getClient', async () => ({
      getAccessToken: async () => ({ token: 'fake-token' }),
    }));

    fs.writeFileSync(tmpRulesFile, 'service firebase.storage { match /b/{b}/o/{a=**} { allow read; } }');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
    try { fs.unlinkSync(tmpRulesFile); } catch { /* ignore */ }
  });

  test('deploys without writing anything when no rules, cors, or lifecycle configured', async () => {
    const builder = new FirebaseStorageBuilder('my-project.appspot.com');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.bucket, 'my-project.appspot.com');
    assert.strictEqual(result.project, 'my-project');

    const writeCalls = fetchCalls.filter((c) => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys storage rules by creating a ruleset and updating the release', async () => {
    mockResponses['POST /rulesets'] = {
      status: 200,
      body: { name: 'projects/my-project/rulesets/ruleset-abc' },
    };
    mockResponses['PUT /releases/firebase.storage/my-project.appspot.com'] = {
      status: 200,
      body: {},
    };

    const builder = new FirebaseStorageBuilder('my-project.appspot.com');
    builder.rules(tmpRulesFile);

    await builder.deploy();

    const rulesetCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/rulesets'));
    assert.ok(rulesetCall);
    assert.ok(rulesetCall.body.source.files[0].name === 'storage.rules');

    const releaseCall = fetchCalls.find((c) => c.method === 'PUT' && c.url.includes('/releases/'));
    assert.ok(releaseCall);
    assert.ok(releaseCall.body.rulesetName.includes('ruleset-abc'));
  });

  test('deploys CORS configuration via PATCH to GCS API', async () => {
    const builder = new FirebaseStorageBuilder('my-bucket');
    builder.cors([
      { origin: ['https://example.com'], method: ['GET', 'PUT'], maxAge: 7200 },
    ]);

    await builder.deploy();

    const corsCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/b/my-bucket'),
    );
    assert.ok(corsCall);
    assert.ok(Array.isArray(corsCall.body.cors));
    assert.strictEqual(corsCall.body.cors[0].maxAgeSeconds, 7200);
    assert.deepStrictEqual(corsCall.body.cors[0].origin, ['https://example.com']);
  });

  test('deploys lifecycle policy via PATCH to GCS API', async () => {
    const builder = new FirebaseStorageBuilder('my-bucket');
    builder.lifecycle({ deleteAfterDays: 30, matchesPrefix: ['tmp/', 'cache/'] });

    await builder.deploy();

    const lcCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/b/my-bucket'),
    );
    assert.ok(lcCall);
    const rule = lcCall.body.lifecycle.rule[0];
    assert.strictEqual(rule.action.type, 'Delete');
    assert.strictEqual(rule.condition.age, 30);
    assert.deepStrictEqual(rule.condition.matchesPrefix, ['tmp/', 'cache/']);
  });

  test('performs dry-run without any write API calls', async () => {
    Config.set({
      dryRun: true,
      providers: { firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' } },
    });

    const builder = new FirebaseStorageBuilder('my-project.appspot.com');
    builder
      .cors([{ origin: ['*'], method: ['GET'] }])
      .lifecycle({ deleteAfterDays: 90 });

    await builder.deploy();

    const writeCalls = fetchCalls.filter((c) => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('uses project-derived default bucket name when none provided', async () => {
    const builder = new FirebaseStorageBuilder();
    const result = await builder.deploy();

    // Default bucket is projectId.appspot.com
    assert.strictEqual(result.bucket, 'my-project.appspot.com');
  });

  test('destroy returns without making write API calls', async () => {
    const builder = new FirebaseStorageBuilder('my-project.appspot.com');
    const result = await builder.destroy();

    assert.ok(result.destroyed.includes('appspot.com'));

    const writeCalls = fetchCalls.filter((c) => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });
});
