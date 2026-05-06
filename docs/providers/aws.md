# AWS Provider

## Setup

Uses standard AWS SDK environment variables:

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
```

Pass the region via decorator:

```typescript
@Deploy({ region: REGION.US_EAST_1 })
class MyStack extends Stack { ... }
```

## Route53

Hosted zone discovery and domain registration.

```typescript
// Use an existing domain
AWS.Route53("example.com")

// Generate a random .com domain and register it
AWS.Route53().randomDomain().register(DOMAIN_REGISTER)

// Attach a wildcard ACM certificate (sidecar)
AWS.Route53("example.com").withWildcardSSL()
```

`register()` takes a `RegistrantContact`:

```typescript
import { DOMAIN_REGISTER } from "./src/types/aws.ts";

// DOMAIN_REGISTER is the NLC default contact — edit src/types/aws.ts to change it
AWS.Route53().randomDomain().register(DOMAIN_REGISTER).withWildcardSSL()
```

## CloudFront

Clone an existing distribution and attach it to a domain.

```typescript
AWS.CloudFront("my-distro-name")
  .copyFrom(DISTRO.TURKEY_CDN)              // clone from existing distribution ID
  .forDomain(this.domain, ["ec", "nc"])     // creates CNAMEs: ec.zoneName, nc.zoneName
```

`.forDomain()` wires up the cert from the Route53 sidecar automatically. CloudFront waits up to 5 minutes for cert propagation before creating the distribution.

**Constants**

```typescript
import { DISTRO } from "./src/types/aws.ts";

DISTRO.TURKEY_CDN   // E1WU2O39ZREE9O
DISTRO.TURKEY_GAME  // E1KFYIGPYK8UVJ
```

## S3

```typescript
AWS.S3("my-bucket-name")
  .allowFrom(this.cdn, this.game)   // adds CloudFront OAC policy for each distro
  .region(REGION.EU_WEST_1)         // bucket is in a non-default region
```

`.allowFrom()` merges the CloudFront principal statement into the existing bucket policy without overwriting other statements. Uses principal-based lookup (not Sid) so it works regardless of existing policy structure.

## ACM

ACM certificates are managed automatically as Route53 sidecars — you don't use `AWS.ACM()` directly.

`.withWildcardSSL()` on a Route53 builder:
1. Requests a wildcard cert for `*.zoneName`
2. Writes the DNS validation CNAME to the hosted zone
3. Waits for the cert to reach `ISSUED` status (up to 10 minutes)

## Full example

```typescript
import { AWS } from "./src/providers/aws/index.ts";
import { BUCKET, DISTRO, DOMAIN_REGISTER, REGION } from "./src/types/aws.ts";
import { Stack } from "./src/core/stack.ts";
import { Deploy } from "./src/core/decorators.ts";

@Deploy({ region: REGION.US_EAST_1 })
class TurkeyEnvironment extends Stack {
  domain = AWS.Route53()
    .withWildcardSSL()
    .randomDomain()
    .register(DOMAIN_REGISTER);

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
```
