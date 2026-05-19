import {
  GetApisCommand,
  CreateApiCommand,
  GetIntegrationsCommand,
  CreateIntegrationCommand,
  GetRoutesCommand,
  CreateRouteCommand,
  DeleteApiCommand,
} from "@aws-sdk/client-apigatewayv2";
import { AddPermissionCommand } from "@aws-sdk/client-lambda";
import { BaseBuilder } from "../../core/resource.js";
import { LambdaBuilder } from "./lambda.js";
import { getAPIGWClient, getLambdaClient } from "./api.js";
import { Config } from "../../core/config.js";

type RouteEntry = { method: string; path: string; fn: LambdaBuilder };

export class APIGatewayBuilder extends BaseBuilder {
  private _routes: RouteEntry[] = [];
  resolvedId: string | null = null;
  resolvedEndpoint: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverApi(name);
  }

  private async discoverApi(name: string): Promise<any> {
    try {
      const gw = getAPIGWClient();
      const list = await gw.send(new GetApisCommand({}));
      const match = list.Items?.find((a) => a.Name === name);
      if (match) {
        this.resolvedId = match.ApiId!;
        this.resolvedEndpoint = match.ApiEndpoint ?? null;
      }
      return match ?? null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  route(methodPath: string, fn: LambdaBuilder) {
    const spaceIdx = methodPath.indexOf(" ");
    const method = methodPath.slice(0, spaceIdx).toUpperCase();
    const path = methodPath.slice(spaceIdx + 1);
    this._routes.push({ method, path, fn });
    return this;
  }

  // Single Lambda proxy - forwards all traffic to one function
  proxy(fn: LambdaBuilder) {
    return this.route("ANY /{proxy+}", fn);
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const region = Config.get().providers.aws?.region ?? "us-east-1";
    const gw = getAPIGWClient();

    console.log(`\n⚡ Finalizing API Gateway "${this.name}"...`);

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} HTTP API "${this.name}"`,
      );
      for (const r of this._routes) {
        console.log(`      └─ ${r.method} ${r.path} → ${r.fn.name}`);
      }
      this.resolvedEndpoint = `https://DRYRUN.execute-api.${region}.amazonaws.com`;
      return { name: this.name, endpoint: this.resolvedEndpoint };
    }

    // Create API if it doesn't exist
    if (!existing) {
      const created = await gw.send(
        new CreateApiCommand({
          Name: this.name,
          ProtocolType: "HTTP",
          // Auto-deploy on $default stage - no manual deployment step needed
          RouteSelectionExpression: "$request.method $request.path",
        }),
      );
      this.resolvedId = created.ApiId!;
      this.resolvedEndpoint = created.ApiEndpoint!;
      console.log(`🚀 Created HTTP API "${this.name}" (id=${this.resolvedId})`);

      // $default stage with auto-deploy
      await gw.send(
        new (await import("@aws-sdk/client-apigatewayv2")).CreateStageCommand({
          ApiId: this.resolvedId,
          StageName: "$default",
          AutoDeploy: true,
        }),
      );
    } else {
      console.log(
        `   ✅ HTTP API "${this.name}" exists (id=${this.resolvedId})`,
      );
    }

    // Reconcile routes - only create what's missing
    const existingIntegrations = await gw.send(
      new GetIntegrationsCommand({ ApiId: this.resolvedId! }),
    );
    const existingRoutes = await gw.send(
      new GetRoutesCommand({ ApiId: this.resolvedId! }),
    );

    const integrationByFnArn = new Map<string, string>();
    for (const i of existingIntegrations.Items ?? []) {
      if (i.IntegrationUri)
        integrationByFnArn.set(i.IntegrationUri, i.IntegrationId!);
    }

    const existingRouteKeys = new Set(
      (existingRoutes.Items ?? []).map((r) => r.RouteKey),
    );

    for (const r of this._routes) {
      const fnArn = r.fn.resolvedArn;
      if (!fnArn)
        throw new Error(
          `[APIGateway:${this.name}] Lambda "${r.fn.name}" has no resolvedArn - deploy it before the API.`,
        );

      const integrationUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

      // Reuse existing integration for this Lambda or create a new one
      let integrationId = integrationByFnArn.get(integrationUri);
      if (!integrationId) {
        const integ = await gw.send(
          new CreateIntegrationCommand({
            ApiId: this.resolvedId!,
            IntegrationType: "AWS_PROXY",
            IntegrationUri: integrationUri,
            PayloadFormatVersion: "2.0",
          }),
        );
        integrationId = integ.IntegrationId!;
        integrationByFnArn.set(integrationUri, integrationId);
        console.log(`   ✅ Created integration → ${r.fn.name}`);
      }

      const routeKey = `${r.method} ${r.path}`;
      if (!existingRouteKeys.has(routeKey)) {
        await gw.send(
          new CreateRouteCommand({
            ApiId: this.resolvedId!,
            RouteKey: routeKey,
            Target: `integrations/${integrationId}`,
          }),
        );
        console.log(`   ✅ Route: ${routeKey} → ${r.fn.name}`);
      } else {
        console.log(`   ✅ Route already exists: ${routeKey}`);
      }

      // Grant API Gateway permission to invoke this Lambda (idempotent)
      await this.grantInvokePermission(fnArn, region);
    }

    console.log(`   🌐 Endpoint: ${this.resolvedEndpoint}`);
    await this.deploySidecars();
    return {
      name: this.name,
      endpoint: this.resolvedEndpoint,
      id: this.resolvedId,
    };
  }

  private async grantInvokePermission(fnArn: string, region: string) {
    const accountId = fnArn.split(":")[4];
    const statementId = `puls-apigw-${this.resolvedId}`;
    try {
      await getLambdaClient().send(
        new AddPermissionCommand({
          FunctionName: fnArn,
          StatementId: statementId,
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceArn: `arn:aws:execute-api:${region}:${accountId}:${this.resolvedId}/*/*`,
        }),
      );
    } catch (e: any) {
      // Permission already exists - idempotent
      if (e.name !== "ResourceConflictException") throw e;
    }
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying API Gateway "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ API "${this.name}" does not exist - nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Delete HTTP API "${this.name}" (id=${this.resolvedId})`,
      );
      return { destroyed: this.name };
    }

    await getAPIGWClient().send(
      new DeleteApiCommand({ ApiId: this.resolvedId! }),
    );
    console.log(`   ✅ Deleted API "${this.name}"`);
    return { destroyed: this.name };
  }
}
