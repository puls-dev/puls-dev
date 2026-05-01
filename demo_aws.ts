import { AWS } from "./src/providers/aws/index.ts";
import { DISTRO, REGION } from "./src/types/aws.ts";
import { Stack } from "./src/core/stack.ts";
import { Deploy, DryRun } from "./src/core/decorators.ts";

@Deploy({ region: REGION.EU_WEST_1, dryRun: true })
class NLCEnvironment extends Stack {
  domain = AWS.Route53().randomDomain().register().withWildcardSSL();

  cdn = AWS.CloudFront("nlc-cdn")
    .copyFrom(DISTRO.TURKEY_CDN) // clone reference distribution
    .forDomain(this.domain, ["ec", "nc"]);

  game = AWS.CloudFront("nlc-game")
    .copyFrom(DISTRO.TURKEY_GAME)
    .forDomain(this.domain, ["eg", "ng"])
    .withRedirector({ kvs: "turkey-game-redirect-url" });

  bucket = AWS.S3("nl-games-ureg").allowFrom(this.cdn, this.game); // appends new ARNs, preserves existing policy
}
