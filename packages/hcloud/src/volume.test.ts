import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { VolumeBuilder } from './volume.js';
import { ServerBuilder } from './server.js';
import { Config } from '@puls-dev/core';

describe('VolumeBuilder Unit Tests', () => {
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

    mockResponses['GET /volumes'] = {
      status: 200,
      body: { volumes: [] }
    };
    mockResponses['GET /servers'] = {
      status: 200,
      body: { servers: [] }
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

  test('creates a volume when it does not exist', async () => {
    mockResponses['POST /volumes'] = {
      status: 201,
      body: {
        volume: {
          id: 8080,
          name: 'db-data',
          size: 20,
          linux_device: '/dev/disk/by-id/scsi-0HC_Volume_8080'
        }
      }
    };

    const volume = new VolumeBuilder('db-data')
      .size(20)
      .location('nbg1');

    await volume.deploy();

    assert.strictEqual(await volume.out.id.get(), 8080);
    assert.strictEqual(await volume.out.linuxDevice.get(), '/dev/disk/by-id/scsi-0HC_Volume_8080');

    const postCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/volumes'));
    assert.ok(postCall);
    assert.strictEqual(postCall.body.name, 'db-data');
    assert.strictEqual(postCall.body.size, 20);
    assert.strictEqual(postCall.body.location, 'nbg1');
  });

  test('resizes a volume when size differs', async () => {
    mockResponses['GET /volumes'] = {
      status: 200,
      body: {
        volumes: [
          {
            id: 8080,
            name: 'db-data',
            size: 10,
            linux_device: '/dev/disk/by-id/scsi-0HC_Volume_8080',
            server: null
          }
        ]
      }
    };
    mockResponses['POST /volumes/8080/actions/resize'] = {
      status: 201,
      body: { action: { id: 7890 } }
    };
    mockResponses['GET /actions/7890'] = {
      status: 200,
      body: { action: { status: 'success' } }
    };

    const volume = new VolumeBuilder('db-data')
      .size(30);

    await volume.deploy();

    const resizeCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/volumes/8080/actions/resize'));
    assert.ok(resizeCall);
    assert.strictEqual(resizeCall.body.size, 30);
  });
});
