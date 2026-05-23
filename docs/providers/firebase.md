# Firebase Provider

## Setup

Auth uses a **service account JSON file** from the Firebase console.

1. Go to **Firebase console → Project settings → Service accounts**
2. Click **Generate new private key** → download the JSON file
3. Store it somewhere safe (outside version control)

```bash
FIREBASE_SA=./firebase/service-account.json
```

The `firebase` option in `@Deploy` is optional - if `FIREBASE_SA` is set in your environment, it's picked up automatically.

```typescript
// Explicit
@Deploy({ firebase: process.env.FIREBASE_SA! })

// Or let it read FIREBASE_SA from env
@Deploy({ dryRun: true })
```

---

## Hosting

Deploy a static site from a local build directory.

```typescript
Firebase.Hosting("your-site-id")
  .source("./dist")   // path to your built static files
  .domain("example.com") // optional custom domain
```

The site ID is the Firebase Hosting site name - by default it matches your project ID (e.g. `my-project` → `https://my-project.web.app`). You can override the displayed URL using `.domain("yourdomain.com")`.

**Deploy flow:**

1. Creates a new Hosting version
2. SHA256-hashes all files in the source directory
3. Sends the hash map to Firebase - only files that changed are uploaded
4. Finalizes the version and creates a release
5. Outputs the live URL

**Idempotency:** Each deploy creates a new release (Firebase's native model). Previous releases remain in the console but are inactive.

---

## Full example

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy } from "puls-dev";
import { Firebase } from "puls-dev/firebase";

@Deploy({ dryRun: false })
class DocsSite extends Stack {
  site = Firebase.Hosting("puls-docs")
    .source("./site")
    .domain("pulsdev.io");
}
```

Build your site first, then deploy:

```bash
# MkDocs example
pip install mkdocs-material
mkdocs build              # outputs to ./site
npx tsx examples/docs-blog.ts
```

---

## Service account permissions

The service account needs the **Firebase Hosting Admin** role. In the Firebase console:

**Project settings → Service accounts → Manage service account permissions**

Or via IAM: grant `roles/firebasehosting.admin` to the service account email.
