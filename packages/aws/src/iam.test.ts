import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'assert';
import fs from 'node:fs';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { AWS } from './index.js';
import { Config } from '@puls-dev/core';
import { IAMRoleBuilder, IAMPolicyBuilder } from './iam.js';
import { LambdaBuilder } from './lambda.js';

describe('AWS IAM Builders Unit Tests', () => {
  let originalSend: typeof IAMClient.prototype.send;
  let iamCalls: { commandName: string; input: any }[] = [];
  let mockIamResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: 'us-east-1' }
      }
    });

    iamCalls = [];
    mockIamResponses = {};

    originalSend = IAMClient.prototype.send;

    // FS Mocking to return a fake zip buffer when reading the code package
    mock.method(fs, 'readFileSync', () => {
      return Buffer.from('mock-zip-binary-payload');
    });

    // Intercept all IAM command sends
    IAMClient.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      iamCalls.push({ commandName, input });

      if (mockIamResponses[commandName]) {
        const handler = mockIamResponses[commandName];
        if (typeof handler === 'function') return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  });

  afterEach(() => {
    IAMClient.prototype.send = originalSend;
    mock.restoreAll();
  });

  describe('IAMPolicyBuilder Tests', () => {
    test('gracefully handles discovery when policy does not exist', async () => {
      mockIamResponses['ListPoliciesCommand'] = { Policies: [] };

      const builder = new IAMPolicyBuilder('my-policy');
      const discoveryResult = await (builder as any).discoveryPromise;

      assert.strictEqual(discoveryResult, null);
      assert.strictEqual(iamCalls.length, 1);
      assert.strictEqual(iamCalls[0].commandName, 'ListPoliciesCommand');
    });

    test('discovers policy successfully when it exists', async () => {
      const expectedArn = 'arn:aws:iam::123456789012:policy/my-policy';
      mockIamResponses['ListPoliciesCommand'] = {
        Policies: [{ PolicyName: 'my-policy', Arn: expectedArn }]
      };

      const builder = new IAMPolicyBuilder('my-policy');
      const discoveryResult = await (builder as any).discoveryPromise;

      assert.ok(discoveryResult);
      assert.strictEqual(builder.resolvedArn, expectedArn);

      const resolvedArn = await builder.out.arn.get();
      assert.strictEqual(resolvedArn, expectedArn);
    });

    test('performs dry-run planning without making writes', async () => {
      Config.set({
        dryRun: true,
        providers: { aws: { region: 'us-east-1' } }
      });

      mockIamResponses['ListPoliciesCommand'] = { Policies: [] };

      const builder = new IAMPolicyBuilder('my-policy')
        .document({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }]
        })
        .description('Friendly desc');

      const result = await builder.deploy();
      assert.ok(result);
      assert.strictEqual(result.arn, 'arn:aws:iam::000000000000:policy/DRYRUN-my-policy');

      // Assert only discovery ListPolicies was sent, no writes
      const writeCalls = iamCalls.filter(c => c.commandName !== 'ListPoliciesCommand');
      assert.strictEqual(writeCalls.length, 0);
    });

    test('deploys new policy when missing', async () => {
      mockIamResponses['ListPoliciesCommand'] = { Policies: [] };
      mockIamResponses['CreatePolicyCommand'] = {
        Policy: { Arn: 'arn:aws:iam::123456789012:policy/my-policy' }
      };

      const builder = new IAMPolicyBuilder('my-policy')
        .document({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }]
        })
        .description('My S3 Access Policy');

      const result = await builder.deploy();
      assert.ok(result);
      assert.strictEqual(result.arn, 'arn:aws:iam::123456789012:policy/my-policy');

      const createCall = iamCalls.find(c => c.commandName === 'CreatePolicyCommand');
      assert.ok(createCall);
      assert.strictEqual(createCall.input.PolicyName, 'my-policy');
      assert.strictEqual(createCall.input.Description, 'My S3 Access Policy');
      assert.deepStrictEqual(JSON.parse(createCall.input.PolicyDocument), {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }]
      });
    });

    test('updates policy creating new version and pruning oldest if versions >= 5', async () => {
      const policyArn = 'arn:aws:iam::123456789012:policy/my-policy';
      mockIamResponses['ListPoliciesCommand'] = {
        Policies: [{ PolicyName: 'my-policy', Arn: policyArn }]
      };
      
      // Simulate 5 existing versions
      mockIamResponses['ListPolicyVersionsCommand'] = {
        Versions: [
          { VersionId: 'v1', IsDefaultVersion: false, CreateDate: new Date('2026-01-01') },
          { VersionId: 'v2', IsDefaultVersion: false, CreateDate: new Date('2026-01-02') },
          { VersionId: 'v3', IsDefaultVersion: false, CreateDate: new Date('2026-01-03') },
          { VersionId: 'v4', IsDefaultVersion: false, CreateDate: new Date('2026-01-04') },
          { VersionId: 'v5', IsDefaultVersion: true, CreateDate: new Date('2026-01-05') },
        ]
      };
      mockIamResponses['DeletePolicyVersionCommand'] = {};
      mockIamResponses['CreatePolicyVersionCommand'] = {};

      const builder = new IAMPolicyBuilder('my-policy')
        .document({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }]
        });

      await builder.deploy();

      // Assert oldest version v1 was deleted
      const deleteCall = iamCalls.find(c => c.commandName === 'DeletePolicyVersionCommand');
      assert.ok(deleteCall);
      assert.strictEqual(deleteCall.input.PolicyArn, policyArn);
      assert.strictEqual(deleteCall.input.VersionId, 'v1');

      // Assert new version was created
      const versionCall = iamCalls.find(c => c.commandName === 'CreatePolicyVersionCommand');
      assert.ok(versionCall);
      assert.strictEqual(versionCall.input.PolicyArn, policyArn);
      assert.strictEqual(versionCall.input.SetAsDefault, true);
    });

    test('destroys custom managed policy and cleans up versions successfully', async () => {
      const policyArn = 'arn:aws:iam::123456789012:policy/my-policy';
      mockIamResponses['ListPoliciesCommand'] = {
        Policies: [{ PolicyName: 'my-policy', Arn: policyArn }]
      };
      mockIamResponses['ListPolicyVersionsCommand'] = {
        Versions: [
          { VersionId: 'v1', IsDefaultVersion: false },
          { VersionId: 'v2', IsDefaultVersion: true }
        ]
      };
      mockIamResponses['DeletePolicyVersionCommand'] = {};
      mockIamResponses['DeletePolicyCommand'] = {};

      const builder = new IAMPolicyBuilder('my-policy');
      await (builder as any).discoveryPromise;

      const result = await builder.destroy();
      assert.deepStrictEqual(result, { destroyed: 'my-policy' });

      // Non-default version v1 must be deleted
      const deleteVersionCall = iamCalls.find(c => c.commandName === 'DeletePolicyVersionCommand');
      assert.ok(deleteVersionCall);
      assert.strictEqual(deleteVersionCall.input.VersionId, 'v1');

      // Main policy deleted
      const deletePolicyCall = iamCalls.find(c => c.commandName === 'DeletePolicyCommand');
      assert.ok(deletePolicyCall);
      assert.strictEqual(deletePolicyCall.input.PolicyArn, policyArn);
    });
  });

  describe('IAMRoleBuilder Tests', () => {
    test('gracefully handles discovery when role does not exist', async () => {
      const noRoleError = new Error('NoSuchEntityException');
      noRoleError.name = 'NoSuchEntityException';
      mockIamResponses['GetRoleCommand'] = noRoleError;

      const builder = new IAMRoleBuilder('my-role');
      const discoveryResult = await (builder as any).discoveryPromise;

      assert.strictEqual(discoveryResult, null);
      assert.strictEqual(iamCalls.length, 1);
      assert.strictEqual(iamCalls[0].commandName, 'GetRoleCommand');
    });

    test('discovers role successfully when it exists', async () => {
      const expectedArn = 'arn:aws:iam::123456789012:role/my-role';
      mockIamResponses['GetRoleCommand'] = {
        Role: { RoleName: 'my-role', Arn: expectedArn }
      };

      const builder = new IAMRoleBuilder('my-role');
      const discoveryResult = await (builder as any).discoveryPromise;

      assert.ok(discoveryResult);
      assert.strictEqual(builder.resolvedArn, expectedArn);

      const resolvedArn = await builder.out.arn.get();
      assert.strictEqual(resolvedArn, expectedArn);

      const resolvedName = await builder.out.name.get();
      assert.strictEqual(resolvedName, 'my-role');
    });

    test('performs dry-run planning without making writes', async () => {
      Config.set({
        dryRun: true,
        providers: { aws: { region: 'us-east-1' } }
      });

      const noRoleError = new Error('NoSuchEntityException');
      noRoleError.name = 'NoSuchEntityException';
      mockIamResponses['GetRoleCommand'] = noRoleError;

      const builder = new IAMRoleBuilder('my-role')
        .assumeRolePolicy({
          Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]
        });

      const result = await builder.deploy();
      assert.ok(result);
      assert.strictEqual(result.arn, 'arn:aws:iam::000000000000:role/DRYRUN-my-role');

      // Only discovery GetRole was sent
      const writeCalls = iamCalls.filter(c => c.commandName !== 'GetRoleCommand');
      assert.strictEqual(writeCalls.length, 0);
    });

    test('deploys new role with assume-role trust policy, managed attachments, and inline statements', async () => {
      const noRoleError = new Error('NoSuchEntityException');
      noRoleError.name = 'NoSuchEntityException';
      mockIamResponses['GetRoleCommand'] = noRoleError;

      const expectedArn = 'arn:aws:iam::123456789012:role/my-role';
      mockIamResponses['CreateRoleCommand'] = { Role: { Arn: expectedArn } };
      mockIamResponses['ListAttachedRolePoliciesCommand'] = { AttachedPolicies: [] };
      mockIamResponses['AttachRolePolicyCommand'] = {};
      mockIamResponses['ListRolePoliciesCommand'] = { PolicyNames: [] };
      mockIamResponses['PutRolePolicyCommand'] = {};

      const builder = new IAMRoleBuilder('my-role')
        .assumeRolePolicy({
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
        })
        .attach('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')
        .inlinePolicy('my-inline', {
          Statement: [{ Effect: 'Allow', Action: 'sqs:*', Resource: '*' }]
        });

      const result = await builder.deploy();
      assert.ok(result);
      assert.strictEqual(result.arn, expectedArn);

      // Verify CreateRole arguments
      const createCall = iamCalls.find(c => c.commandName === 'CreateRoleCommand');
      assert.ok(createCall);
      assert.strictEqual(createCall.input.RoleName, 'my-role');
      assert.deepStrictEqual(JSON.parse(createCall.input.AssumeRolePolicyDocument), {
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
      });

      // Verify Managed Policy attachment
      const attachCall = iamCalls.find(c => c.commandName === 'AttachRolePolicyCommand');
      assert.ok(attachCall);
      assert.strictEqual(attachCall.input.RoleName, 'my-role');
      assert.strictEqual(attachCall.input.PolicyArn, 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess');

      // Verify Inline Policy creation
      const inlineCall = iamCalls.find(c => c.commandName === 'PutRolePolicyCommand');
      assert.ok(inlineCall);
      assert.strictEqual(inlineCall.input.RoleName, 'my-role');
      assert.strictEqual(inlineCall.input.PolicyName, 'my-inline');
      assert.deepStrictEqual(JSON.parse(inlineCall.input.PolicyDocument), {
        Statement: [{ Effect: 'Allow', Action: 'sqs:*', Resource: '*' }]
      });
    });

    test('updates existing role, syncing managed policy attachments and inline policies', async () => {
      mockIamResponses['GetRoleCommand'] = {
        Role: { RoleName: 'my-role', Arn: 'arn:aws:iam::123456789012:role/my-role' }
      };
      mockIamResponses['UpdateAssumeRolePolicyCommand'] = {};
      mockIamResponses['UpdateRoleCommand'] = {};

      // Current managed policies: AmazonS3ReadOnlyAccess, AmazonDynamoDBFullAccess (stale)
      mockIamResponses['ListAttachedRolePoliciesCommand'] = {
        AttachedPolicies: [
          { PolicyName: 'AmazonS3ReadOnlyAccess', PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' },
          { PolicyName: 'AmazonDynamoDBFullAccess', PolicyArn: 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess' }
        ]
      };
      mockIamResponses['AttachRolePolicyCommand'] = {};
      mockIamResponses['DetachRolePolicyCommand'] = {};

      // Current inline policies: stale-inline, matching-inline
      mockIamResponses['ListRolePoliciesCommand'] = {
        PolicyNames: ['stale-inline', 'matching-inline']
      };
      mockIamResponses['PutRolePolicyCommand'] = {};
      mockIamResponses['DeleteRolePolicyCommand'] = {};

      // Configured builder wants: AmazonS3ReadOnlyAccess, AmazonSQSFullAccess (new), and 'matching-inline'
      const builder = new IAMRoleBuilder('my-role')
        .attach('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')
        .attach('arn:aws:iam::aws:policy/AmazonSQSFullAccess')
        .inlinePolicy('matching-inline', {
          Statement: [{ Effect: 'Allow', Action: 'sqs:*', Resource: '*' }]
        });

      await builder.deploy();

      // Assert Detach is called on stale AmazonDynamoDBFullAccess
      const detachCall = iamCalls.find(c => c.commandName === 'DetachRolePolicyCommand');
      assert.ok(detachCall);
      assert.strictEqual(detachCall.input.PolicyArn, 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess');

      // Assert Attach is called on new AmazonSQSFullAccess
      const attachCall = iamCalls.find(c => c.commandName === 'AttachRolePolicyCommand');
      assert.ok(attachCall);
      assert.strictEqual(attachCall.input.PolicyArn, 'arn:aws:iam::aws:policy/AmazonSQSFullAccess');

      // Assert Delete is called on stale-inline policy
      const deleteInlineCall = iamCalls.find(c => c.commandName === 'DeleteRolePolicyCommand');
      assert.ok(deleteInlineCall);
      assert.strictEqual(deleteInlineCall.input.PolicyName, 'stale-inline');

      // Assert Put is called on matching-inline policy
      const putInlineCall = iamCalls.find(c => c.commandName === 'PutRolePolicyCommand');
      assert.ok(putInlineCall);
      assert.strictEqual(putInlineCall.input.PolicyName, 'matching-inline');
    });

    test('destroys existing role cleaning up inline policies and managed attachments', async () => {
      mockIamResponses['GetRoleCommand'] = {
        Role: { RoleName: 'my-role', Arn: 'arn:aws:iam::123456789012:role/my-role' }
      };
      mockIamResponses['ListRolePoliciesCommand'] = { PolicyNames: ['inline-one'] };
      mockIamResponses['DeleteRolePolicyCommand'] = {};
      mockIamResponses['ListAttachedRolePoliciesCommand'] = {
        AttachedPolicies: [{ PolicyName: 'S3Access', PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' }]
      };
      mockIamResponses['DetachRolePolicyCommand'] = {};
      mockIamResponses['DeleteRoleCommand'] = {};

      const builder = new IAMRoleBuilder('my-role');
      await (builder as any).discoveryPromise;

      const result = await builder.destroy();
      assert.deepStrictEqual(result, { destroyed: 'my-role' });

      // Inline policy deleted
      const deleteInline = iamCalls.find(c => c.commandName === 'DeleteRolePolicyCommand');
      assert.ok(deleteInline);
      assert.strictEqual(deleteInline.input.PolicyName, 'inline-one');

      // Managed policy detached
      const detachCall = iamCalls.find(c => c.commandName === 'DetachRolePolicyCommand');
      assert.ok(detachCall);
      assert.strictEqual(detachCall.input.PolicyArn, 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess');

      // Role deleted
      const deleteRole = iamCalls.find(c => c.commandName === 'DeleteRoleCommand');
      assert.ok(deleteRole);
      assert.strictEqual(deleteRole.input.RoleName, 'my-role');
    });
  });

  describe('Lambda Integration', () => {
    test('LambdaBuilder accepts IAMRoleBuilder and resolves its eager output ARN successfully', async () => {
      // 1. Mock Role discovery to succeed
      const expectedRoleArn = 'arn:aws:iam::123456789012:role/my-custom-role';
      mockIamResponses['GetRoleCommand'] = {
        Role: { RoleName: 'my-custom-role', Arn: expectedRoleArn }
      };

      const roleBuilder = new IAMRoleBuilder('my-custom-role');

      // 2. Mock Lambda discovery to report not found (forces deploy ensureRole)
      let lambdaCalls: { commandName: string; input: any }[] = [];
      const originalLambdaSend = LambdaClient.prototype.send;
      
      LambdaClient.prototype.send = async function(command: any) {
        const commandName = command.constructor.name;
        lambdaCalls.push({ commandName, input: command.input });
        if (commandName === 'GetFunctionCommand') {
          const notFoundError = new Error('Function not found');
          notFoundError.name = 'ResourceNotFoundException';
          throw notFoundError;
        }
        return { FunctionArn: 'arn:aws:lambda:us-east-1:12345:function:my-fn' };
      } as any;

      // Mock fast-forward setTimeout
      mock.method(global, 'setTimeout', (fn: any) => fn());

      const lambdaBuilder = new LambdaBuilder('my-fn');
      lambdaBuilder
        .code('my-code.zip')
        .role(roleBuilder); // custom role builder integration!

      await lambdaBuilder.deploy();

      // Assert Lambda was created using the custom role builder's ARN eagerly
      const createFnCall = lambdaCalls.find(c => c.commandName === 'CreateFunctionCommand');
      assert.ok(createFnCall);
      assert.strictEqual(createFnCall.input.Role, expectedRoleArn);

      LambdaClient.prototype.send = originalLambdaSend;
    });
  });
});
