import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LoadBalancerBuilder } from './load_balancer.js';
import { Config } from '@puls-dev/core';

describe('LoadBalancerBuilder Unit Tests', () => {
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
        // Support matching exact endpoint subpath
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

  test('gracefully handles discovery when load balancer does not exist', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: { load_balancers: [] }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.endsWith('/load_balancers?per_page=200'));
  });

  test('discovers load balancer successfully when it exists', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: {
        load_balancers: [
          { id: 'lb-123', name: 'my-lb', region: { slug: 'nyc3' } }
        ]
      }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 'lb-123');
    assert.strictEqual(discoveryResult.name, 'my-lb');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: 'fake-token' } }
    });

    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: { load_balancers: [] }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    builder
      .region('nyc3')
      .targets(['app-vm-1'])
      .forward('http', 80, 'http', 80);

    const result = await builder.deploy();

    assert.ok(result);
    // Discovery GET happened, but no writes (POST, PUT, DELETE)
    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys new load balancer and resolves droplet/certificate details', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: { load_balancers: [] }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };
    mockResponses['GET /droplets?name=app-vm-2'] = {
      status: 200,
      body: { droplets: [{ id: 222, name: 'app-vm-2' }] }
    };
    mockResponses['GET /certificates'] = {
      status: 200,
      body: { certificates: [{ id: 'cert-uuid', name: 'my-cert' }] }
    };
    mockResponses['POST /load_balancers'] = {
      status: 201,
      body: { load_balancer: { id: 'lb-789', name: 'my-lb' } }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    builder
      .region('nyc3')
      .targets(['app-vm-1', 'app-vm-2'])
      .forward('http', 80, 'http', 80)
      .forward('https', 443, 'http', 80, 'my-cert')
      .healthCheck({ protocol: 'http', port: 80, path: '/health', checkIntervalSeconds: 15 })
      .stickySession('cookies', 'lb-cookie', 3600);

    const result = await builder.deploy();
    assert.strictEqual(result.id, 'lb-789');

    // Verify resolving calls
    const postCall = fetchCalls.find(c => c.method === 'POST');
    assert.ok(postCall);
    assert.ok(postCall.url.endsWith('/load_balancers'));
    assert.deepStrictEqual(postCall.body, {
      name: 'my-lb',
      region: 'nyc3',
      forwarding_rules: [
        { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 },
        { entry_protocol: 'https', entry_port: 443, target_protocol: 'http', target_port: 80, certificate_id: 'cert-uuid' }
      ],
      health_check: {
        protocol: 'http',
        port: 80,
        path: '/health',
        check_interval_seconds: 15,
        response_timeout_seconds: 5,
        unhealthy_threshold: 3,
        healthy_threshold: 5
      },
      sticky_sessions: {
        type: 'cookies',
        cookie_name: 'lb-cookie',
        cookie_ttl_seconds: 3600
      },
      droplet_ids: [111, 222]
    });
  });

  test('skips update deployment if load balancer configuration is up-to-date', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: {
        load_balancers: [
          {
            id: 'lb-123',
            name: 'my-lb',
            region: { slug: 'nyc3' },
            droplet_ids: [111],
            forwarding_rules: [
              { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 }
            ],
            health_check: {
              protocol: 'http',
              port: 80,
              path: '/health',
              check_interval_seconds: 15,
              response_timeout_seconds: 5,
              unhealthy_threshold: 3,
              healthy_threshold: 5
            },
            sticky_sessions: {
              type: 'none'
            }
          }
        ]
      }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    builder
      .region('nyc3')
      .targets(['app-vm-1'])
      .forward('http', 80, 'http', 80)
      .healthCheck({ protocol: 'http', port: 80, path: '/health', checkIntervalSeconds: 15 });

    await builder.deploy();

    // Verify no PUT or POST was executed
    const writeCalls = fetchCalls.filter(c => c.method === 'POST' || c.method === 'PUT');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('performs in-place update when load balancer target or rule config changes', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: {
        load_balancers: [
          {
            id: 'lb-123',
            name: 'my-lb',
            region: { slug: 'nyc3' },
            droplet_ids: [111], // Desired is [111, 222]
            forwarding_rules: [
              { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 80 }
            ],
            health_check: {
              protocol: 'http',
              port: 80,
              path: '/'
            },
            sticky_sessions: {
              type: 'none'
            }
          }
        ]
      }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };
    mockResponses['GET /droplets?name=app-vm-2'] = {
      status: 200,
      body: { droplets: [{ id: 222, name: 'app-vm-2' }] }
    };
    mockResponses['PUT /load_balancers/lb-123'] = {
      status: 200,
      body: { load_balancer: { id: 'lb-123', name: 'my-lb' } }
    };

    const builder = new LoadBalancerBuilder('my-lb');
    builder
      .region('nyc3')
      .targets(['app-vm-1', 'app-vm-2'])
      .forward('http', 80, 'http', 80);

    await builder.deploy();

    const putCall = fetchCalls.find(c => c.method === 'PUT');
    assert.ok(putCall);
    assert.ok(putCall.url.endsWith('/load_balancers/lb-123'));
    assert.deepStrictEqual(putCall.body.droplet_ids, [111, 222]);
  });

  test('destroys load balancer successfully', async () => {
    mockResponses['GET /load_balancers'] = {
      status: 200,
      body: {
        load_balancers: [
          { id: 'lb-123', name: 'my-lb' }
        ]
      }
    };
    mockResponses['DELETE /load_balancers/lb-123'] = {
      status: 204,
      body: {}
    };

    const builder = new LoadBalancerBuilder('my-lb');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: 'my-lb' });

    const deleteCall = fetchCalls.find(c => c.method === 'DELETE');
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith('/load_balancers/lb-123'));
  });
});
