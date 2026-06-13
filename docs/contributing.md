# Contributing to Puls

## The one rule

**If you can't describe it in one line, it doesn't belong in the DSL.**

Infrastructure is "give me X" - not "give me X configured with A, B, and C." The complexity lives in the implementation, not the interface.

```typescript
// This is Puls
Proxmox.VM("game-server").image(OS.UBUNTU_24_04).cores(4).memory(8192).provision("config/default.yaml")

// This is not
new VM({ image: "ubuntu", cores: 4, memory: 8192, network: { bridge: "vmbr1", vlan: 2010, virtio: true }, storage: { pool: "rbd_pool", format: "raw", size: "32G" }, cloudinit: { ... } })
```

If a use case is too complex to fit a one-liner - that's fine. It belongs in userland TypeScript, not in the DSL. See [Why Puls?](why.md) for the full motivation.

---

## What belongs in the DSL

A contribution belongs here if it:

- **Hides real complexity behind a sane default.** The user says what they want; the DSL figures out how. `allowPublicWeb()` opens ports 80 and 443 - the user doesn't think about firewall rules.
- **Is idempotent by default.** Running the same stack twice must always be safe. Every resource checks current state before acting.
- **Follows eager discovery.** The moment a resource is declared, it starts checking the real API in the background. No separate plan step, no local state files.
- **Uses the constants pattern.** IDs, sizes, regions, and credentials live in typed constants - not inline strings.

## What doesn't belong

- Config objects with more than a handful of keys exposed to the user
- Resources that require a specific call order to work correctly
- Escape hatches that let users pass raw provider config through the DSL surface
- Anything that breaks the one-expression-per-resource model

---

## Adding a provider

A new provider must implement:

1. **Eager discovery** in the constructor - `this.discoveryPromise = this.discover(name)`
2. **Idempotent `deploy()`** - check the discovery result, skip if already correct
3. **`destroy()`** - stop and remove the resource cleanly
4. **Dry-run support** - `this.isDryRunActive()` gates every API write
5. **`Output<T>` fields** - expose primary identifiers (IP, ARN, ID) under `.out` so other resources can depend on them
6. **Constants** - a types file with named environments, images, sizes, etc.
7. **Sane defaults** - a resource declared with only a name should be deployable

The existing providers (AWS, Azure, Cloudflare, DigitalOcean, GCP, Firebase, Proxmox) are the reference implementation. When in doubt, look at how they do it.

---

## The bar for a PR

Before opening a pull request, ask:

> *Can a user express this in one line with obvious method names and no required knowledge of the underlying API?*

If yes - it probably belongs here. If not - simplify the interface until it does, or ship it as a standalone package that wraps the DSL.

---

**Questions?** Join us on Gitter: **pulsdev.io**([Join](https://matrix.to/#/#pulsdevio:gitter.im))
