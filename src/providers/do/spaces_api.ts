import { S3Client } from "@aws-sdk/client-s3";
import { Config } from "../../core/config.js";

export function getSpacesS3Client(region: string = "nyc3"): S3Client {
  const doConfig = Config.get().providers.do;
  const accessKey = doConfig?.spacesAccessKey ?? process.env.SPACES_ACCESS_KEY_ID;
  const secretKey = doConfig?.spacesSecretKey ?? process.env.SPACES_SECRET_ACCESS_KEY;

  if (!accessKey || !secretKey) {
    throw new Error(
      "DigitalOcean Spaces credentials not found. " +
      "Please set SPACES_ACCESS_KEY_ID and SPACES_SECRET_ACCESS_KEY env vars, " +
      "or configure 'spacesAccessKey' and 'spacesSecretKey' in your DO provider options."
    );
  }

  return new S3Client({
    endpoint: `https://${region}.digitaloceanspaces.com`,
    region: region, // S3Client requires region, even if endpoint is custom
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });
}
