import fs from "node:fs";
import { basename, extname } from "node:path";
import {
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutBucketWebsiteCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { BaseBuilder } from "@puls-dev/core";
import { CloudFrontBuilder } from "./cloudfront.js";
import { getS3Client } from "./api.js";
import { Config } from "@puls-dev/core";

export class S3BucketBuilder extends BaseBuilder {
  private _versioning: boolean = false;
  private _allowedDistributions: CloudFrontBuilder[] = [];
  private _region?: string;
  private _uploadPath?: string;
  private _websiteConfig?: { index: string; error: string };

  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.discoverBucket(bucketName);
  }

  region(r: string) {
    this._region = r;
    this.discoveryPromise = this.discoverBucket(this.bucketName);
    return this;
  }

  private async discoverBucket(name: string): Promise<boolean> {
    try {
      await getS3Client(this._region).send(
        new HeadBucketCommand({ Bucket: name }),
      );
      return true;
    } catch (e: any) {
      const status = e.$metadata?.httpStatusCode;
      if (status === 404 || e.name === "NotFound") return false;
      if (status === 301 || status === 403) return true; // exists in different region or access denied
      if (e.name === "CredentialsProviderError") return false;
      throw e;
    }
  }

  versioning(enabled: boolean = true) {
    this._versioning = enabled;
    return this;
  }

  allowFrom(...distributions: CloudFrontBuilder[]) {
    this._allowedDistributions.push(...distributions);
    return this;
  }

  upload(filePath: string) {
    this._uploadPath = filePath;
    return this;
  }

  staticSite(indexDocument: string = "index.html", errorDocument: string = "error.html") {
    this._websiteConfig = { index: indexDocument, error: errorDocument };
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const exists = await this.discoveryPromise;
    const region =
      this._region ?? Config.get().providers.aws?.region ?? "us-east-1";
    const s3 = getS3Client(region);

    console.log(`\n🪣  Finalizing S3 Bucket "${this.bucketName}"...`);

    if (!exists) {
      if (dryRun) {
        console.log(
          `   📝 [PLAN] Create bucket ${this.bucketName} (${region})`,
        );
      } else {
        const createCmd: any = { Bucket: this.bucketName };
        if (region !== "us-east-1") {
          createCmd.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createCmd));
        console.log(`🚀 Created bucket ${this.bucketName}`);
      }
    } else {
      console.log(`   ✅ Bucket ${this.bucketName} already exists.`);
    }

    if (this._allowedDistributions.length > 0) {
      const unresolved = this._allowedDistributions.filter(
        (d) => !d.resolvedArn,
      );
      if (unresolved.length > 0) {
        throw new Error(
          `[S3:${this.bucketName}] allowFrom() has unresolved distributions: ` +
            unresolved.map((d) => `"${d.name}"`).join(", ") +
            ". Declare the bucket after all CloudFront distributions in your Stack.",
        );
      }

      const newArns = this._allowedDistributions.map(
        (d) => d.resolvedArn as string,
      );

      if (dryRun) {
        console.log(
          `   📝 [PLAN] Append ${newArns.length} CloudFront OAC ARN(s) to bucket policy`,
        );
        for (const arn of newArns) console.log(`      └─ ${arn}`);
      } else {
        await this.updateBucketPolicy(s3, newArns);
      }
    }
    if (this._websiteConfig) {
      if (dryRun) {
        console.log(
          `   📝 [PLAN] Enable static site hosting: index=${this._websiteConfig.index}, error=${this._websiteConfig.error}`,
        );
        console.log(`   📝 [PLAN] Remove public access block from bucket`);
        console.log(`   📝 [PLAN] Configure public read bucket policy`);
      } else {
        await s3.send(
          new PutPublicAccessBlockCommand({
            Bucket: this.bucketName,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: false,
              IgnorePublicAcls: false,
              BlockPublicPolicy: false,
              RestrictPublicBuckets: false,
            },
          }),
        );
        console.log(`   ✅ Public access block removed`);

        await s3.send(
          new PutBucketWebsiteCommand({
            Bucket: this.bucketName,
            WebsiteConfiguration: {
              IndexDocument: { Suffix: this._websiteConfig.index },
              ErrorDocument: { Key: this._websiteConfig.error },
            },
          }),
        );
        console.log(`   ✅ Configured static website hosting`);

        await this.applyPublicReadPolicy(s3);
      }
    }

    if (this._uploadPath) {
      if (dryRun) {
        console.log(
          `   📝 [PLAN] Upload ${basename(this._uploadPath)} → s3://${this.bucketName}/`,
        );
      } else {
        await this.uploadFile(s3, this._uploadPath);
      }
    }

    await this.deploySidecars();
    return { name: this.bucketName };
  }

  private async uploadFile(
    s3: ReturnType<typeof getS3Client>,
    filePath: string,
  ) {
    const key = basename(filePath);
    const body = fs.readFileSync(filePath);
    const contentTypeMap: Record<string, string> = {
      ".json": "application/json",
      ".js": "application/javascript",
      ".html": "text/html",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
    };
    const contentType =
      contentTypeMap[extname(filePath).toLowerCase()] ??
      "application/octet-stream";

    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    console.log(`   ✅ Uploaded ${key} → s3://${this.bucketName}/${key}`);
  }

  private async updateBucketPolicy(
    s3: ReturnType<typeof getS3Client>,
    newArns: string[],
  ) {
    let policy: any = { Version: "2012-10-17", Statement: [] };

    try {
      const existing = await s3.send(
        new GetBucketPolicyCommand({ Bucket: this.bucketName }),
      );
      if (existing.Policy) policy = JSON.parse(existing.Policy);
    } catch (e: any) {
      if (e.name !== "NoSuchBucketPolicy") throw e;
    }

    // Find any existing CloudFront-principal statement regardless of Sid
    let stmt = policy.Statement.find(
      (s: any) =>
        s.Principal?.Service === "cloudfront.amazonaws.com" &&
        s.Effect === "Allow",
    );
    if (!stmt) {
      stmt = {
        Sid: "AllowCloudFrontServicePrincipal",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${this.bucketName}/*`,
        Condition: { StringEquals: { "AWS:SourceArn": [] } },
      };
      policy.Statement.push(stmt);
    }

    // Condition key may be 'aws:SourceArn' or 'AWS:SourceArn' depending on how it was created
    const cond = stmt.Condition?.StringEquals ?? {};
    const sourceArnKey =
      Object.keys(cond).find((k) => k.toLowerCase() === "aws:sourcearn") ??
      "AWS:SourceArn";
    if (!stmt.Condition) stmt.Condition = { StringEquals: {} };
    if (!stmt.Condition.StringEquals) stmt.Condition.StringEquals = {};

    const existing = stmt.Condition.StringEquals[sourceArnKey];
    const existingArns: string[] = Array.isArray(existing)
      ? existing
      : existing
        ? [existing]
        : [];
    const merged = [...new Set([...existingArns, ...newArns])];
    stmt.Condition.StringEquals[sourceArnKey] = merged;

    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucketName,
        Policy: JSON.stringify(policy),
      }),
    );

    console.log(
      `   ✅ Updated bucket policy - ${merged.length} distribution ARN(s) allowed`,
    );
    for (const arn of newArns) console.log(`      └─ ${arn}`);
  }

  private async applyPublicReadPolicy(s3: ReturnType<typeof getS3Client>) {
    let policy: any = { Version: "2012-10-17", Statement: [] };

    try {
      const existing = await s3.send(
        new GetBucketPolicyCommand({ Bucket: this.bucketName }),
      );
      if (existing.Policy) policy = JSON.parse(existing.Policy);
    } catch (e: any) {
      if (e.name !== "NoSuchBucketPolicy") throw e;
    }

    let stmt = policy.Statement.find(
      (s: any) =>
        s.Sid === "PublicReadGetObject" ||
        (s.Effect === "Allow" && s.Principal === "*" && s.Action === "s3:GetObject"),
    );

    if (!stmt) {
      stmt = {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${this.bucketName}/*`,
      };
      policy.Statement.push(stmt);
    }

    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucketName,
        Policy: JSON.stringify(policy),
      }),
    );
    console.log(`   ✅ Public read policy statement applied`);
  }
}
