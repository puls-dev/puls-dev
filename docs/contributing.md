# Contributing to OpsDSL

## The one rule

**If you can't describe it in one line, it doesn't belong in the DSL.**

Infrastructure is "give me X" — not "give me X with A, I, O, and P." OpsDSL exists to make that true. A VM, a bucket, a distribution. One expression. The complexity lives in the implementation, not the interface.

```typescript
// This is OpsDSL
Proxmox.VM("game-server").image(OS.UBUNTU_24_04).cores(4).memory(8192).provision("config/default.yaml")

// This is not
new VM({ image: "ubuntu", cores: 4, memory: 8192, network: { bridge: "vmbr1", vlan: 2010, virtio: true }, storage: { pool: "rbd_pool", format: "raw", size: "32G" }, cloudinit: { ... } })
```

The DSL is TypeScript. You can write whatever you want around it. But anything that ships *inside* it has to pass the one-liner test.

## The idea that powers OpsDSL

The idea is to make infrastructure easy to describe and deploy, with sane defaults hiding the complexity underneath. You don't need to know how the DSL works — you just need to know what you want. It has no limitations and is designed to be extensible, without ever feeling like you have to reach for custom resources just because the abstraction broke down.

A junior engineer unfamiliar with the underlying platform can spin up a domain with a wildcard certificate, link it to two CloudFront distributions, and wire those to an S3 bucket — all correctly configured and idempotent — without understanding any of the plumbing. Because it's plain TypeScript with typed constants, they get autocomplete, type checking, and a readable stack that a senior engineer would be comfortable owning.

```typescript
@Deploy({ region: REGION.US_EAST_1, dryRun: false })
class Example extends Stack {
  domain = AWS.Route53()
    .withWildcardSSL()
    .randomDomain()
    .register(DOMAIN_REGISTER);

  cdn = AWS.CloudFront(`OPSDSL-${this.domain.zoneName.slice(0, 12)}-CDN`)
    .copyFrom(DISTRO.CDN_DISTRIBUTION)
    .forDomain(this.domain, ["ec", "nc"]);

  game = AWS.CloudFront(`OPSDSL-${this.domain.zoneName.slice(0, 12)}-GAME`)
    .copyFrom(DISTRO.GAME_DISTRIBUTION)
    .forDomain(this.domain, ["eg", "ng"]);

  bucket = AWS.S3(BUCKET.GAMES_BUCKET)
    .allowFrom(this.cdn, this.game)
    .region(REGION.EU_WEST_1);
}
```

---

## What belongs in the DSL

A contribution belongs here if it:

- **Hides real complexity behind a sane default.** The user says what they want. The DSL figures out how. `allowPublicWeb()` opens ports 80 and 443 — the user doesn't think about firewall rules.
- **Is idempotent by default.** Running the same stack twice must always be safe. Every resource checks current state before acting.
- **Follows eager discovery.** The moment a resource is declared, it starts checking the real API in the background. No separate plan step, no local state files.
- **Uses the constants pattern.** IDs, sizes, regions, and credentials live in typed constants — not inline strings.

## What doesn't belong

- Config objects with more than a handful of keys exposed to the user
- Resources that require a specific call order to work correctly
- Escape hatches that let users pass raw provider config through the DSL surface
- Anything that breaks the one-expression-per-resource model

If the use case is genuinely too complex to fit — that's fine. It belongs in userland TypeScript, not in the DSL.

---

## Adding a provider

A new provider must implement:

1. **Eager discovery** in the constructor — `this.discoveryPromise = this.discover(name)`
2. **Idempotent `deploy()`** — check discovery result, skip if already correct
3. **`destroy()`** — stop and remove the resource cleanly
4. **Dry-run support** — `this.isDryRunActive()` gates every API write
5. **Constants** — a types file with named environments (`CONFIG`), images (`OS`), sizes, etc.
6. **Sane defaults** — a resource declared with only a name should be deployable

The existing providers (DigitalOcean, AWS, Proxmox) are the reference implementation. When in doubt, look at how they do it.

---

## The bar for a PR

Before opening a pull request, ask:

> *Can a user express this in one line with obvious method names and no required knowledge of the underlying API?*

If yes — it probably belongs here. If not — simplify the interface until it does, or ship it as a standalone package that wraps the DSL.
