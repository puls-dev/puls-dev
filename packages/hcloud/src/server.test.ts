import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { ServerBuilder } from './server.js';
import { SSHKeyBuilder } from './ssh_key.js';
import { NetworkBuilder } from './network.js';
import { Config } from '@puls-dev/core';
import { OS_IMAGE, LOCATION, SERVER_TYPE } from './types/hcloud.js';

describe('ServerBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
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

    // Default mock response so discovery doesn't fail by default
    mockResponses['GET /servers'] = {
      status: 200,
      body: { servers: [] }
    };

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
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
        json: async () => ({ error: { message: 'Not found' } }),
        text: async () => 'Not found',
      } as Response;
    };

    // Mock readFileSync so tests don't hit the real filesystem for SSH keys
    mock.method(fs, 'readFileSync', () => {
      return 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL... test@example.com';
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('gracefully handles discovery when server does not exist', async () => {
    const builder = new ServerBuilder('my-server');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.includes('/servers?name=my-server'));
  });

  test('discovers server successfully when it exists', async () => {
    mockResponses['GET /servers'] = {
      status: 200,
      body: {
        servers: [
          {
            id: 123,
            name: 'my-server',
            public_net: {
              ipv4: { ip: '1.2.3.4' }
            },
            server_type: { name: 'cx22' },
            image: { name: 'ubuntu-24.04' },
            datacenter: { location: { name: 'nbg1' } }
          }
        ]
      }
    };

    const builder = new ServerBuilder('my-server');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 123);
    assert.strictEqual(await builder.out.ip.get(), '1.2.3.4');
    assert.strictEqual(await builder.out.id.get(), 123);
  });

  test('calculates correct monthly cost', async () => {
    const builder = new ServerBuilder('my-server');
    await (builder as any).discoveryPromise;
    builder.serverType(SERVER_TYPE.CX22);
    assert.strictEqual(builder.getMonthlyCost(), 3.60);

    builder.serverType(SERVER_TYPE.CPX31);
    assert.strictEqual(builder.getMonthlyCost(), 14.80);
  });

  test('creates a server when it does not exist', async () => {
    mockResponses['POST /servers'] = {
      status: 201,
      body: {
        server: {
          id: 456,
          name: 'new-server',
          public_net: { ipv4: { ip: '5.6.7.8' } }
        },
        action: { id: 7890 }
      }
    };
    mockResponses['GET /actions/7890'] = {
      status: 200,
      body: { action: { status: 'success' } }
    };
    mockResponses['GET /servers/456'] = {
      status: 200,
      body: {
        server: {
          id: 456,
          name: 'new-server',
          public_net: { ipv4: { ip: '5.6.7.8' } }
        }
      }
    };

    const builder = new ServerBuilder('new-server')
      .serverType(SERVER_TYPE.CX22)
      .image(OS_IMAGE.UBUNTU_24_04)
      .location(LOCATION.NBG1);

    await builder.deploy();

    assert.strictEqual(await builder.out.id.get(), 456);
    assert.strictEqual(await builder.out.ip.get(), '5.6.7.8');

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/servers'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.name, 'new-server');
    assert.strictEqual(postCall.body.server_type, 'cx22');
    assert.strictEqual(postCall.body.image, 'ubuntu-24.04');
    assert.strictEqual(postCall.body.location, 'nbg1');
  });

  test('detects drift and recreates server', async () => {
    let serverExists = true;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      fetchCalls.push({ url, method, body });

      if (method === 'DELETE' && url.includes('/servers/123')) {
        serverExists = false;
        return {
          ok: true,
          status: 200,
          json: async () => ({})
        } as Response;
      }

      if (method === 'GET' && url.includes('/servers')) {
        if (url.includes('/servers/456')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              server: {
                id: 456,
                name: 'my-server',
                public_net: { ipv4: { ip: '5.6.7.8' } }
              }
            })
          } as Response;
        }

        if (serverExists) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              servers: [
                {
                  id: 123,
                  name: 'my-server',
                  public_net: { ipv4: { ip: '1.2.3.4' } },
                  server_type: { name: 'cpx11' },
                  image: { name: 'ubuntu-22.04' },
                  datacenter: { location: { name: 'nbg1' } }
                }
              ]
            })
          } as Response;
        } else {
          return {
            ok: true,
            status: 200,
            json: async () => ({ servers: [] })
          } as Response;
        }
      }

      if (method === 'POST' && url.includes('/servers')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            server: {
              id: 456,
              name: 'my-server',
              public_net: { ipv4: { ip: '5.6.7.8' } }
            },
            action: { id: 7890 }
          })
        } as Response;
      }

      if (method === 'GET' && url.includes('/actions/7890')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ action: { status: 'success' } })
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Not found' } }),
      } as Response;
    };

    const builder = new ServerBuilder('my-server')
      .serverType(SERVER_TYPE.CX22)
      .image(OS_IMAGE.UBUNTU_24_04)
      .location(LOCATION.NBG1);

    await builder.deploy();

    const deleteCall = fetchCalls.find(c => c.method === 'DELETE' && c.url.includes('/servers/123'));
    assert.ok(deleteCall);

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/servers'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.server_type, 'cx22');
    assert.strictEqual(postCall.body.image, 'ubuntu-24.04');
  });

  test('destroys a server when it exists', async () => {
    mockResponses['GET /servers'] = {
      status: 200,
      body: {
        servers: [
          {
            id: 123,
            name: 'my-server',
            public_net: { ipv4: { ip: '1.2.3.4' } },
            server_type: { name: 'cx22' },
            image: { name: 'ubuntu-24.04' },
            datacenter: { location: { name: 'nbg1' } }
          }
        ]
      }
    };
    mockResponses['DELETE /servers/123'] = {
      status: 200,
      body: {}
    };

    const builder = new ServerBuilder('my-server');
    await builder.destroy();

    const deleteCall = fetchCalls.find(c => c.method === 'DELETE' && c.url.includes('/servers/123'));
    assert.ok(deleteCall);
  });
});
