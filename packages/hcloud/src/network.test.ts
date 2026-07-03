import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { NetworkBuilder } from './network.js';
import { Config } from '@puls-dev/core';

describe('NetworkBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: { hcloud: { token: 'fake-hcloud-token', defaultLocation: 'nbg1' } },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    // Default: no existing networks
    mockResponses['GET /networks'] = { status: 200, body: { networks: [] } };

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      const matchKey = Object.keys(mockResponses)
        .filter((key) => {
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
        json: async () => ({ error: { message: 'Not found' } }),
        text: async () => 'Not found',
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns null when network does not exist', async () => {
    const builder = new NetworkBuilder('my-net');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual((builder as any).networkId, undefined);
  });

  test('discovers existing network, populates networkId, and resolves out.id', async () => {
    mockResponses['GET /networks'] = {
      status: 200,
      body: { networks: [{ id: 5678, name: 'my-net', ip_range: '10.0.0.0/16' }] },
    };

    const builder = new NetworkBuilder('my-net');
    await (builder as any).discoveryPromise;

    assert.strictEqual((builder as any).networkId, 5678);
    assert.strictEqual(await builder.out.id.get(), 5678);
  });

  test('creates new network with specified IP range', async () => {
    mockResponses['POST /networks'] = {
      status: 201,
      body: { network: { id: 5678, name: 'my-net', ip_range: '192.168.0.0/24' } },
    };

    const builder = new NetworkBuilder('my-net').ipRange('192.168.0.0/24');
    await builder.deploy();

    const postCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/networks'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.name, 'my-net');
    assert.strictEqual(postCall.body.ip_range, '192.168.0.0/24');
  });

  test('resolves out.id output after creating a network', async () => {
    mockResponses['POST /networks'] = {
      status: 201,
      body: { network: { id: 5678, name: 'my-net', ip_range: '10.0.0.0/16' } },
    };

    const builder = new NetworkBuilder('my-net');
    await builder.deploy();

    assert.strictEqual(await builder.out.id.get(), 5678);
  });

  test('no-op when existing network IP range matches declared range', async () => {
    mockResponses['GET /networks'] = {
      status: 200,
      body: { networks: [{ id: 5678, name: 'my-net', ip_range: '10.0.0.0/16' }] },
    };

    const builder = new NetworkBuilder('my-net').ipRange('10.0.0.0/16');
    await builder.deploy();

    assert.ok(!fetchCalls.some((c) => c.method === 'POST'));
    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'));
  });

  test('getDiff detects IP range drift', () => {
    const builder = new NetworkBuilder('my-net').ipRange('10.0.0.0/16');
    const diffs = builder.getDiff({ id: 5678, name: 'my-net', ip_range: '192.168.0.0/24' });

    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0].field, 'ipRange');
    assert.strictEqual(diffs[0].declared, '10.0.0.0/16');
    assert.strictEqual(diffs[0].live, '192.168.0.0/24');
  });

  test('deletes and recreates network when IP range has drifted', async () => {
    let networkExists = true;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      if (method === 'DELETE' && url.includes('/networks/5678')) {
        networkExists = false;
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' } as Response;
      }
      if (method === 'GET' && url.includes('/networks')) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            networkExists
              ? { networks: [{ id: 5678, name: 'my-net', ip_range: '192.168.0.0/24' }] }
              : { networks: [] },
          text: async () => '{}',
        } as Response;
      }
      if (method === 'POST' && url.includes('/networks')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ network: { id: 6789, name: 'my-net', ip_range: '10.0.0.0/16' } }),
          text: async () => '{}',
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response;
    };

    const builder = new NetworkBuilder('my-net').ipRange('10.0.0.0/16');
    await builder.deploy();

    const deleteCall = fetchCalls.find((c) => c.method === 'DELETE' && c.url.includes('/networks/5678'));
    assert.ok(deleteCall);

    const postCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/networks'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.ip_range, '10.0.0.0/16');
  });

  test('destroys existing network', async () => {
    mockResponses['GET /networks'] = {
      status: 200,
      body: { networks: [{ id: 5678, name: 'my-net', ip_range: '10.0.0.0/16' }] },
    };
    mockResponses['DELETE /networks/5678'] = { status: 204, body: {} };

    const builder = new NetworkBuilder('my-net');
    await builder.destroy();

    const deleteCall = fetchCalls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/networks/5678'),
    );
    assert.ok(deleteCall);
  });

  test('skips destroy when network does not exist', async () => {
    const builder = new NetworkBuilder('my-net');
    await builder.destroy();

    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'));
  });
});
