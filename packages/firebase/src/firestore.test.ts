import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseFirestoreBuilder } from './firestore.js';
import { Config } from '@puls-dev/core';

describe('FirebaseFirestoreBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};
  let rulesPath: string;

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

    // Write a real temp rules file so readFileSync doesn't fail
    rulesPath = join(tmpdir(), 'puls-test-firestore.rules');
    writeFileSync(
      rulesPath,
      'rules version = "2"; service cloud.firestore { match /databases/{db}/documents { allow read, write: if false; } }',
    );

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
    if (existsSync(rulesPath)) unlinkSync(rulesPath);
  });

  test('performs dry-run without any API write calls', async () => {
    Config.set({
      dryRun: true,
      providers: { firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' } },
    });

    const builder = new FirebaseFirestoreBuilder();
    builder.rules(rulesPath);
    builder.index('users', [
      { field: 'createdAt', order: 'DESCENDING' },
      { field: 'name', order: 'ASCENDING' },
    ]);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.project, 'my-project');

    const writeCalls = fetchCalls.filter((c) => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys rules by creating a ruleset and updating the release', async () => {
    mockResponses['GET /releases/cloud.firestore'] = {
      status: 200,
      body: { rulesetName: 'projects/my-project/rulesets/old-ruleset' },
    };
    mockResponses['POST /rulesets'] = {
      status: 200,
      body: { name: 'projects/my-project/rulesets/new-ruleset-id' },
    };
    mockResponses['PUT /releases/cloud.firestore'] = { status: 200, body: {} };

    const builder = new FirebaseFirestoreBuilder();
    builder.rules(rulesPath);

    await builder.deploy();

    const postCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/rulesets'));
    assert.ok(postCall);
    assert.ok(postCall.body.source.files[0].content.includes('service cloud.firestore'));

    const putCall = fetchCalls.find((c) => c.method === 'PUT' && c.url.includes('/releases/'));
    assert.ok(putCall);
    assert.strictEqual(putCall.body.rulesetName, 'projects/my-project/rulesets/new-ruleset-id');
  });

  test('skips rules deployment when no rulesPath is configured', async () => {
    const builder = new FirebaseFirestoreBuilder();

    await builder.deploy();

    assert.ok(!fetchCalls.some((c) => c.url.includes('/rulesets')));
    assert.ok(!fetchCalls.some((c) => c.url.includes('/releases/')));
  });

  test('creates new index when it does not exist', async () => {
    mockResponses['GET /collectionGroups/-/indexes'] = {
      status: 200,
      body: { indexes: [] },
    };
    mockResponses['POST /collectionGroups/orders/indexes'] = {
      status: 200,
      body: { name: 'projects/my-project/databases/(default)/collectionGroups/orders/indexes/mock-idx' },
    };

    const builder = new FirebaseFirestoreBuilder();
    builder.index('orders', [
      { field: 'createdAt', order: 'DESCENDING' },
      { field: 'status', order: 'ASCENDING' },
    ]);

    await builder.deploy();

    const postCall = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.includes('/collectionGroups/orders/indexes'),
    );
    assert.ok(postCall);
    assert.strictEqual(postCall.body.queryScope, 'COLLECTION');
    assert.deepStrictEqual(postCall.body.fields, [
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
    ]);
  });

  test('skips creating an index that already exists', async () => {
    mockResponses['GET /collectionGroups/-/indexes'] = {
      status: 200,
      body: {
        indexes: [
          {
            name: 'projects/my-project/databases/(default)/collectionGroups/orders/indexes/abc',
            fields: [
              { fieldPath: 'createdAt', order: 'DESCENDING' },
              { fieldPath: 'status', order: 'ASCENDING' },
              { fieldPath: '__name__', order: 'DESCENDING' },
            ],
          },
        ],
      },
    };

    const builder = new FirebaseFirestoreBuilder();
    builder.index('orders', [
      { field: 'createdAt', order: 'DESCENDING' },
      { field: 'status', order: 'ASCENDING' },
    ]);

    await builder.deploy();

    assert.ok(!fetchCalls.some((c) => c.method === 'POST' && c.url.includes('/indexes')));
  });

  test('destroy returns without deleting (Firestore cannot be deleted via API)', async () => {
    const builder = new FirebaseFirestoreBuilder();
    const result = await builder.destroy();

    assert.deepStrictEqual(result, { destroyed: '(default)' });
    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'));
  });

  test('uses named database when specified', async () => {
    mockResponses['GET /collectionGroups/-/indexes'] = { status: 200, body: { indexes: [] } };
    mockResponses['POST /collectionGroups/items/indexes'] = { status: 200, body: {} };

    const builder = new FirebaseFirestoreBuilder('my-database');
    builder.index('items', [{ field: 'name', order: 'ASCENDING' }]);

    const result = await builder.deploy();

    assert.strictEqual(result.database, 'my-database');
    assert.ok(fetchCalls.some((c) => c.url.includes('/databases/my-database/')));
  });
});
