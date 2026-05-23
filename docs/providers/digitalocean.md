# DigitalOcean Provider

## Setup

```
DO_TOKEN=your_digitalocean_token
```

Pass via decorator or call `DO.init()` before declaring resources:

```typescript
@Deploy({ token: process.env.DO_TOKEN! })
class MyStack extends Stack { ... }
```

## Droplet

```typescript
DO.Droplet("prod-web")
  .size(SIZE.MEDIUM)        // s-2vcpu-4gb
  .region(REGION.FRA)       // fra1
  .image(OS.UBUNTU_22_04)   // default if omitted
  .allowPublicWeb()         // creates Firewall sidecar: 80 + 443 open
```

**Constants**

```typescript
import { DO, OS, REGION, SIZE } from "puls-dev/do";

OS.UBUNTU_22_04   // "ubuntu-22-04-x64"
OS.DEBIAN_11      // "debian-11-x64"

REGION.FRA        // "fra1"
REGION.NYC        // "nyc3"

SIZE.SMALL        // s-1vcpu-1gb
SIZE.MEDIUM       // s-2vcpu-4gb
SIZE.LARGE        // s-4vcpu-8gb
```

## Domain

```typescript
DO.Domain("example.com")
  .pointer("@", this.web)   // A record pointing at a Droplet (resolves IP automatically)
  .pointer("api", this.api)
  .withSSL()                // creates Let's Encrypt Certificate sidecar
```

## LoadBalancer

```typescript
DO.LoadBalancer("prod-lb")
  .region(REGION.FRA)
  .target(this.web, this.api)   // forwards to these Droplets
```

## Full example

```typescript
import { Stack, Deploy, Protected } from "puls-dev";
import { DO, OS, REGION, SIZE } from "puls-dev/do";

@Deploy({ token: process.env.DO_TOKEN! })
class Production extends Stack {
  web = DO.Droplet("prod-web")
    .size(SIZE.MEDIUM)
    .region(REGION.FRA)
    .allowPublicWeb();

  @Protected
  db = DO.Droplet("prod-db")
    .size(SIZE.LARGE)
    .region(REGION.FRA);

  dns = DO.Domain("example.com")
    .pointer("@", this.web)
    .withSSL();
}
```
