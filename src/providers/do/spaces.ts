import fs from "node:fs";
import { basename, extname } from "node:path";
import {
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketAclCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { BaseBuilder } from "../../core/resource.js";
import { getSpacesS3Client } from "./spaces_api.js";

export type CORSRule = {
  AllowedHeaders?: string[];
  AllowedMethods: string[];
  AllowedOrigins: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds?: number;
};

export class SpacesBuilder extends BaseBuilder {
  private _region: string = "nyc3";
  private _acl: "private" | "public-read" = "private";
  private _corsRules?: CORSRule[];
  private _uploadPath?: string;

  constructor(public bucketName: string) {
    super(bucketName);
    this.discoveryPromise = this.discoverBucket(bucketName);
  }

  region(r: string) {
    this._region = r;
    this.discoveryPromise = this.discoverBucket(this.bucketName);
    return this;
  }

  acl(type: "private" | "public-read") {
    this._acl = type;
    return this;
  }

  cors(rules: CORSRule[]) {
    this._corsRules = rules;
    return this;
  }

  upload(filePath: string) {
    this._uploadPath = filePath;
    return this;
  }

  private async discoverBucket(name: string): Promise<boolean> {
    try {
      const s3 = getSpacesS3Client(this._region);
      await s3.send(new HeadBucketCommand({ Bucket: name }));
      return true;
    } catch (e: any) {
      const status = e.$metadata?.httpStatusCode;
      if (status === 404 || e.name === "NotFound") return false;
      if (status === 301 || status === 403) return true; // exists or access denied
      if (e.name === "CredentialsProviderError") return false;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const exists = await this.discoveryPromise;
    const s3 = getSpacesS3Client(this._region);

    console.log(`\n🌌 Finalizing DigitalOcean Space "${this.bucketName}"...`);

    if (!exists) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Create DigitalOcean Space "${this.bucketName}" (${this._region})`);
      } else {
        await s3.send(new CreateBucketCommand({ Bucket: this.bucketName }));
        console.log(`🚀 Created DigitalOcean Space "${this.bucketName}"`);
      }
    } else {
      console.log(`   ✅ DigitalOcean Space "${this.bucketName}" already exists.`);
    }

    // Apply ACL
    if (this._acl) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Set Space ACL: ${this._acl}`);
      } else {
        await s3.send(new PutBucketAclCommand({ Bucket: this.bucketName, ACL: this._acl }));
        console.log(`   ✅ Set Space ACL: ${this._acl}`);
      }
    }

    // Apply CORS
    if (this._corsRules) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Configure CORS rules: ${JSON.stringify(this._corsRules)}`);
      } else {
        await s3.send(
          new PutBucketCorsCommand({
            Bucket: this.bucketName,
            CORSConfiguration: { CORSRules: this._corsRules },
          })
        );
        console.log(`   ✅ Configured CORS rules`);
      }
    }

    // Handle single file upload
    if (this._uploadPath) {
      if (dryRun) {
        console.log(`   📝 [PLAN] Upload ${basename(this._uploadPath)} → space://${this.bucketName}/`);
      } else {
        await this.uploadFile(s3, this._uploadPath);
      }
    }

    await this.deploySidecars();
    return { name: this.bucketName, region: this._region };
  }

  async destroy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    const exists = await this.discoveryPromise;

    console.log(`\n🌌 Destroying DigitalOcean Space "${this.bucketName}"...`);

    if (!exists) {
      console.log(`   ─  Space "${this.bucketName}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete DigitalOcean Space "${this.bucketName}"`);
      return { destroyed: this.bucketName };
    }

    const s3 = getSpacesS3Client(this._region);
    await s3.send(new DeleteBucketCommand({ Bucket: this.bucketName }));
    console.log(`   🗑️  Removed DigitalOcean Space "${this.bucketName}"`);
    return { destroyed: this.bucketName };
  }

  private async uploadFile(s3: any, filePath: string) {
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
      contentTypeMap[extname(filePath).toLowerCase()] ?? "application/octet-stream";

    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        ACL: this._acl,
      })
    );

    console.log(`   ✅ Uploaded ${key} → space://${this.bucketName}/${key}`);
  }
}
