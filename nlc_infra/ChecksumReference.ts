import { AWS } from "../src/providers/aws/index.ts";
import { BUCKET, DISTRO, REGION } from "../src/types/aws.ts";
import { Stack } from "../src/core/stack.ts";
import { Deploy } from "../src/core/decorators.ts";

@Deploy({ region: REGION.US_EAST_1, dryRun: false })
class ChecksumReference extends Stack {
  checksum = AWS.S3(BUCKET.CHECKSUM)
    .region(REGION.EU_WEST_1)
    .upload("config/files/jarFileChecksumReference.json");

  cloudfront = AWS.CloudFront(DISTRO.CHECKSUM).invalidate([
    "/jarFileChecksumReference.json",
  ]);
}
