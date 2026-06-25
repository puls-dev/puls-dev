import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { FirewallBuilder } from './firewall.js';
import { Config } from '@puls-dev/core';

describe('FirewallBuilder Unit Tests', () => {
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

  test('gracefully handles discovery when firewall does not exist', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [] }
    };

    const builder = new FirewallBuilder('my-fw');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.endsWith('/firewalls?per_page=200'));
  });

  test('discovers firewall successfully when it exists', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: {
        firewalls: [
          { id: 'fw-123', name: 'my-fw' }
        ]
      }
    };

    const builder = new FirewallBuilder('my-fw');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 'fw-123');
    assert.strictEqual(discoveryResult.name, 'my-fw');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: 'fake-token' } }
    });

    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [] }
    };

    const builder = new FirewallBuilder('my-fw');
    builder
      .ingress('tcp', 80, ['0.0.0.0/0'])
      .egress('tcp', 'all', ['0.0.0.0/0'])
      .attachTo('app-vm');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fw');
    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys new firewall, resolves droplet names, and posts creation request', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [] }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };
    mockResponses['GET /droplets?name=app-vm-2'] = {
      status: 200,
      body: { droplets: [{ id: 222, name: 'app-vm-2' }] }
    };
    mockResponses['POST /firewalls'] = {
      status: 201,
      body: {
        firewall: { id: 'fw-789', name: 'my-fw' }
      }
    };

    const builder = new FirewallBuilder('my-fw');
    builder
      .ingress('tcp', 80, ['0.0.0.0/0'])
      .egress('tcp', 'all', ['0.0.0.0/0'])
      .attachTo('app-vm-1')
      .attachTo('app-vm-2');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fw');

    const postCall = fetchCalls.find(c => c.method === 'POST');
    assert.ok(postCall);
    assert.ok(postCall.url.endsWith('/firewalls'));
    assert.deepStrictEqual(postCall.body, {
      name: 'my-fw',
      inbound_rules: [
        { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0'] } }
      ],
      outbound_rules: [
        { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0'] } }
      ],
      droplet_ids: [111, 222]
    });
  });

  test('updates existing firewall using PUT', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: {
        firewalls: [
          { id: 'fw-123', name: 'my-fw' }
        ]
      }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };
    mockResponses['PUT /firewalls/fw-123'] = {
      status: 200,
      body: {
        firewall: { id: 'fw-123', name: 'my-fw' }
      }
    };

    const builder = new FirewallBuilder('my-fw');
    builder
      .ingress('tcp', 443, ['0.0.0.0/0'])
      .attachTo('app-vm-1');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, 'my-fw');

    const putCall = fetchCalls.find(c => c.method === 'PUT');
    assert.ok(putCall);
    assert.ok(putCall.url.endsWith('/firewalls/fw-123'));
    assert.deepStrictEqual(putCall.body, {
      name: 'my-fw',
      inbound_rules: [
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0'] } }
      ],
      outbound_rules: [],
      droplet_ids: [111]
    });
  });

  test('loads rules from a configuration file (YAML) successfully', async () => {
    mockResponses['GET /firewalls'] = {
      status: 200,
      body: { firewalls: [] }
    };
    mockResponses['GET /droplets?name=app-vm-1'] = {
      status: 200,
      body: { droplets: [{ id: 111, name: 'app-vm-1' }] }
    };
    mockResponses['POST /firewalls'] = {
      status: 201,
      body: { firewall: { id: 'fw-789', name: 'my-fw' } }
    };

    // Mock YAML file creation
    const tempYamlPath = path.resolve(process.cwd(), "temp-firewall-rules.yaml");
    const yamlContent = `
- type: ingress
  protocol: tcp
  port: 80
  sources:
    - 0.0.0.0/0
- type: egress
  protocol: tcp
  port: all
  destinations:
    - 0.0.0.0/0
`;
    fs.writeFileSync(tempYamlPath, yamlContent, "utf-8");

    try {
      const builder = new FirewallBuilder('my-fw')
        .rules("temp-firewall-rules.yaml")
        .attachTo('app-vm-1');

      const result = await builder.deploy();
      assert.ok(result);

      const postCall = fetchCalls.find(c => c.method === 'POST');
      assert.ok(postCall);
      assert.deepStrictEqual(postCall.body, {
        name: 'my-fw',
        inbound_rules: [
          { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0'] } }
        ],
        outbound_rules: [
          { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0'] } }
        ],
        droplet_ids: [111]
      });
    } finally {
      if (fs.existsSync(tempYamlPath)) fs.unlinkSync(tempYamlPath);
    }
  });
});
