import { AWS } from "./src/providers/aws/index.ts";
import { BUCKET, DISTRO, REGION } from "./src/types/aws.ts";
import { Stack } from "./src/core/stack.ts";
import { Deploy } from "./src/core/decorators.ts";

@Deploy({ region: REGION.US_EAST_1, dryRun: true })
class NLCEnvironment extends Stack {
  domain = AWS.Route53().withWildcardSSL().randomDomain().register();

  cdn = AWS.CloudFront(`OPSDSL-${this.domain.zoneName.slice(0, 12)}-CDN`)
    .copyFrom(DISTRO.TURKEY_CDN)
    .forDomain(this.domain, ["ec", "nc"]);

  game = AWS.CloudFront(`OPSDSL-${this.domain.zoneName.slice(0, 12)}-GAME`)
    .copyFrom(DISTRO.TURKEY_GAME)
    .forDomain(this.domain, ["eg", "ng"]);

  bucket = AWS.S3(BUCKET.NLC_GAMES_UREG)
    .allowFrom(this.cdn, this.game)
    .region(REGION.EU_WEST_1);
}
