import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { ResourceGroupBuilder } from "./resource_group.js";
import { AzureDNSBuilder } from "./dns.js";
import { Config } from "../../core/config.js";

describe("AzureDNSBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        azure: {
          clientId: "fake-id",
          clientSecret: "fake-secret",
          tenantId: "fake-tenant",
          subscriptionId: "fake-sub",
          defaultLocation: "eastus"
        }
      }
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {
      "POST /oauth2/v2.0/token": {
        status: 200,
        body: { access_token: "mock-token", expires_in: 3600 }
      }
    };

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (init?.body) {
        if (typeof init.body === "string") {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        } else {
          body = init.body;
        }
      }
      const headers = init?.headers;

      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses).find(key => {
        const [mMethod, mPath] = key.split(" ");
        return method === mMethod && url.endsWith(mPath);
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
        json: async () => ({ error: { code: "NotFound", message: "Not found" } }),
        text: async () => "Not found",
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("creates hosted zone and adds A and CNAME record sets", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com?api-version=2018-05-01"] = {
      status: 404,
      body: { error: { code: "ZoneNotFound" } }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com?api-version=2018-05-01"] = {
      status: 201,
      body: { id: "zone-id" }
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com/A/@?api-version=2018-05-01"] = {
      status: 200,
      body: {}
    };
    mockResponses["PUT /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com/CNAME/www?api-version=2018-05-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const dns = new AzureDNSBuilder("myzone.com")
      .resourceGroup(rg)
      .pointer("@", "1.2.3.4")
      .cname("www.myzone.com", "myzone.com");

    const result = await dns.deploy();
    assert.deepStrictEqual(result, { zone: "myzone.com", recordsCount: 2 });

    const zonePut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/dnsZones/myzone.com?"));
    const aPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/A/@"));
    const cnamePut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("/CNAME/www"));

    assert.ok(zonePut);
    assert.ok(aPut);
    assert.ok(cnamePut);

    assert.deepStrictEqual(aPut.body.properties.ARecords, [{ ipv4Address: "1.2.3.4" }]);
    assert.deepStrictEqual(cnamePut.body.properties.CNAMERecord, { cname: "myzone.com" });
  });

  test("deletes DNS Zone on destroy", async () => {
    mockResponses["GET /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com?api-version=2018-05-01"] = {
      status: 200,
      body: { id: "zone-id" }
    };
    mockResponses["DELETE /subscriptions/fake-sub/resourceGroups/my-rg/providers/Microsoft.Network/dnsZones/myzone.com?api-version=2018-05-01"] = {
      status: 200,
      body: {}
    };

    const rg = new ResourceGroupBuilder("my-rg");
    const dns = new AzureDNSBuilder("myzone.com").resourceGroup(rg);

    const result = await dns.destroy();
    assert.deepStrictEqual(result, { destroyed: "myzone.com" });

    const deleteCall = fetchCalls.find(c => c.method === "DELETE");
    assert.ok(deleteCall);
  });
});
