import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { ACMClient } from '@aws-sdk/client-acm';
import { Route53Client } from '@aws-sdk/client-route-53';
import { ACMCertificateBuilder } from './acm.js';
import { Config } from '../../core/config.js';

describe('ACMCertificateBuilder Unit Tests', () => {
  let originalAcmSend: typeof ACMClient.prototype.send;
  let originalR53Send: typeof Route53Client.prototype.send;
  let acmCalls: { commandName: string; input: any }[] = [];
  let r53Calls: { commandName: string; input: any }[] = [];
  let mockAcmResponses: Record<string, any> = {};
  let mockR53Responses: Record<string, any> = {};

  function stubSend(
    calls: { commandName: string; input: any }[],
    responses: Record<string, any>,
  ) {
    return async function (this: any, command: any) {
      const commandName = command.constructor.name;
      calls.push({ commandName, input: command.input });
      const handler = responses[commandName];
      if (handler) {
        if (typeof handler === 'function') return handler(command.input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  }

  beforeEach(() => {
    Config.set({ dryRun: false, providers: { aws: { region: 'us-east-1' } } });
    acmCalls = []; r53Calls = [];
    mockAcmResponses = {}; mockR53Responses = {};

    originalAcmSend = ACMClient.prototype.send;
    originalR53Send = Route53Client.prototype.send;

    ACMClient.prototype.send = stubSend(acmCalls, mockAcmResponses);
    Route53Client.prototype.send = stubSend(r53Calls, mockR53Responses);
  });

  afterEach(() => {
    ACMClient.prototype.send = originalAcmSend;
    Route53Client.prototype.send = originalR53Send;
    mock.restoreAll();
  });

  test('returns null when no matching certificate is found', async () => {
    mockAcmResponses['ListCertificatesCommand'] = { CertificateSummaryList: [] };

    const builder = new ACMCertificateBuilder('example.com');
    const result = await (builder as any).discoveryPromise;

    assert.strictEqual(result, null);
    assert.strictEqual(acmCalls[0].commandName, 'ListCertificatesCommand');
  });

  test('discovers existing wildcard certificate by domain name', async () => {
    mockAcmResponses['ListCertificatesCommand'] = {
      CertificateSummaryList: [
        {
          DomainName: '*.example.com',
          CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc',
        },
      ],
    };

    const builder = new ACMCertificateBuilder('example.com', true);
    const result = await (builder as any).discoveryPromise;

    assert.ok(result);
    assert.strictEqual(builder.resolvedArn, 'arn:aws:acm:us-east-1:123:certificate/abc');
  });

  test('returns existing cert without requesting a new one', async () => {
    mockAcmResponses['ListCertificatesCommand'] = {
      CertificateSummaryList: [
        {
          DomainName: '*.example.com',
          CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc',
          Status: 'ISSUED',
        },
      ],
    };

    const builder = new ACMCertificateBuilder('example.com');
    const result = await builder.deploy();

    assert.strictEqual(result.arn, 'arn:aws:acm:us-east-1:123:certificate/abc');
    assert.ok(!acmCalls.some((c) => c.commandName === 'RequestCertificateCommand'));
  });

  test('performs dry-run without requesting a certificate', async () => {
    Config.set({ dryRun: true, providers: { aws: { region: 'us-east-1' } } });
    mockAcmResponses['ListCertificatesCommand'] = { CertificateSummaryList: [] };

    const builder = new ACMCertificateBuilder('example.com');
    const result = await builder.deploy();

    assert.ok(result.arn!.includes('DRYRUN'));
    assert.ok(!acmCalls.some((c) => c.commandName === 'RequestCertificateCommand'));
  });

  test('requests wildcard cert and writes DNS validation records to Route53', async () => {
    mockAcmResponses['ListCertificatesCommand'] = { CertificateSummaryList: [] };
    mockAcmResponses['RequestCertificateCommand'] = {
      CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/new-cert',
    };

    let describeCallCount = 0;
    mockAcmResponses['DescribeCertificateCommand'] = () => {
      describeCallCount++;
      if (describeCallCount === 1) {
        // First call: validation records ready
        return {
          Certificate: {
            Status: 'PENDING_VALIDATION',
            DomainValidationOptions: [
              {
                ResourceRecord: {
                  Name: '_abc.example.com',
                  Value: '_xyz.acm-validations.aws.',
                },
              },
            ],
          },
        };
      }
      // Second call: ISSUED
      return { Certificate: { Status: 'ISSUED' } };
    };

    mockR53Responses['ChangeResourceRecordSetsCommand'] = {};

    // Fast-forward poll timers
    mock.method(global, 'setTimeout', (fn: any) => fn());

    const builder = new ACMCertificateBuilder('example.com', true);
    builder.forZone({ zoneId: 'Z123456', zoneName: 'example.com' });

    const result = await builder.deploy();

    assert.strictEqual(result.arn, 'arn:aws:acm:us-east-1:123:certificate/new-cert');

    const requestCall = acmCalls.find((c) => c.commandName === 'RequestCertificateCommand');
    assert.ok(requestCall);
    assert.strictEqual(requestCall.input.DomainName, '*.example.com');
    assert.strictEqual(requestCall.input.ValidationMethod, 'DNS');

    const r53Call = r53Calls.find((c) => c.commandName === 'ChangeResourceRecordSetsCommand');
    assert.ok(r53Call);
    assert.strictEqual(r53Call.input.HostedZoneId, 'Z123456');
    const changes = r53Call.input.ChangeBatch.Changes;
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].Action, 'UPSERT');
    assert.ok(changes[0].ResourceRecordSet.Name.includes('_abc'));
  });

  test('deduplicates validation CNAME records before writing to Route53', async () => {
    mockAcmResponses['ListCertificatesCommand'] = { CertificateSummaryList: [] };
    mockAcmResponses['RequestCertificateCommand'] = {
      CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/new-cert',
    };

    let describeCount = 0;
    mockAcmResponses['DescribeCertificateCommand'] = () => {
      describeCount++;
      if (describeCount === 1) {
        return {
          Certificate: {
            Status: 'PENDING_VALIDATION',
            // wildcard + apex SANs produce the same CNAME - duplicated
            DomainValidationOptions: [
              { ResourceRecord: { Name: '_dup.example.com', Value: '_val.aws.' } },
              { ResourceRecord: { Name: '_dup.example.com', Value: '_val.aws.' } },
            ],
          },
        };
      }
      return { Certificate: { Status: 'ISSUED' } };
    };

    mockR53Responses['ChangeResourceRecordSetsCommand'] = {};
    mock.method(global, 'setTimeout', (fn: any) => fn());

    const builder = new ACMCertificateBuilder('example.com', true);
    builder.forZone({ zoneId: 'Z123456', zoneName: 'example.com' });

    await builder.deploy();

    const r53Call = r53Calls.find((c) => c.commandName === 'ChangeResourceRecordSetsCommand');
    assert.ok(r53Call);
    // Should be deduplicated to 1 record
    assert.strictEqual(r53Call.input.ChangeBatch.Changes.length, 1);
  });
});
