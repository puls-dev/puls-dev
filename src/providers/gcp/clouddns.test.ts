import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPCloudDNSZoneBuilder } from "./clouddns.js";
import { Config } from "../../core/config.js";
import { Output } from "../../core/output.js";

describe("GCPCloudDNSZoneBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any; headers?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
          region: "us-central1",
        },
      },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

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
          body = "[Binary/Buffer Body]";
        }
      }

      const headers = init?.headers;
      fetchCalls.push({ url, method, body, headers });

      const matchKey = Object.keys(mockResponses)
        .filter((key) => {
          const [mMethod, mPath] = key.split(" ");
          return method === mMethod && url.includes(mPath);
        })
        .sort((a, b) => b.split(" ")[1].length - a.split(" ")[1].length)[0];

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
        json: async () => ({ error: { message: `Endpoint not mocked: ${method} ${url}` } }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    mock.method(GoogleAuth.prototype, "getClient", async () => {
      return {
        getAccessToken: async () => ({ token: "fake-gcp-token" }),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("initializes names and normalizes zone ID correctly", () => {
    const builder = new GCPCloudDNSZoneBuilder("My-Awesome-Domain.com.");
    assert.strictEqual(builder.cleanZoneName, "my-awesome-domain.com.");
    assert.strictEqual(builder.zoneId, "my-awesome-domain-com");
  });

  test("runs in dry-run mode safely and logs plans without modifying resources", async () => {
    Config.set({
      dryRun: true,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
        },
      },
    });

    mockResponses["GET /managedZones/dryrun-com"] = {
      status: 404,
      body: { error: { message: "Not found" } },
    };

    const builder = new GCPCloudDNSZoneBuilder("dryrun.com")
      .record("www", "A", "1.2.3.4")
      .record("api", "CNAME", "api-backend.com")
      .record("@", "TXT", "v=spf1 include:_spf.google.com ~all");

    const result = await builder.deploy();
    assert.strictEqual(result.zone, "dryrun.com");
    assert.strictEqual(result.id, "dryrun-com");
    assert.strictEqual(result.records.length, 3);

    // Verify dry-run outputs are correct and no write calls are sent
    const writeCalls = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writeCalls.length, 0);

    const wwwRec = result.records.find((r) => r.name === "www.dryrun.com.");
    assert.ok(wwwRec);
    assert.strictEqual(wwwRec.type, "A");
    assert.deepStrictEqual(wwwRec.rrdatas, ["1.2.3.4"]);

    const txtRec = result.records.find((r) => r.name === "dryrun.com.");
    assert.ok(txtRec);
    assert.strictEqual(txtRec.type, "TXT");
    assert.deepStrictEqual(txtRec.rrdatas, ['"v=spf1 include:_spf.google.com ~all"']); // Auto-quoted!
  });

  test("creates a new managed zone when missing and submits records", async () => {
    // 1. Zone doesn't exist yet
    mockResponses["GET /managedZones/new-zone-com"] = {
      status: 404,
      body: { error: { message: "Not found" } },
    };

    // 2. Mock Managed Zone Creation POST
    mockResponses["POST /managedZones"] = {
      status: 200,
      body: { name: "new-zone-com", dnsName: "new-zone.com." },
    };

    // 3. rrsets GET returns empty
    mockResponses["GET /managedZones/new-zone-com/rrsets"] = {
      status: 200,
      body: { rrsets: [] },
    };

    // 4. changes POST
    mockResponses["POST /managedZones/new-zone-com/changes"] = {
      status: 200,
      body: { status: "pending" },
    };

    const builder = new GCPCloudDNSZoneBuilder("new-zone.com")
      .record("www", "CNAME", "lb.google.com")
      .record("db", "A", "10.0.0.5", 60);

    const result = await builder.deploy();
    assert.strictEqual(result.id, "new-zone-com");

    // Verify Managed Zone creation POST
    const createZoneCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/managedZones"));
    assert.ok(createZoneCall);
    assert.strictEqual(createZoneCall.body.name, "new-zone-com");
    assert.strictEqual(createZoneCall.body.dnsName, "new-zone.com.");

    // Verify record changes POST
    const changeCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/changes"));
    assert.ok(changeCall);
    assert.strictEqual(changeCall.body.additions.length, 2);
    assert.strictEqual(changeCall.body.deletions.length, 0);

    const cnameAdd = changeCall.body.additions.find((a: any) => a.type === "CNAME");
    assert.ok(cnameAdd);
    assert.strictEqual(cnameAdd.name, "www.new-zone.com.");
    assert.deepStrictEqual(cnameAdd.rrdatas, ["lb.google.com."]); // Trailing dot auto-appended!
  });

  test("skips identical record sets, and transactionally updates out-of-date records", async () => {
    // 1. Zone exists
    mockResponses["GET /managedZones/sync-zone-com"] = {
      status: 200,
      body: { name: "sync-zone-com" },
    };

    // 2. rrsets GET returns existing records
    mockResponses["GET /managedZones/sync-zone-com/rrsets"] = {
      status: 200,
      body: {
        rrsets: [
          // Identical
          { name: "www.sync-zone.com.", type: "CNAME", ttl: 300, rrdatas: ["lb.google.com."] },
          // Differing TTL
          { name: "db.sync-zone.com.", type: "A", ttl: 300, rrdatas: ["10.0.0.5"] },
          // Differing Value
          { name: "mail.sync-zone.com.", type: "A", ttl: 300, rrdatas: ["1.1.1.1"] },
        ],
      },
    };

    mockResponses["POST /managedZones/sync-zone-com/changes"] = {
      status: 200,
      body: {},
    };

    const builder = new GCPCloudDNSZoneBuilder("sync-zone.com")
      .record("www", "CNAME", "lb.google.com", 300) // Identical
      .record("db", "A", "10.0.0.5", 60)          // Changed TTL (300 -> 60)
      .record("mail", "A", "2.2.2.2", 300);        // Changed Value (1.1.1.1 -> 2.2.2.2)

    await builder.deploy();

    const changeCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/changes"));
    assert.ok(changeCall);

    // additions should have db (new TTL) and mail (new value)
    assert.strictEqual(changeCall.body.additions.length, 2);
    // deletions should have old db and old mail
    assert.strictEqual(changeCall.body.deletions.length, 2);

    const oldMail = changeCall.body.deletions.find((d: any) => d.name === "mail.sync-zone.com.");
    assert.ok(oldMail);
    assert.deepStrictEqual(oldMail.rrdatas, ["1.1.1.1"]);

    const newMail = changeCall.body.additions.find((a: any) => a.name === "mail.sync-zone.com.");
    assert.ok(newMail);
    assert.deepStrictEqual(newMail.rrdatas, ["2.2.2.2"]);
  });

  test("resolves pointers to other builders, converting to CNAME and stripping protocols", async () => {
    mockResponses["GET /managedZones/pointers-com"] = {
      status: 200,
      body: { name: "pointers-com" },
    };
    mockResponses["GET /managedZones/pointers-com/rrsets"] = { status: 200, body: { rrsets: [] } };
    mockResponses["POST /managedZones/pointers-com/changes"] = { status: 200, body: {} };

    // Let's mock a target builder that resolves to a URL (e.g. Cloud Run microservice)
    const mockCloudRun: any = {
      name: "frontend-srv",
      url: "https://frontend-srv-xyz.a.run.app",
    };

    // Let's mock another target that is an Output resolving to an IP
    const ipOutput = new Output<string>();
    ipOutput.resolve("123.45.67.89");

    const builder = new GCPCloudDNSZoneBuilder("pointers.com")
      .pointer("app", mockCloudRun)
      .pointer("api", ipOutput);

    const result = await builder.deploy();

    const appRec = result.records.find((r) => r.name === "app.pointers.com.");
    assert.ok(appRec);
    // Dynamic CNAME conversion from HTTP URL target!
    assert.strictEqual(appRec.type, "CNAME");
    assert.deepStrictEqual(appRec.rrdatas, ["frontend-srv-xyz.a.run.app."]); // Stripped https://, appended trailing dot!

    const apiRec = result.records.find((r) => r.name === "api.pointers.com.");
    assert.ok(apiRec);
    // Standard A record for plain IP output!
    assert.strictEqual(apiRec.type, "A");
    assert.deepStrictEqual(apiRec.rrdatas, ["123.45.67.89"]);
  });

  test("destroys zone successfully, removing non-default records first", async () => {
    mockResponses["GET /managedZones/to-delete-com"] = {
      status: 200,
      body: { name: "to-delete-com" },
    };

    mockResponses["GET /managedZones/to-delete-com/rrsets"] = {
      status: 200,
      body: {
        rrsets: [
          { name: "to-delete.com.", type: "NS", rrdatas: ["ns-cloud-a1.google.com."] }, // apex NS (default)
          { name: "to-delete.com.", type: "SOA", rrdatas: ["ns-cloud-a1.google.com. host.google.com."] }, // apex SOA (default)
          { name: "www.to-delete.com.", type: "A", rrdatas: ["1.2.3.4"] }, // non-default
          { name: "api.to-delete.com.", type: "CNAME", rrdatas: ["lb.google.com."] }, // non-default
        ],
      },
    };

    mockResponses["POST /managedZones/to-delete-com/changes"] = { status: 200, body: {} };
    mockResponses["DELETE /managedZones/to-delete-com"] = { status: 200, body: {} };

    const builder = new GCPCloudDNSZoneBuilder("to-delete.com");
    await builder.destroy();

    // Verify non-default records deletion POST
    const changeCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/changes"));
    assert.ok(changeCall);
    assert.strictEqual(changeCall.body.deletions.length, 2); // only www and api
    const deletedNames = changeCall.body.deletions.map((d: any) => d.name);
    assert.ok(deletedNames.includes("www.to-delete.com."));
    assert.ok(deletedNames.includes("api.to-delete.com."));

    // Verify Zone DELETE
    const deleteCall = fetchCalls.find((c) => c.method === "DELETE" && c.url.endsWith("/managedZones/to-delete-com"));
    assert.ok(deleteCall);
  });
});
