# @puls-dev/aws

**AWS Provider for Puls IaC. Declare AWS resources as strongly-typed TypeScript classes with eager live-state discovery.**

---

## What is @puls-dev/aws?

This package is the official AWS provider plug-in for Puls. It translates declarative TypeScript builders into AWS API calls using the AWS SDK v3, offering drift detection, automatic resource adoption, and idempotency out of the box.

## Available Builders

* **`AWS.S3`**: Simple Storage Service buckets and configuration.
* **`AWS.Lambda`**: Serverless function deployment and environment config.
* **`AWS.Fargate`**: Container services running on ECS (automatically sets up clusters, log groups, and IAM roles).
* **`AWS.RDS`**: Managed relational database instances (PostgreSQL, MySQL, SQL Server).
* **`AWS.Route53`**: Hosted zone and DNS record routing.
* **`AWS.APIGateway`**: HTTP APIs and serverless route integration.
* **`AWS.SQS` / `AWS.SNS`**: Simple Queue Service and Simple Notification Service topics.
* **`AWS.IAMRole` / `AWS.IAMPolicy`**: Identity and Access Management policies.

## Installation

```bash
npm install @puls-dev/core @puls-dev/aws
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { AWS, RUNTIME } from "@puls-dev/aws";

@Deploy()
class BackendStack extends Stack {
  bucket = AWS.S3("my-uploads");

  api = AWS.Lambda("image-processor")
    .code("./dist/functions")
    .runtime(RUNTIME.NODEJS_20)
    .env({ BUCKET_NAME: this.bucket.name });
}
```

## Authentication

Set standard AWS SDK environment variables in your `.env` file:
```bash
AWS_ACCESS_KEY_ID=your-key-id
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
```

Learn more at **[pulsdev.io/providers/aws](https://pulsdev.io/providers/aws.md)**.
