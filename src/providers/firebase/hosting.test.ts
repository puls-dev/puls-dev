import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseHostingBuilder } from './hosting.js';
import { Config } from '../../core/config.js';

describe('FirebaseHostingBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    // Configure Firebase provider with fake credentials
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
        const resp = mockResponses[matchKey];
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ message: `Endpoint not mocked: ${method} ${url}` }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    // 1. Mock GoogleAuth prototype to completely bypass filesystem SA key loading and OAuth
    mock.method(GoogleAuth.prototype, 'getClient', async () => {
      return {
        getAccessToken: async () => ({ token: 'fake-access-token' })
      };
    });

    // 2. Mock filesystem calls specifically for the test source folder ./dist
    mock.method(fs, 'readdirSync', () => {
      return ['index.html'];
    });

    mock.method(fs, 'statSync', () => {
      return {
        isDirectory: () => false
      };
    });

    mock.method(fs, 'readFileSync', () => {
      return Buffer.from('hello from index.html');
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('gracefully handles discovery when site does not exist', async () => {
    mockResponses['GET /projects/my-project/sites/my-site'] = {
      status: 404,
      body: { error: { message: 'Site not found' } }
    };

    const builder = new FirebaseHostingBuilder('my-site');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    const apiCall = fetchCalls.find(c => c.url.includes('/sites/my-site'));
    assert.ok(apiCall);
    assert.strictEqual(apiCall.method, 'GET');
  });

  test('discovers site successfully when it exists', async () => {
    mockResponses['GET /projects/my-project/sites/my-site'] = {
      status: 200,
      body: { name: 'projects/my-project/sites/my-site', type: 'USER_SITE' }
    };

    const builder = new FirebaseHostingBuilder('my-site');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.name, 'projects/my-project/sites/my-site');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: {
        firebase: { projectId: 'my-project', serviceAccountPath: '/fake/sa.json' }
      }
    });

    mockResponses['GET /projects/my-project/sites/my-site'] = {
      status: 200,
      body: { name: 'projects/my-project/sites/my-site' }
    };

    const builder = new FirebaseHostingBuilder('my-site');
    builder.source('./dist').domain('my-domain.com');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.siteId, 'my-site');
    assert.strictEqual(result.url, 'https://my-domain.com');

    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys new version and creates release when site exists', async () => {
    mockResponses['GET /projects/my-project/sites/my-site'] = {
      status: 200,
      body: { name: 'projects/my-project/sites/my-site' }
    };
    mockResponses['POST /versions'] = {
      status: 200,
      body: { name: 'projects/my-project/sites/my-site/versions/v111' }
    };
    mockResponses['POST /versions/v111:populateFiles'] = {
      status: 200,
      body: {
        uploadUrl: 'https://upload-firebasehosting.googleapis.com/upload/v111',
        uploadRequiredHashes: ['mock-hash-index']
      }
    };
    mockResponses['POST /upload/v111/mock-hash-index'] = {
      status: 200,
      body: {}
    };
    mockResponses['PATCH /versions/v111'] = {
      status: 200,
      body: { status: 'FINALIZED' }
    };
    mockResponses['POST /releases'] = {
      status: 200,
      body: { name: 'projects/my-project/sites/my-site/releases/r222' }
    };

    const builder = new FirebaseHostingBuilder('my-site');
    builder.source('./dist');

    const result = await builder.deploy();
    assert.ok(result);
    assert.strictEqual(result.siteId, 'my-site');
    assert.strictEqual(result.url, 'https://my-site.web.app');

    const createVersionCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/versions'));
    assert.ok(createVersionCall);

    const populateCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/versions/v111:populateFiles'));
    assert.ok(populateCall);
    // Hosting hashes the gzip-compressed content. gzipSync embeds a platform-specific OS byte
    // in the gzip header, so the hash differs between macOS and Linux. Compute it the same way
    // the production code does so the assertion is always correct regardless of platform.
    const expectedHash = createHash('sha256').update(gzipSync(Buffer.from('hello from index.html'))).digest('hex');
    assert.deepStrictEqual(populateCall.body.files, { '/index.html': expectedHash });

    const uploadCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/upload/v111/mock-hash-index'));
    assert.ok(uploadCall);
    assert.strictEqual(uploadCall.headers?.['Authorization'], 'Bearer fake-access-token');

    const patchVersionCall = fetchCalls.find(c => c.method === 'PATCH' && c.url.endsWith('/versions/v111'));
    assert.ok(patchVersionCall);
    assert.deepStrictEqual(patchVersionCall.body, { status: 'FINALIZED' });

    const releaseCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/releases'));
    assert.ok(releaseCall);
  });
});
