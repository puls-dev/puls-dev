# Resource Adoption

Bring existing cloud infrastructure under Puls management without recreating it.

---

## The problem

Some resources were created before Puls existed in your project - manually in the cloud console, by a different tool, or by a team that didn't know about the stack. Puls' normal discovery is name-based: if it can't find the resource by name, it creates one. Adoption gives you a way to say *"this already exists - here's its ID, don't touch it."*

---

## Basic usage

Chain `.adoptId(id)` on any builder. If name-based discovery returns nothing, Puls uses the provided ID as the resource's identity and skips creation entirely.

```typescript
@Deploy({ token: process.env.DO_TOKEN })
class Infra extends Stack {
  db = DO.Database("prod-db").adoptId("a1b2c3d4-existing-cluster-uuid");
}
```

Running this stack:
- **Discovered by name** → normal update path, `adoptId` is a no-op
- **Not found by name** → treated as existing with `id = "a1b2c3d4-..."`, creation is skipped

Configuration mutations (firewall rules, size changes, etc.) still apply in both cases - adoption only prevents recreation.

---

## Cross-stack wiring

`out.id` is resolved automatically from the provided ID. Other outputs (`out.host`, `out.uri`, `out.port`, etc.) depend on fields in the live API response. When adoption kicks in those fields aren't fetched, so chain `.adoptOutput(key, value)` for each one you need downstream.

```typescript
@Deploy({ token: process.env.DO_TOKEN })
class Infra extends Stack {
  db = DO.Database("prod-db")
    .adoptId("a1b2c3d4-existing-cluster-uuid")
    .adoptOutput("host", "private-db.internal.example.com")
    .adoptOutput("port", 25060)
    .adoptOutput("uri", "postgresql://doadmin:pass@private-db.internal.example.com:25060/defaultdb?sslmode=require");

  // out.uri is resolved immediately - no wait, no hang
  api = DO.App("prod-api").env("DATABASE_URL", this.db.out.uri);
}
```

`.adoptOutput` is safe to call even if the builder doesn't have that output key - it silently no-ops.

---

## Behavior reference

| Scenario | What Puls does |
|----------|----------------|
| Discovery finds the resource by name | Normal idempotent update; `adoptId` is ignored |
| Discovery finds nothing, `adoptId` set | Resource treated as existing; creation skipped; `out.id` resolved |
| `adoptOutput` called | Named output resolved immediately, available for downstream wiring |
| `destroy()` called on adopted resource | Destroyed normally; log line notes the adopted ID |
| Dry run | "Already exists" plan printed, no API writes |

---

## Full example

```typescript
@Deploy({ proxmox: CONFIG.PROD, token: process.env.DO_TOKEN })
class Migration extends Stack {
  // VM was created by hand - adopt it, configure DNS, don't recreate
  legacyApp = Proxmox.VM("ix-legacy-app")
    .adoptId("105")
    .adoptOutput("ip", "10.8.10.105");

  dns = DO.Domain("example.com")
    .pointer("legacy", this.legacyApp.out.ip);
}
```
