import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DropletBuilder, generateDropletTagForProvision } from './droplet.js';
import { Config } from '@puls-dev/core';
import { Output } from '@puls-dev/core';
import { getFileHash } from '@puls-dev/core';

describe('DropletBuilder Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        do: { token: 'fake-do-token', defaultRegion: 'nyc3' }
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
        json: async () => ({ message: 'Not found' }),
        text: async () => 'Not found',
      } as Response;
    };

    // Mock readFileSync so tests don't hit the real filesystem for SSH keys
    mock.method(fs, 'readFileSync', () => {
      return 'ssh-rsa AAAA_FAKE_PUBLIC_KEY test@example.com';
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test('gracefully handles discovery when droplet does not exist', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };

    const builder = new DropletBuilder('my-droplet');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.includes('/droplets?name=my-droplet'));
  });

  test('discovers droplet successfully when it exists', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          {
            id: 123,
            name: 'my-droplet',
            networks: {
              v4: [{ ip_address: '1.2.3.4', type: 'public' }]
            }
          }
        ]
      }
    };

    const builder = new DropletBuilder('my-droplet');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 123);
    assert.strictEqual(discoveryResult.name, 'my-droplet');

    const resolvedId = await builder.out.id.get();
    const resolvedIp = await builder.out.ip.get();
    assert.strictEqual(resolvedId, 123);
    assert.strictEqual(resolvedIp, '1.2.3.4');
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { do: { token: 'fake-token' } }
    });

    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };

    const builder = new DropletBuilder('my-droplet');
    builder
      .region('nyc3')
      .size('s-1vcpu-1gb')
      .sshKey('~/.ssh/id_rsa.pub');

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.region, 'nyc3');
    assert.strictEqual(result.size, 's-1vcpu-1gb');

    const writeCalls = fetchCalls.filter(c => c.method !== 'GET');
    assert.strictEqual(writeCalls.length, 0);

    const resolvedId = await builder.out.id.get();
    const resolvedIp = await builder.out.ip.get();
    assert.strictEqual(resolvedId, -1);
    assert.strictEqual(resolvedIp, '0.0.0.0');
  });

  test('deploys new droplet, registers SSH key, and awaits status: active', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };
    mockResponses['GET /account/keys'] = {
      status: 200,
      body: { ssh_keys: [] } // SSH key does not exist yet
    };
    mockResponses['POST /account/keys'] = {
      status: 201,
      body: { ssh_key: { id: 999, name: 'id_rsa' } }
    };
    mockResponses['POST /droplets'] = {
      status: 202,
      body: { droplet: { id: 12345, name: 'my-droplet' } }
    };

    // First poll returns state: new, second poll returns state: active
    let pollCount = 0;
    mockResponses['GET /droplets/12345'] = {
      status: 200,
      get body() {
        pollCount++;
        if (pollCount === 1) {
          return { droplet: { status: 'new' } };
        }
        return {
          droplet: {
            status: 'active',
            networks: {
              v4: [{ ip_address: '9.9.9.9', type: 'public' }]
            }
          }
        };
      }
    };

    const builder = new DropletBuilder('my-droplet');
    builder
      .region('nyc3')
      .size('s-1vcpu-1gb')
      .sslKey('/path/to/id_rsa.pub');

    // Override the protected waitFor method to poll instantly
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      let done = false;
      while (!done) {
        done = await condition();
      }
    };

    const result = await builder.deploy();
    assert.ok(result);

    const resolvedId = await builder.out.id.get();
    const resolvedIp = await builder.out.ip.get();
    assert.strictEqual(resolvedId, 12345);
    assert.strictEqual(resolvedIp, '9.9.9.9');

    // Assert SSH key registration was posted
    const sshKeyRegisterCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/account/keys'));
    assert.ok(sshKeyRegisterCall);
    assert.deepStrictEqual(sshKeyRegisterCall.body, {
      name: 'id_rsa',
      public_key: 'ssh-rsa AAAA_FAKE_PUBLIC_KEY test@example.com'
    });

    // Assert Droplet creation was posted with registered SSH key ID
    const dropletCreateCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/droplets'));
    assert.ok(dropletCreateCall);
    assert.deepStrictEqual(dropletCreateCall.body.ssh_keys, [999]);
  });

  test('skips update deployment if droplet configuration is up-to-date', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          {
            id: 123,
            name: 'my-droplet',
            size_slug: 's-1vcpu-1gb',
            region: { slug: 'nyc3' },
            networks: {
              v4: [{ ip_address: '1.2.3.4', type: 'public' }]
            }
          }
        ]
      }
    };

    const builder = new DropletBuilder('my-droplet');
    builder
      .region('nyc3')
      .size('s-1vcpu-1gb');

    await builder.deploy();

    // Verify no POST writes or updates
    const writeCalls = fetchCalls.filter(c => c.method === 'POST' || c.method === 'PUT');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('resizes existing droplet when size configuration changes', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          {
            id: 123,
            name: 'my-droplet',
            size_slug: 's-1vcpu-1gb', // different from desired s-2vcpu-2gb
            region: { slug: 'nyc3' },
            networks: {
              v4: [{ ip_address: '1.2.3.4', type: 'public' }]
            }
          }
        ]
      }
    };
    mockResponses['POST /droplets/123/actions'] = {
      status: 201,
      body: { action: { id: 888, status: 'in-progress', type: 'resize' } }
    };

    const builder = new DropletBuilder('my-droplet');
    builder
      .region('nyc3')
      .size('s-2vcpu-2gb');

    await builder.deploy();

    const resizeCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/droplets/123/actions'));
    assert.ok(resizeCall);
    assert.deepStrictEqual(resizeCall.body, {
      type: 'resize',
      size: 's-2vcpu-2gb'
    });
  });

  test('destroys droplet successfully', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          { id: 123, name: 'my-droplet' }
        ]
      }
    };
    mockResponses['DELETE /droplets/123'] = {
      status: 204,
      body: {}
    };

    const builder = new DropletBuilder('my-droplet');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: 'my-droplet' });

    const deleteCall = fetchCalls.find(c => c.method === 'DELETE');
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith('/droplets/123'));
  });

  test('creates droplet inside a VPC', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };
    mockResponses['POST /droplets'] = {
      status: 202,
      body: {
        droplet: {
          id: 12345,
          name: 'vpc-droplet',
          status: 'active',
          networks: {
            v4: [{ ip_address: '10.10.10.5', type: 'public' }]
          }
        }
      }
    };
    mockResponses['GET /droplets/12345'] = {
      status: 200,
      body: {
        droplet: {
          id: 12345,
          name: 'vpc-droplet',
          status: 'active',
          networks: {
            v4: [{ ip_address: '10.10.10.5', type: 'public' }]
          }
        }
      }
    };

    const builder = new DropletBuilder('vpc-droplet');
    builder
      .region('nyc3')
      .size('s-1vcpu-1gb')
      .vpc('my-vpc-uuid-xyz');

    await builder.deploy();

    const dropletCreateCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/droplets'));
    assert.ok(dropletCreateCall);
    assert.strictEqual(dropletCreateCall.body.vpc_uuid, 'my-vpc-uuid-xyz');
  });

  test('creates droplet inside a VPC using an Output value', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };
    mockResponses['POST /droplets'] = {
      status: 202,
      body: {
        droplet: {
          id: 12345,
          name: 'vpc-droplet-output',
          status: 'active',
          networks: {
            v4: [{ ip_address: '10.10.10.6', type: 'public' }]
          }
        }
      }
    };
    mockResponses['GET /droplets/12345'] = {
      status: 200,
      body: {
        droplet: {
          id: 12345,
          name: 'vpc-droplet-output',
          status: 'active',
          networks: {
            v4: [{ ip_address: '10.10.10.6', type: 'public' }]
          }
        }
      }
    };

    const vpcIdOutput = new Output<string>();
    vpcIdOutput.resolve('my-vpc-uuid-abc');

    const builder = new DropletBuilder('vpc-droplet-output');
    builder
      .region('nyc3')
      .size('s-1vcpu-1gb')
      .vpc(vpcIdOutput);

    await builder.deploy();

    const dropletCreateCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/droplets'));
    assert.ok(dropletCreateCall);
    assert.strictEqual(dropletCreateCall.body.vpc_uuid, 'my-vpc-uuid-abc');
  });

  test('deploys new droplet with playbooks and registers initial tags', async () => {
    mockResponses['GET /droplets'] = {
      status: 200,
      body: { droplets: [] }
    };
    mockResponses['POST /droplets'] = {
      status: 202,
      body: {
        droplet: {
          id: 12345,
          name: 'prov-droplet',
          status: 'active',
          networks: {
            v4: [{ ip_address: '1.2.3.4', type: 'public' }]
          }
        }
      }
    };
    mockResponses['GET /droplets/12345'] = {
      status: 200,
      body: {
        droplet: {
          id: 12345,
          name: 'prov-droplet',
          status: 'active',
          networks: {
            v4: [{ ip_address: '1.2.3.4', type: 'public' }]
          }
        }
      }
    };

    const builder = new DropletBuilder('prov-droplet')
      .provision('playbooks/nginx.yaml', 'playbooks/db.yaml');

    const provisionCalls: string[] = [];
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    await builder.deploy();

    // Verify playbooks were executed
    assert.strictEqual(provisionCalls.length, 2);
    assert.strictEqual(provisionCalls[0], 'playbooks/nginx.yaml');
    assert.strictEqual(provisionCalls[1], 'playbooks/db.yaml');

    // Verify initial tags were posted during creation
    const createCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/droplets'));
    assert.ok(createCall);
    const expectedTag1 = generateDropletTagForProvision('playbooks/nginx.yaml', getFileHash('playbooks/nginx.yaml'));
    const expectedTag2 = generateDropletTagForProvision('playbooks/db.yaml', getFileHash('playbooks/db.yaml'));
    assert.deepStrictEqual(createCall.body.tags, [expectedTag1, expectedTag2]);
  });

  test('deploys existing droplet and skips playbooks if hashes match', async () => {
    const nginxTag = generateDropletTagForProvision('playbooks/nginx.yaml', getFileHash('playbooks/nginx.yaml'));
    
    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          {
            id: 12345,
            name: 'existing-prov-droplet',
            status: 'active',
            size_slug: 's-1vcpu-1gb',
            region: { slug: 'nyc3' },
            networks: {
              v4: [{ ip_address: '1.2.3.4', type: 'public' }]
            },
            tags: [nginxTag]
          }
        ]
      }
    };

    const builder = new DropletBuilder('existing-prov-droplet')
      .provision('playbooks/nginx.yaml');

    const provisionCalls: string[] = [];
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    await builder.deploy();

    // No playbooks should run
    assert.strictEqual(provisionCalls.length, 0);

    // No POST/DELETE tags calls
    const writeCalls = fetchCalls.filter(c => c.method === 'POST' && c.url.includes('/tags'));
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys existing droplet and runs playbooks if hash is missing or different, updating tags', async () => {
    const oldNginxTag = generateDropletTagForProvision('playbooks/nginx.yaml', 'abc123123123');

    mockResponses['GET /droplets'] = {
      status: 200,
      body: {
        droplets: [
          {
            id: 12345,
            name: 'existing-diff-droplet',
            status: 'active',
            size_slug: 's-1vcpu-1gb',
            region: { slug: 'nyc3' },
            networks: {
              v4: [{ ip_address: '1.2.3.4', type: 'public' }]
            },
            tags: [oldNginxTag]
          }
        ]
      }
    };
    mockResponses['POST /tags'] = { status: 201, body: {} };
    mockResponses['POST /tags/'] = { status: 200, body: {} };
    mockResponses['DELETE /tags/'] = { status: 204, body: {} };

    const builder = new DropletBuilder('existing-diff-droplet')
      .provision('playbooks/nginx.yaml');

    const provisionCalls: string[] = [];
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      return await condition();
    };
    (builder as any).checkPort = async () => true;
    (builder as any).runProvisioner = async (ip: string, script: string) => {
      provisionCalls.push(script);
    };

    await builder.deploy();

    // Playbook should run
    assert.strictEqual(provisionCalls.length, 1);
    assert.strictEqual(provisionCalls[0], 'playbooks/nginx.yaml');

    // Should have deleted old tag
    const deleteTagCall = fetchCalls.find(c => c.method === 'DELETE' && c.url.includes('/tags/puls-h-nginx-yaml-abc123123123/resources'));
    assert.ok(deleteTagCall);
    assert.deepStrictEqual(deleteTagCall.body, {
      resources: [{ id: '12345', type: 'droplet' }]
    });

    // Should have ensured new tag exists
    const createTagCall = fetchCalls.find(c => c.method === 'POST' && c.url.endsWith('/tags') && c.body?.name?.startsWith('puls-h-nginx-yaml-'));
    assert.ok(createTagCall);

    // Should have tagged the resource
    const newHash = getFileHash('playbooks/nginx.yaml');
    const newTag = generateDropletTagForProvision('playbooks/nginx.yaml', newHash);
    const associateCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes(`/tags/${newTag}/resources`));
    assert.ok(associateCall);
    assert.deepStrictEqual(associateCall.body, {
      resources: [{ id: '12345', type: 'droplet' }]
    });
  });
});
