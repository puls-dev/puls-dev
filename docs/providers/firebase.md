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

## App Check

Declaratively manage App Check attestation enforcement modes for primary backend services.

```typescript
Firebase.AppCheck()
  .enforce("firestore")
  .unenforced("storage")
  .off("auth");
```

**Supported Services:**

| Service Name | API Target |
|--------------|------------|
| `firestore` | `firestore.googleapis.com` (Cloud Firestore) |
| `storage` | `firebasestorage.googleapis.com` (Cloud Storage) |
| `database` | `firebasedatabase.googleapis.com` (Realtime Database) |
| `auth` | `identitytoolkit.googleapis.com` (Firebase Authentication) |

On deploy, Puls queries the current enforcement statuses and patches services whose configurations differ. In teardowns (`destroy()`), Puls automatically reverts all configured services back to `"OFF"` to leave the environment clean.

---

## Firestore

Deploy Cloud Firestore security rules and configure composite indexes.

```typescript
Firebase.Firestore()
  .rules("./firestore.rules")
  .indexes("./firestore.indexes.json");
```

---

## Storage

Manage Cloud Storage rules and CORS policies.

```typescript
Firebase.Storage("my-bucket")
  .rules("./storage.rules")
  .cors([
    {
      origin: ["*"],
      method: ["GET", "POST", "PUT"],
      responseHeader: ["Content-Type"],
      maxAgeSeconds: 3600,
    },
  ]);
```

---

## Auth

Configure Authentication sign-in providers and authorized domains.

```typescript
Firebase.Auth()
  .email(true)                    // Enable email/password sign-in
  .anonymous(true)                // Enable anonymous access
  .authorizedDomains(["example.com", "my-app.web.app"]);
```

---

## Remote Config

Declare typed parameters and conditions for Firebase Remote Config templates with ETag-safe PUT operations.

```typescript
Firebase.RemoteConfig()
  .string("welcome_message", "Hello, World!")
  .bool("feature_flag_active", true)
  .number("max_retries", 3)
  .condition("is_android", "device.os == 'android'")
  .override("welcome_message", "is_android", "Hello from Android!");
```

---

## Full example

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy } from "puls-dev";
import { Firebase } from "puls-dev/firebase";

@Deploy({ dryRun: false })
class AppStack extends Stack {
  // Static Hosting
  site = Firebase.Hosting("my-app-hosting")
    .source("./dist")
    .domain("myapp.io");

  // Backend Security Attestation
  appcheck = Firebase.AppCheck()
    .enforce("firestore")
    .enforce("storage");

  // Database Rules
  db = Firebase.Firestore()
    .rules("./firestore.rules");

  // Storage configuration
  bucket = Firebase.Storage("my-app-media")
    .rules("./storage.rules");

  // Authentication configuration
  auth = Firebase.Auth()
    .email(true)
    .authorizedDomains(["myapp.io"]);
}
```

Build your site first, then deploy:

```bash
# Web application build example
npm run build              # outputs static assets to ./dist
npx tsx examples/deploy.ts
```

---

## Service account permissions

The service account needs the **Firebase Hosting Admin**, **App Check Admin**, **Cloud Datastore Owner**, and **App Engine Admin** roles depending on which features you use.

Ensure these roles are granted via IAM to the service account email in your GCP Console under **IAM & Admin → IAM**.
