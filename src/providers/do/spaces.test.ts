import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { S3Client } from "@aws-sdk/client-s3";
import { SpacesBuilder } from "./spaces.js";
import { Config } from "../../core/config.js";

describe("SpacesBuilder Unit Tests", () => {
  let originalS3Send: typeof S3Client.prototype.send;
  let s3Calls: Array<{ commandName: string; input: any }> = [];
  let mockS3Responses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        do: {
          token: "fake-do-token",
          defaultRegion: "nyc3",
          spacesAccessKey: "fake-spaces-key",
          spacesSecretKey: "fake-spaces-secret",
        },
      },
    });

    s3Calls = [];
    mockS3Responses = {};

    originalS3Send = S3Client.prototype.send;

    S3Client.prototype.send = async function (command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      s3Calls.push({ commandName, input });

      if (mockS3Responses[commandName] !== undefined) {
        const handler = mockS3Responses[commandName];
        if (typeof handler === "function") return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    mock.method(fs, "readFileSync", () => {
      return Buffer.from("fake-file-content");
    });
  });

  afterEach(() => {
    S3Client.prototype.send = originalS3Send;
    mock.restoreAll();
  });

  test("gracefully handles discovery when Space does not exist", async () => {
    mockS3Responses["HeadBucketCommand"] = () => {
      const err = new Error("Not Found");
      err.name = "NotFound";
      (err as any).$metadata = { httpStatusCode: 404 };
      throw err;
    };

    const builder = new SpacesBuilder("my-space");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, false);
    assert.strictEqual(s3Calls.length, 1);
    assert.strictEqual(s3Calls[0].commandName, "HeadBucketCommand");
    assert.strictEqual(s3Calls[0].input.Bucket, "my-space");
  });

  test("discovers Space successfully when it exists", async () => {
    mockS3Responses["HeadBucketCommand"] = () => ({});

    const builder = new SpacesBuilder("my-space");
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, true);
    assert.strictEqual(s3Calls.length, 1);
  });

  test("performs clean dry-run planning without making write requests", async () => {
    Config.set({
      dryRun: true,
      providers: {
        do: {
          token: "fake-do-token",
          spacesAccessKey: "fake-key",
          spacesSecretKey: "fake-secret",
        },
      },
    });

    mockS3Responses["HeadBucketCommand"] = () => {
      const err = new Error("Not Found");
      err.name = "NotFound";
      (err as any).$metadata = { httpStatusCode: 404 };
      throw err;
    };

    const builder = new SpacesBuilder("my-dry-space")
      .region("ams3")
      .acl("public-read")
      .cors([
        {
          AllowedMethods: ["GET", "PUT"],
          AllowedOrigins: ["*"],
        },
      ])
      .upload("dist/index.js");

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-dry-space");
    assert.strictEqual(result.region, "ams3");

    // HeadBucketCommand should run for discovery, but no creation/write commands
    assert.ok(s3Calls.some((c) => c.commandName === "HeadBucketCommand"));
    const writeCalls = s3Calls.filter((c) => c.commandName !== "HeadBucketCommand");
    assert.strictEqual(writeCalls.length, 0);
  });

  test("deploys new Space, applying ACL and CORS rules successfully", async () => {
    mockS3Responses["HeadBucketCommand"] = () => {
      const err = new Error("Not Found");
      err.name = "NotFound";
      (err as any).$metadata = { httpStatusCode: 404 };
      throw err;
    };

    mockS3Responses["CreateBucketCommand"] = () => ({});
    mockS3Responses["PutBucketAclCommand"] = () => ({});
    mockS3Responses["PutBucketCorsCommand"] = () => ({});

    const builder = new SpacesBuilder("my-new-space")
      .region("sgp1")
      .acl("public-read")
      .cors([
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET", "HEAD"],
          AllowedOrigins: ["https://example.com"],
        },
      ]);

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.name, "my-new-space");
    assert.strictEqual(result.region, "sgp1");

    // Verify commands sent to S3
    const createCall = s3Calls.find((c) => c.commandName === "CreateBucketCommand");
    assert.ok(createCall);
    assert.strictEqual(createCall.input.Bucket, "my-new-space");

    const aclCall = s3Calls.find((c) => c.commandName === "PutBucketAclCommand");
    assert.ok(aclCall);
    assert.strictEqual(aclCall.input.Bucket, "my-new-space");
    assert.strictEqual(aclCall.input.ACL, "public-read");

    const corsCall = s3Calls.find((c) => c.commandName === "PutBucketCorsCommand");
    assert.ok(corsCall);
    assert.strictEqual(corsCall.input.Bucket, "my-new-space");
    assert.deepStrictEqual(corsCall.input.CORSConfiguration.CORSRules, [
      {
        AllowedHeaders: ["*"],
        AllowedMethods: ["GET", "HEAD"],
        AllowedOrigins: ["https://example.com"],
      },
    ]);
  });

  test("deploys new Space and handles file upload with correct content type", async () => {
    mockS3Responses["HeadBucketCommand"] = () => {
      const err = new Error("Not Found");
      err.name = "NotFound";
      (err as any).$metadata = { httpStatusCode: 404 };
      throw err;
    };

    mockS3Responses["CreateBucketCommand"] = () => ({});
    mockS3Responses["PutBucketAclCommand"] = () => ({});
    mockS3Responses["PutObjectCommand"] = () => ({});

    const builder = new SpacesBuilder("my-upload-space")
      .upload("dist/app.json");

    const result = await builder.deploy();
    assert.ok(result);

    const putCall = s3Calls.find((c) => c.commandName === "PutObjectCommand");
    assert.ok(putCall);
    assert.strictEqual(putCall.input.Bucket, "my-upload-space");
    assert.strictEqual(putCall.input.Key, "app.json");
    assert.strictEqual(putCall.input.ContentType, "application/json");
    assert.strictEqual(putCall.input.ACL, "private");
  });

  test("destroys Space successfully", async () => {
    mockS3Responses["HeadBucketCommand"] = () => ({});
    mockS3Responses["DeleteBucketCommand"] = () => ({});

    const builder = new SpacesBuilder("my-delete-space");
    await (builder as any).discoveryPromise;

    const result = await builder.destroy();
    assert.deepStrictEqual(result, { destroyed: "my-delete-space" });

    const deleteCall = s3Calls.find((c) => c.commandName === "DeleteBucketCommand");
    assert.ok(deleteCall);
    assert.strictEqual(deleteCall.input.Bucket, "my-delete-space");
  });
});
