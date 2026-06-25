import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { GoogleAuth } from "google-auth-library";
import { GCPBigQueryViewBuilder } from "./bigquery.js";
import { Config } from "@puls-dev/core";

describe("GCPBigQueryViewBuilder Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; method: string; body?: any }[] = [];
  let mockResponses: Record<string, { status: number; body: any }> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      offline: false,
      providers: {
        gcp: {
          projectId: "my-gcp-project",
          serviceAccountPath: "/fake/sa.json",
        },
      },
    });

    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockResponses = {};

    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ url, method, body });

      const matchKey = Object.keys(mockResponses)
        .filter((k) => {
          const [mMethod, mPath] = k.split(" ");
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
        json: async () => ({
          message: `Endpoint not mocked: ${method} ${url}`,
        }),
        text: async () => `Endpoint not mocked: ${method} ${url}`,
      } as Response;
    };

    mock.method(GoogleAuth.prototype, "getClient", async () => ({
      getAccessToken: async () => ({ token: "fake-gcp-token" }),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("creates a new view when missing", async () => {
    mockResponses["GET /tables/active_users"] = { status: 404, body: {} };
    mockResponses["POST /tables"] = { status: 200, body: {} };

    const view = new GCPBigQueryViewBuilder("active_users")
      .dataset("analytics")
      .query("SELECT * FROM `my-gcp-project.raw.users` WHERE active = true");

    const result = await view.deploy();

    assert.strictEqual(result.name, "active_users");
    assert.strictEqual(result.dataset, "analytics");
    assert.strictEqual(
      result.qualifiedRef,
      "`my-gcp-project.analytics.active_users`",
    );

    const post = fetchCalls.find(
      (c) => c.method === "POST" && c.url.includes("/tables"),
    );
    assert.ok(post, "should POST to create the table");
    assert.strictEqual(post.body.tableReference.tableId, "active_users");
    assert.strictEqual(post.body.tableReference.datasetId, "analytics");
    assert.strictEqual(
      post.body.view.query,
      "SELECT * FROM `my-gcp-project.raw.users` WHERE active = true",
    );
    assert.strictEqual(post.body.view.useLegacySql, false);
  });

  test("skips update when existing view query is identical", async () => {
    const sql = "SELECT id, name FROM `my-gcp-project.raw.users`";

    mockResponses["GET /tables/stable_view"] = {
      status: 200,
      body: { view: { query: sql, useLegacySql: false }, type: "VIEW" },
    };

    const view = new GCPBigQueryViewBuilder("stable_view")
      .dataset("analytics")
      .query(sql);

    const result = await view.deploy();
    assert.strictEqual(result.name, "stable_view");

    const writes = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(
      writes.length,
      0,
      "should make no write calls when query unchanged",
    );
  });

  test("updates an existing view when query differs", async () => {
    mockResponses["GET /tables/changing_view"] = {
      status: 200,
      body: {
        view: {
          query: "SELECT id FROM `my-gcp-project.raw.users`",
          useLegacySql: false,
        },
        type: "VIEW",
      },
    };
    mockResponses["PUT /tables/changing_view"] = { status: 200, body: {} };

    const view = new GCPBigQueryViewBuilder("changing_view")
      .dataset("analytics")
      .query("SELECT id, email FROM `my-gcp-project.raw.users`");

    const result = await view.deploy();
    assert.strictEqual(result.name, "changing_view");

    const put = fetchCalls.find(
      (c) => c.method === "PUT" && c.url.includes("/tables/changing_view"),
    );
    assert.ok(put, "should PUT to update the view");
    assert.strictEqual(
      put.body.view.query,
      "SELECT id, email FROM `my-gcp-project.raw.users`",
    );
  });

  test("destroys an existing view", async () => {
    mockResponses["GET /tables/old_view"] = {
      status: 200,
      body: { view: { query: "SELECT 1" }, type: "VIEW" },
    };
    mockResponses["DELETE /tables/old_view"] = { status: 204, body: null };

    const view = new GCPBigQueryViewBuilder("old_view").dataset("analytics");
    const result = await view.destroy();

    assert.deepStrictEqual(result, { destroyed: "old_view" });
    const del = fetchCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/tables/old_view"),
    );
    assert.ok(del, "should issue DELETE request");
  });

  test("reports not-found gracefully on destroy", async () => {
    mockResponses["GET /tables/missing_view"] = { status: 404, body: {} };

    const view = new GCPBigQueryViewBuilder("missing_view").dataset(
      "analytics",
    );
    const result = await view.destroy();

    assert.deepStrictEqual(result, { destroyed: false });
    const del = fetchCalls.find((c) => c.method === "DELETE");
    assert.ok(!del, "should not issue DELETE when view does not exist");
  });

  test("dry-run plans creation without API writes", async () => {
    Config.set({ dryRun: true });
    mockResponses["GET /tables/planned_view"] = { status: 404, body: {} };

    const view = new GCPBigQueryViewBuilder("planned_view")
      .dataset("analytics")
      .query("SELECT * FROM `my-gcp-project.raw.events`");

    const result = await view.deploy();
    assert.strictEqual(result.name, "planned_view");
    assert.strictEqual(
      result.qualifiedRef,
      "`my-gcp-project.analytics.planned_view`",
    );

    const writes = fetchCalls.filter((c) => c.method !== "GET");
    assert.strictEqual(writes.length, 0, "no writes in dry-run");
  });

  test("out.qualifiedRef resolves to backtick-quoted project.dataset.view reference", async () => {
    mockResponses["GET /tables/ref_view"] = { status: 404, body: {} };
    mockResponses["POST /tables"] = { status: 200, body: {} };

    const view = new GCPBigQueryViewBuilder("ref_view")
      .dataset("reporting")
      .query("SELECT 1");

    await view.deploy();
    const ref = await view.out.qualifiedRef.get();
    assert.strictEqual(ref, "`my-gcp-project.reporting.ref_view`");
  });

  test("output interpolation: toString() returns sentinel; query() wires dependsOn", async () => {
    const base = new GCPBigQueryViewBuilder("base_view").dataset("ds");
    const dependent = new GCPBigQueryViewBuilder("dependent_view").dataset(
      "ds",
    );

    const sentinel = base.toString();
    assert.ok(
      sentinel.startsWith("__PULS_BQ_base_view_"),
      "sentinel has expected prefix",
    );

    dependent.query(`SELECT * FROM ${base} WHERE id > 0`);

    assert.ok(
      (dependent as any)._dependencies.includes(base),
      "dependent should automatically dependsOn base after interpolation",
    );
  });

  test("output interpolation: sentinel resolves to qualifiedRef in deployed query", async () => {
    const activeUsers = new GCPBigQueryViewBuilder("au_base").dataset(
      "analytics",
    );
    const userLtv = new GCPBigQueryViewBuilder("au_ltv")
      .dataset("analytics")
      .query(`SELECT u.id FROM ${activeUsers} u`);

    // Provision mock responses for both views
    mockResponses["GET /tables/au_base"] = { status: 404, body: {} };
    mockResponses["GET /tables/au_ltv"] = { status: 404, body: {} };

    let postCount = 0;
    const postBodies: any[] = [];
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ url, method, body });

      if (
        method === "GET" &&
        (url.includes("/tables/au_base") || url.includes("/tables/au_ltv"))
      ) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "{}",
        } as Response;
      }
      if (method === "POST" && url.includes("/tables")) {
        postCount++;
        postBodies.push(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "{}",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "{}",
      } as Response;
    };

    // Deploy base first - this resolves activeUsers.out.qualifiedRef
    await activeUsers
      .query("SELECT * FROM `my-gcp-project.raw.users`")
      .deploy();
    const baseRef = await activeUsers.out.qualifiedRef.get();
    assert.strictEqual(baseRef, "`my-gcp-project.analytics.au_base`");

    // Deploy dependent - sentinel in its query should be replaced with the qualifiedRef
    await userLtv.deploy();

    assert.strictEqual(
      postCount,
      2,
      "should have two POST calls (one per view)",
    );
    const ltvBody = postBodies.find(
      (b) => b?.tableReference?.tableId === "au_ltv",
    );
    assert.ok(ltvBody, "should find create call for au_ltv");
    assert.ok(
      ltvBody.view.query.includes("`my-gcp-project.analytics.au_base`"),
      "deployed query should contain resolved qualified ref, not the sentinel",
    );
    assert.ok(
      !ltvBody.view.query.includes("__PULS_BQ_"),
      "deployed query must not contain any unresolved sentinel",
    );
  });

  test("throws if deploy() called without .dataset()", async () => {
    const view = new GCPBigQueryViewBuilder("no_dataset_view").query(
      "SELECT 1",
    );

    await assert.rejects(() => view.deploy(), /no dataset set/);
  });

  test("throws if deploy() called without .query()", async () => {
    mockResponses["GET /tables/no_query_view"] = { status: 404, body: {} };

    const view = new GCPBigQueryViewBuilder("no_query_view").dataset("ds");

    await assert.rejects(() => view.deploy(), /no query set/);
  });

  test("useLegacySql flag is forwarded to the API", async () => {
    mockResponses["GET /tables/legacy_view"] = { status: 404, body: {} };
    mockResponses["POST /tables"] = { status: 200, body: {} };

    const view = new GCPBigQueryViewBuilder("legacy_view")
      .dataset("ds")
      .query("SELECT * FROM [my-gcp-project:ds.table]")
      .useLegacySql(true);

    await view.deploy();

    const post = fetchCalls.find((c) => c.method === "POST");
    assert.ok(post);
    assert.strictEqual(post.body.view.useLegacySql, true);
  });

  test("output interpolation: detects query changes on existing view", async () => {
    const base = new GCPBigQueryViewBuilder("au_base")
      .dataset("analytics")
      .query("SELECT * FROM `my-gcp-project.raw.users`");
    const userLtv = new GCPBigQueryViewBuilder("au_ltv").dataset("analytics");

    // Mock au_base
    mockResponses["GET /tables/au_base"] = {
      status: 200,
      body: {
        view: { query: "SELECT * FROM `my-gcp-project.raw.users`" },
        type: "VIEW",
      },
    };

    // Mock au_ltv: existing query has 'u.id'
    mockResponses["GET /tables/au_ltv"] = {
      status: 200,
      body: {
        view: {
          query: "SELECT u.id FROM `my-gcp-project.analytics.au_base` u",
          useLegacySql: false,
        },
        type: "VIEW",
      },
    };
    mockResponses["PUT /tables/au_ltv"] = { status: 200, body: {} };

    // Set the query for au_ltv to have 'u.id, u.email' instead of just 'u.id'
    userLtv.query(`SELECT u.id, u.email FROM ${base} u`);

    // Let's deploy both
    await base.deploy();
    await userLtv.deploy();

    // Verify PUT request was sent to update au_ltv because query differs!
    const put = fetchCalls.find(
      (c) => c.method === "PUT" && c.url.includes("/tables/au_ltv"),
    );
    assert.ok(put, "should PUT to update au_ltv because the query changed");
    assert.strictEqual(
      put.body.view.query,
      "SELECT u.id, u.email FROM `my-gcp-project.analytics.au_base` u",
    );
  });
});
