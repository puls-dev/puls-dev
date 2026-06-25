import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CertificateBuilder } from './certificate.js';
import { Config } from '@puls-dev/core';

describe('CertificateBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        do: { token: 'fake-do-token' }
      }
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const headers = init?.headers;

      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses).find(key => {
        const [mMethod, mPath] = key.split(' ');
        return method === mMethod && url.includes(mPath);
      });

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
        json: async () => ({ message: 'Not found' }),
        text: async () => 'Not found',
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('gracefully handles discovery when certificate does not exist', async () => {
    mockResponses['GET /certificates'] = {
      status: 200,
      body: { certificates: [] }
    };

    const builder = new CertificateBuilder('example.com');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.endsWith('/certificates?per_page=200'));
  });

  test('discovers certificate successfully when it exists', async () => {
    mockResponses['GET /certificates'] = {
      status: 200,
      body: {
        certificates: [
          { id: 'cert-123', name: 'ssl-example.com', state: 'active' }
        ]
      }
    };

    const builder = new CertificateBuilder('example.com');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 'cert-123');
    assert.strictEqual(discoveryResult.name, 'ssl-example.com');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: 'fake-token' } }
    });

    mockResponses['GET /certificates'] = {
      status: 200,
      body: { certificates: [] }
    };

    const builder = new CertificateBuilder('example.com');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'ssl-example.com');
    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys new certificate when missing', async () => {
    mockResponses['GET /certificates'] = {
      status: 200,
      body: { certificates: [] }
    };
    mockResponses['POST /certificates'] = {
      status: 201,
      body: {
        certificate: { id: 'cert-789', name: 'ssl-example.com', type: 'lets_encrypt' }
      }
    };

    const builder = new CertificateBuilder('example.com');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'cert-789');

    const postCall = fetchCalls.find(c => c.method === 'POST');
    assert.ok(postCall);
    assert.ok(postCall.url.endsWith('/certificates'));
    assert.deepStrictEqual(postCall.body, {
      name: 'ssl-example.com',
      type: 'lets_encrypt',
      dns_names: ['*.example.com', 'example.com']
    });
  });

  test('skips certificate deployment if certificate already exists', async () => {
    mockResponses['GET /certificates'] = {
      status: 200,
      body: {
        certificates: [
          { id: 'cert-123', name: 'ssl-example.com', state: 'active' }
        ]
      }
    };

    const builder = new CertificateBuilder('example.com');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'cert-123');

    // Only GET discovery should have run, no writes
    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });
});
