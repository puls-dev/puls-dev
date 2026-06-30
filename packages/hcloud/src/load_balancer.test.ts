import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LoadBalancerBuilder } from './load_balancer.js';
import { Config } from '@puls-dev/core';

describe('LoadBalancerBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        hcloud: { token: 'fake-hcloud-token', defaultLocation: 'nbg1' }
      }
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: { load_balancers: [] }
    };

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      fetchCalls.push({ url, method, body });

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
        json: async () => ({ error: { message: 'Not found' } }),
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('creates a load balancer when it does not exist', async () => {
    mockResponses['POST /load_balancers'] = {
      status: 201,
      body: {
        load_balancer: {
          id: 9090,
          name: 'web-lb',
          public_net: { ipv4: { ip: '1.2.3.4' } }
        },
        action: { id: 7890 }
      }
    };
    mockResponses['GET /actions/7890'] = {
      status: 200,
      body: { action: { status: 'success' } }
    };

    const lb = new LoadBalancerBuilder('web-lb')
      .type('lb11')
      .location('nbg1')
      .forward(80, 8080, 'http')
      .target(123);

    await lb.deploy();

    assert.strictEqual(await lb.out.id.get(), 9090);
    assert.strictEqual(await lb.out.ip.get(), '1.2.3.4');

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/load_balancers'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.name, 'web-lb');
    assert.strictEqual(postCall.body.load_balancer_type, 'lb11');
    assert.strictEqual(postCall.body.location, 'nbg1');
    assert.strictEqual(postCall.body.services[0].listen_port, 80);
    assert.strictEqual(postCall.body.services[0].destination_port, 8080);
    assert.strictEqual(postCall.body.targets[0].server.id, 123);
  });
});
