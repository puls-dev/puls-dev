---
date: 2026-06-24
authors:
  - bia
categories:
  - Architecture
  - Security
---

# Dynamic Secret Injection: Zero-Hardcoding Credentials in Puls

Hardcoding credentials in your version control system is one of the most common ways security leaks happen. Whether it's an API token, a database root password, or a service account key, committing credentials to Git is a recipe for disaster.

Yet, managing these secrets on team projects is often painful. Developers end up sharing `.env` files via Slack, updating private vaults manually, or writing complex bootstrap scripts.

Puls solves this with **Secrets at Deploy Time**: a lazy-resolved, type-safe secret engine that fetches passwords directly from secure cloud vaults when deploying, with native injection into your VM environments and provisioning scripts.

<!-- more -->

---

## The Core Concept: Lazy Resolution

In Puls, secrets are represented by the `Secret` class. Instead of resolving the values when the file is read or when the stack is instantiated, `Secret` acts as a secure, lazy wrapper.

Puls support multiple vaults out of the box with zero boilerplate:

```typescript
import { Secret } from "puls-dev";

// Fetch from AWS Secrets Manager
const dbPassword = Secret.aws("prod/database/password", { region: "us-east-1" });

// Fetch from GCP Secret Manager
const jwtSecret = Secret.gcp("jwt-private-key");

// Fallback to local environment variable
const stripeKey = Secret.env("STRIPE_API_KEY", "fallback-key");
```

Because of Puls's **zero-dependency architecture**, the heavy AWS or GCP SDKs are only imported dynamically if you explicitly call `Secret.aws()` or `Secret.gcp()`. If you don't use them, you don't need them in your `package.json`.

---

## Production Pattern: Dynamic Secrets to Ansible

Let's look at a real-world production pattern. Suppose you are deploying a virtual machine and configuring an FreeIPA client, which requires a sensitive admin password. 

Instead of embedding the password anywhere in your provisioning repositories, you can declare it in a centralized secrets file:

```typescript
// aws-infra/secrets.ts
import { Secret } from "puls-dev";

export const IPA_PASSWORD = Secret.aws("IPA_CLIENT_PASSWORD", {
  region: "eu-west-1",
});
```

Inside your stack configuration, you import the secret and bind it to the builder environment using the `.env()` method:

```typescript
// proxmox-infra/stacks/vms.ts
import { Stack, Deploy } from "puls-dev";
import { Proxmox } from "puls-dev/proxmox";
import { IPA_PASSWORD } from "../../aws-infra/secrets";

@Deploy()
class VMStack extends Stack {
  server = Proxmox.VM("ipa-client-node")
    .cores(2)
    .memory(4096)
    // Inject the resolved secret into the provisioning process's environment
    .env({ IPA_CLIENT_PASSWORD: IPA_PASSWORD });
    .provision("playbooks/configure-ipa.yaml")
}
```

Finally, in your Ansible playbook or tasks (`playbooks/configure-ipa.yaml`), you can cleanly fetch the password from the environment lookup:

```yaml
- name: Configure FreeIPA Client
  hosts: all
  vars:
    ipaclient_password: "{{ lookup('ansible.builtin.env', 'IPA_CLIENT_PASSWORD') | default('', true) }}"
  tasks:
    - name: Register client to IPA realm
      freeipa.ansible_freeipa.ipaclient:
        state: present
        password: "{{ ipaclient_password }}"
        # ...
```

This is simple, elegant, and completely secure. The password resides inside AWS Secrets Manager. When you deploy, Puls fetches the secret, sets it as an environment variable for the duration of the Ansible process execution, and then cleans it up. It never gets written to disk or printed in the deployment logs.

---

## Safe Dry Runs

Testing your infrastructure should never require having access to real production secrets on your local machine. Puls respects this by intercepting secret resolution during dry runs:

If `dryRun: true` is configured on the stack, all dynamic secret fetchers skip network requests and resolve immediately to a secure placeholder string:

```typescript
`[SECRET:name]`
```

This allows developers to run `puls plan` or dry-run deployments locally with zero cloud API keys configured.

---

## Post-Deploy Local Testing: `.env.puls`

What happens if your local application server or test scripts need access to these secrets after a successful deployment? 

To prevent developers from needing to manual copy-paste credentials, Puls automatically aggregates all environment variables defined in your stacks and merges them into a local `.env.puls` file at your workspace root upon successful deployment.

You can then run local processes or tests with access to the actual secrets:

```bash
# Run local tests using the resolved deploy-time secrets
dotenv -e .env.puls npm run test
```

By making secrets lazy, secure, and deeply integrated into VM provisioning, Puls ensures that the secure path is also the easiest path.

---

*To learn more, check out the full [Secrets at Deploy Time](../../secrets.md) documentation.*
