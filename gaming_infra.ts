import { Deploy, Destroy, Protected } from "./src/core/decorators";
import { Stack } from "./src/core/stack";
import { AWS } from "./src/providers/aws";
import { BUCKET, DISTRO, DOMAIN_REGISTER, REGION } from "./src/types/aws";

@Deploy({ region: REGION.EU_WEST_1 })
class NLCEnvironment extends Stack {
  domain = AWS.Route53()
    .randomDomain()
    .register(DOMAIN_REGISTER)
    .withWildcardSSL();

  cdn = AWS.CloudFront("nlc-cdn")
    .copyFrom(DISTRO.TURKEY_CDN)
    .forDomain(this.domain, ["ec", "nc"]);

  game = AWS.CloudFront("nlc-game")
    .copyFrom(DISTRO.TURKEY_GAME)
    .forDomain(this.domain, ["eg", "ng"]);

  bucket = AWS.S3(BUCKET.NLC_GAMES_UREG).allowFrom(this.cdn, this.game);
}
