import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FirewallBuilder } from './firewall.js';
import { Config } from '@puls-dev/core';

describe('FirewallBuilder Unit Tests', () => {
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

    // Default: no existing firewalls
    mockResponses['GET /firewalls'] = { status: 200, body: { firewalls: [] } };

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

  test('returns null when firewall does not exist', async () => {
    const builder = new FirewallBuilder('my-fw');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual((builder as any).firewallId, undefined);
  });

  test('discovers existing firewall and populates firewallId', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [{ id: 9012, name: 'my-fw', rules: [] }] },
    };

    const builder = new FirewallBuilder('my-fw');
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(result.id, 9012);
    assert.strictEqual((builder as any).firewallId, 9012);
  });

  test('performs dry-run without any API write calls', async () => {
    Config.set({
      dryRun: true,
      providers: { hcloud: { token: 'fake-hcloud-token' } },
    });

    const builder = new FirewallBuilder('my-fw');
    builder.ingress('tcp', 80, ['0.0.0.0/0']);
    builder.egress('tcp', 443, ['0.0.0.0/0']);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fw');
    assert.strictEqual(result.rules.length, 2);
    assert.ok(!fetchCalls.some((c) => c.method === 'POST'));
  });

  test('creates new firewall with ingress and egress rules', async () => {
    mockResponses['POST /firewalls'] = {
      status: 201,
      body: { firewall: { id: 9012, name: 'my-fw', rules: [] } },
    };

    const builder = new FirewallBuilder('my-fw');
    builder.ingress('tcp', 22, ['10.0.0.0/8']).egress('tcp', 443, ['0.0.0.0/0']);

    const result = await builder.deploy();

    assert.strictEqual(result.name, 'my-fw');

    const postCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/firewalls'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.name, 'my-fw');
    assert.strictEqual(postCall.body.rules.length, 2);

    const ingressRule = postCall.body.rules.find((r: any) => r.direction === 'in');
    assert.ok(ingressRule);
    assert.strictEqual(ingressRule.protocol, 'tcp');
    assert.strictEqual(ingressRule.port, '22');
    assert.deepStrictEqual(ingressRule.source_ips, ['10.0.0.0/8']);

    const egressRule = postCall.body.rules.find((r: any) => r.direction === 'out');
    assert.ok(egressRule);
    assert.strictEqual(egressRule.protocol, 'tcp');
    assert.deepStrictEqual(egressRule.destination_ips, ['0.0.0.0/0']);
  });

  test('updates existing firewall rules via set_rules action', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [{ id: 9012, name: 'my-fw', rules: [] }] },
    };
    mockResponses['POST /firewalls/9012/actions/set_rules'] = { status: 200, body: { actions: [] } };

    const builder = new FirewallBuilder('my-fw');
    builder.ingress('tcp', 80, ['0.0.0.0/0']);

    await builder.deploy();

    const setRulesCall = fetchCalls.find(
      (c) => c.method === 'POST' && c.url.includes('/firewalls/9012/actions/set_rules'),
    );
    assert.ok(setRulesCall);
    assert.strictEqual(setRulesCall.body.rules.length, 1);
    assert.ok(!fetchCalls.some((c) => c.method === 'POST' && c.url.endsWith('/firewalls')));
  });

  test('resolves server IDs and attaches firewall on create', async () => {
    mockResponses['GET /servers'] = {
      status: 200,
      body: { servers: [{ id: 555, name: 'web-01' }] },
    };
    mockResponses['POST /firewalls'] = {
      status: 201,
      body: { firewall: { id: 9012, name: 'my-fw', rules: [] } },
    };

    const builder = new FirewallBuilder('my-fw');
    builder.ingress('tcp', 443, ['0.0.0.0/0']).attachTo('web-01');

    await builder.deploy();

    const postCall = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/firewalls'));
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body.apply_to, [{ type: 'server', server: { id: 555 } }]);
  });

  test('attaches firewall to resources when updating an existing one', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [{ id: 9012, name: 'my-fw', rules: [] }] },
    };
    mockResponses['GET /servers'] = {
      status: 200,
      body: { servers: [{ id: 555, name: 'web-01' }] },
    };
    mockResponses['POST /firewalls/9012/actions/set_rules'] = { status: 200, body: { actions: [] } };
    mockResponses['POST /firewalls/9012/actions/apply_to_resources'] = {
      status: 200,
      body: { actions: [] },
    };

    const builder = new FirewallBuilder('my-fw');
    builder.ingress('tcp', 80, ['0.0.0.0/0']).attachTo('web-01');

    await builder.deploy();

    const applyCall = fetchCalls.find((c) =>
      c.method === 'POST' && c.url.includes('/actions/apply_to_resources'),
    );
    assert.ok(applyCall);
    assert.deepStrictEqual(applyCall.body.apply_to, [{ type: 'server', server: { id: 555 } }]);
  });

  test('destroys existing firewall', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [{ id: 9012, name: 'my-fw', rules: [] }] },
    };
    mockResponses['DELETE /firewalls/9012'] = { status: 204, body: {} };

    const builder = new FirewallBuilder('my-fw');
    await builder.destroy();

    const deleteCall = fetchCalls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/firewalls/9012'),
    );
    assert.ok(deleteCall);
  });

  test('skips destroy when firewall does not exist', async () => {
    const builder = new FirewallBuilder('my-fw');
    await builder.destroy();

    assert.ok(!fetchCalls.some((c) => c.method === 'DELETE'));
  });
});
