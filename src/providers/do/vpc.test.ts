import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { VPCBuilder } from './vpc.js';
import { Config } from '../../core/config.js';

describe('VPCBuilder Unit Tests', () => {
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('gracefully handles discovery when VPC does not exist', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: { vpcs: [] }
    };

    const builder = new VPCBuilder('my-custom-vpc');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].method, 'GET');
    assert.ok(fetchCalls[0].url.includes('/vpcs'));
  });

  test('discovers VPC successfully when it exists', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: {
        vpcs: [
          {
            id: 'vpc-uuid-111',
            name: 'my-custom-vpc',
            ip_range: '10.10.0.0/16',
            default: false
          }
        ]
      }
    };

    const builder = new VPCBuilder('my-custom-vpc');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.id, 'vpc-uuid-111');

    const resolvedId = await builder.out.id.get();
    const resolvedIpRange = await builder.out.ipRange.get();
    assert.strictEqual(resolvedId, 'vpc-uuid-111');
    assert.strictEqual(resolvedIpRange, '10.10.0.0/16');
  });

  test('dry-run resolves pending outputs and plans creation when VPC does not exist', async () => {
    Config.set({
      dryRun: true,
      providers: {
        do: { token: 'fake-do-token' }
      }
    });

    mockResponses['GET /vpcs'] = {
      status: 200,
      body: { vpcs: [] }
    };

    const builder = new VPCBuilder('my-custom-vpc')
      .region('sfo3')
      .ipRange('10.20.30.0/24')
      .description('Temporary Test VPC');

    const result = await builder.deploy();
    assert.deepStrictEqual(result, { name: 'my-custom-vpc', id: 'PENDING' });

    const resolvedId = await builder.out.id.get();
    const resolvedIpRange = await builder.out.ipRange.get();
    assert.strictEqual(resolvedId, 'PENDING');
    assert.strictEqual(resolvedIpRange, '10.20.30.0/24');

    // No POST writes should be triggered during dry-run
    const writeCalls = fetchCalls.filter(c => c.method === 'POST' || c.method === 'PUT');
    assert.strictEqual(writeCalls.length, 0);
  });

  test('deploys and creates a new VPC successfully', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: { vpcs: [] }
    };
    mockResponses['POST /vpcs'] = {
      status: 201,
      body: {
        vpc: {
          id: 'created-vpc-uuid',
          name: 'new-vpc',
          region: 'nyc3',
          ip_range: '10.50.0.0/16',
          description: 'A brand new VPC'
        }
      }
    };

    const builder = new VPCBuilder('new-vpc')
      .region('nyc3')
      .ipRange('10.50.0.0/16')
      .description('A brand new VPC');

    const result = await builder.deploy();
    assert.deepStrictEqual(result, {
      name: 'new-vpc',
      id: 'created-vpc-uuid',
      ipRange: '10.50.0.0/16'
    });

    const resolvedId = await builder.out.id.get();
    const resolvedIpRange = await builder.out.ipRange.get();
    assert.strictEqual(resolvedId, 'created-vpc-uuid');
    assert.strictEqual(resolvedIpRange, '10.50.0.0/16');

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/vpcs'));
    assert.ok(postCall);
    assert.deepStrictEqual(postCall.body, {
      name: 'new-vpc',
      region: 'nyc3',
      ip_range: '10.50.0.0/16',
      description: 'A brand new VPC'
    });
  });

  test('updates VPC description if it changes', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: {
        vpcs: [
          {
            id: 'vpc-uuid-222',
            name: 'existing-vpc',
            ip_range: '10.10.0.0/16',
            description: 'Old Description',
            default: false
          }
        ]
      }
    };
    mockResponses['PUT /vpcs/vpc-uuid-222'] = {
      status: 200,
      body: {
        vpc: {
          id: 'vpc-uuid-222',
          name: 'existing-vpc',
          ip_range: '10.10.0.0/16',
          description: 'New Description',
          default: false
        }
      }
    };

    const builder = new VPCBuilder('existing-vpc')
      .description('New Description');

    const result = await builder.deploy();
    assert.strictEqual(result.id, 'vpc-uuid-222');

    const putCall = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('/vpcs/vpc-uuid-222'));
    assert.ok(putCall);
    assert.deepStrictEqual(putCall.body, {
      name: 'existing-vpc',
      description: 'New Description'
    });
  });

  test('skips update if description is unchanged', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: {
        vpcs: [
          {
            id: 'vpc-uuid-222',
            name: 'existing-vpc',
            ip_range: '10.10.0.0/16',
            description: 'Same Description',
            default: false
          }
        ]
      }
    };

    const builder = new VPCBuilder('existing-vpc')
      .description('Same Description');

    await builder.deploy();

    const putCalls = fetchCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 0);
  });

  test('deletes custom VPC successfully during destroy', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: {
        vpcs: [
          {
            id: 'vpc-uuid-delete',
            name: 'custom-vpc-to-delete',
            ip_range: '10.10.0.0/16',
            default: false
          }
        ]
      }
    };
    mockResponses['DELETE /vpcs/vpc-uuid-delete'] = {
      status: 204,
      body: {}
    };

    const builder = new VPCBuilder('custom-vpc-to-delete');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: 'custom-vpc-to-delete' });

    const deleteCall = fetchCalls.find(c => c.method === 'DELETE');
    assert.ok(deleteCall);
    assert.ok(deleteCall.url.endsWith('/vpcs/vpc-uuid-delete'));
  });

  test('skips deletion of default VPC networks during destroy', async () => {
    mockResponses['GET /vpcs'] = {
      status: 200,
      body: {
        vpcs: [
          {
            id: 'default-vpc-uuid',
            name: 'default-nyc3',
            ip_range: '10.10.0.0/16',
            default: true
          }
        ]
      }
    };

    const builder = new VPCBuilder('default-nyc3');
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: false });

    // No DELETE requests should be triggered
    const deleteCalls = fetchCalls.filter(c => c.method === 'DELETE');
    assert.strictEqual(deleteCalls.length, 0);
  });
});
