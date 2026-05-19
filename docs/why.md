# Why Puls?

Infrastructure as Code has always been about **how** to build things - managing state files, wiring up resource dependencies, and wrestling with domain-specific languages like HCL.

Puls was built to shift the focus to **what** you want.

---

## The Problem

Consider a real-world production environment. A Route53 domain, wildcard SSL via ACM, two CloudFront distributions cloning existing configurations, and an S3 bucket with correctly configured Origin Access Control. Not particularly complex in nature - just a standard environment most teams spin up regularly.

In Terraform, this is **550+ lines of HCL**. Manual AWS CLI calls via `null_resource`. Complex `dynamic "origin"` blocks. A hardcoded `time_sleep` of 300 seconds waiting for DNS propagation. External Python scripts to fetch distribution IDs. Manual JSON encoding for bucket policies.

```hcl
# Only run if domain doesn't already exist
provisioner "local-exec" {
  when    = create
  command = <<-EOT
    if aws route53domains get-domain-detail --domain-name ${local.domain} --region us-east-1 2>/dev/null; then
      echo "Domain ${local.domain} already exists, skipping registration"
      exit 0
    fi
  EOT
}

# Wait for domain registration to complete if we're registering
resource "time_sleep" "wait_for_domain" {
  count           = var.register_domain ? 1 : 0
  create_duration = "300s"
  depends_on      = [null_resource.register_domain]
}

# SSL Certificate with wildcard
resource "aws_acm_certificate" "main" {
  provider          = aws.us_east_1
  domain_name       = local.domain
  validation_method = "DNS"

  subject_alternative_names = ["*.${local.domain}"]

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [time_sleep.wait_for_domain]
}

data "external" "cdn_config" {
  program = ["python3", "${path.module}/get_distribution_config.py", var.reference_cdn_distribution_id]
}

data "external" "game_config" {
  program = ["python3", "${path.module}/get_distribution_config.py", var.reference_game_distribution_id]
}

data "external" "distribution_ids" {
  program = ["python3", "${path.module}/get_distribution_ids.py", var.s3_bucket_name]
}

# Locals that depend on data sources
locals {
  zone_id          = var.register_domain ? data.aws_route53_zone.auto_created[0].zone_id : aws_route53_zone.main[0].zone_id
  cdn_config       = jsondecode(data.external.cdn_config.result.config)
  game_config      = jsondecode(data.external.game_config.result.config)
  distribution_ids = jsondecode(data.external.distribution_ids.result.ids)
}
# ... another 450+ lines below
```

A wall of code that is hard to audit, easy to break, and requires deep expertise in both Terraform and AWS internals to maintain. Most companies don't have a dedicated Terraform team. They have engineers who need to ship infrastructure and get back to building product.

Our own junior engineer couldn't make sense of it. He understood what the environment was supposed to do - he just couldn't connect that intent to what the code was actually saying. So he didn't touch it. Nobody touched it unless they had to.

---

## The Solution

The same infrastructure in Puls:

```typescript
import { AWS, AWS_TYPES, Stack, Deploy } from "@puls-dev/core";
const { REGION, DOMAIN_REGISTER, DISTRO, BUCKET } = AWS_TYPES;

@Deploy({ region: REGION.US_EAST_1, dryRun: true })
class TurkeyEnvironment extends Stack {
  domain = AWS.Route53()
    .withWildcardSSL()
    .randomDomain()
    .register(DOMAIN_REGISTER);

  cdn = AWS.CloudFront(`Puls-${this.domain.zoneName.slice(0, 12)}-CDN`)
    .copyFrom(DISTRO.CDN)
    .forDomain(this.domain, ["ec", "nc"]);

  game = AWS.CloudFront(`Puls-${this.domain.zoneName.slice(0, 12)}-GAME`)
    .copyFrom(DISTRO.GAME)
    .forDomain(this.domain, ["eg", "ng"]);

  bucket = AWS.S3(BUCKET.NLC_GAMES_UREG)
    .allowFrom(this.cdn, this.game)
    .region(REGION.EU_WEST_1);
}
```

That junior engineer can read this. He knows what it does without needing to understand ACM validation, OAC policies, or CloudFront distribution cloning. He can make changes, open a PR, and trust that running it twice won't break anything.

That's what Puls is for.

---

The complexity lives in the implementation, not the interface.
