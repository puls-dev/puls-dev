import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Secret } from "./secret.js";
import { Config } from "./config.js";
import { Output } from "./output.js";

// Import clients to mock their prototype methods
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { GoogleAuth } from "google-auth-library";

describe("Secrets at Deploy Time Unit Tests", () => {
  beforeEach(() => {
    // Reset global config before each test
    Config.set({
      dryRun: false,
      providers: {},
    });
  });

  test("Secret.env resolves existing environment variables", async () => {
    process.env.TEST_MY_SECRET = "super-secret-value";
    try {
      const secret = Secret.env("TEST_MY_SECRET");
      const val = await secret.get();
      assert.strictEqual(val, "super-secret-value");
    } finally {
      delete process.env.TEST_MY_SECRET;
    }
  });

  test("Secret.env uses fallback when environment variable is missing", async () => {
    const secret = Secret.env("TEST_MISSING_SECRET", "fallback-value");
    const val = await secret.get();
    assert.strictEqual(val, "fallback-value");
  });

  test("Secret.env throws error when missing and no fallback is set", async () => {
    const secret = Secret.env("TEST_MISSING_SECRET_NO_FALLBACK");
    await assert.rejects(async () => {
      await secret.get();
    }, /Environment secret "TEST_MISSING_SECRET_NO_FALLBACK" is not set and has no fallback./);
  });

  test("Secret.resolve correctly resolves strings, Outputs, and Secrets", async () => {
    // 1. Resolve plain string
    const r1 = await Secret.resolve("plain-string");
    assert.strictEqual(r1, "plain-string");

    // 2. Resolve general Output
    const out = new Output<string>();
    out.resolve("resolved-output");
    const r2 = await Secret.resolve(out);
    assert.strictEqual(r2, "resolved-output");

    // 3. Resolve Secret
    process.env.TEST_RESOLVE = "secret-val";
    try {
      const sec = Secret.env("TEST_RESOLVE");
      const r3 = await Secret.resolve(sec);
      assert.strictEqual(r3, "secret-val");
    } finally {
      delete process.env.TEST_RESOLVE;
    }
  });

  test("Secret resolves immediately to placeholder [SECRET:name] in dry-run mode", async () => {
    Config.set({ dryRun: true });

    // No actual env vars, cloud requests, or file systems will be hit
    const s1 = Secret.env("SOME_ENV");
    const s2 = Secret.aws("some/aws/secret");
    const s3 = Secret.ssm("/some/ssm/param");
    const s4 = Secret.gcp("some-gcp-secret");

    assert.strictEqual(await s1.get(), "[SECRET:SOME_ENV]");
    assert.strictEqual(await s2.get(), "[SECRET:some/aws/secret]");
    assert.strictEqual(await s3.get(), "[SECRET:/some/ssm/param]");
    assert.strictEqual(await s4.get(), "[SECRET:some-gcp-secret]");
  });

  test("Secret.aws resolves value using mocked AWS Secrets Manager", async () => {
    const originalSend = SecretsManagerClient.prototype.send;
    mock.method(SecretsManagerClient.prototype, "send", async (command: any) => {
      return { SecretString: "my-aws-vault-password" };
    });

    try {
      const secret = Secret.aws("prod/db/pass", { region: "eu-west-1" });
      const val = await secret.get();
      assert.strictEqual(val, "my-aws-vault-password");
    } finally {
      SecretsManagerClient.prototype.send = originalSend;
    }
  });

  test("Secret.ssm resolves value using mocked AWS SSM Parameter Store", async () => {
    const originalSend = SSMClient.prototype.send;
    mock.method(SSMClient.prototype, "send", async (command: any) => {
      return {
        Parameter: {
          Value: "my-ssm-token-value",
        },
      };
    });

    try {
      const secret = Secret.ssm("/prod/api/token");
      const val = await secret.get();
      assert.strictEqual(val, "my-ssm-token-value");
    } finally {
      SSMClient.prototype.send = originalSend;
    }
  });

  test("Secret.gcp resolves value using mocked GCP Secret Manager fetcher", async () => {
    // 1. Create a dummy service account file
    const dummySaPath = join(tmpdir(), `puls-gcp-sa-test-${Date.now()}.json`);
    const dummySa = {
      project_id: "test-gcp-project",
      client_email: "test@developer.gserviceaccount.com",
    };
    fs.writeFileSync(dummySaPath, JSON.stringify(dummySa));

    // Configure config to use the dummy file
    Config.set({
      providers: {
        gcp: {
          projectId: "test-gcp-project",
          serviceAccountPath: dummySaPath,
        },
      },
    });

    // 2. Mock GoogleAuth class prototype
    const originalGetClient = GoogleAuth.prototype.getClient;
    mock.method(GoogleAuth.prototype, "getClient", async () => {
      return {
        getAccessToken: async () => ({ token: "mocked-gcp-access-token" }),
      } as any;
    });

    // 3. Mock globalThis.fetch to intercept Secret Manager API request
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authHeader = "";

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      authHeader = (init?.headers as any)?.["Authorization"] ?? "";
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            name: "projects/test-gcp-project/secrets/my-secret/versions/latest",
            payload: {
              data: Buffer.from("my-gcp-payload-value").toString("base64"),
            },
          }),
      } as Response;
    }) as any;

    try {
      const secret = Secret.gcp("my-secret");
      const val = await secret.get();

      assert.strictEqual(val, "my-gcp-payload-value");
      assert.strictEqual(
        requestedUrl,
        "https://secretmanager.googleapis.com/v1/projects/test-gcp-project/secrets/my-secret/versions/latest:access"
      );
      assert.strictEqual(authHeader, "Bearer mocked-gcp-access-token");
    } finally {
      // Cleanup
      globalThis.fetch = originalFetch;
      GoogleAuth.prototype.getClient = originalGetClient;
      try {
        fs.unlinkSync(dummySaPath);
      } catch {}
    }
  });
});
