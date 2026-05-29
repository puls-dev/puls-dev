import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Route53Client } from '@aws-sdk/client-route-53';
import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { Route53Builder } from './route53.js';
import { Config } from '../../core/config.js';

describe('Route53Builder Unit Tests', () => {
  let originalR53Send: typeof Route53Client.prototype.send;
  let originalDomainsSend: typeof Route53DomainsClient.prototype.send;
  let r53Calls: { commandName: string; input: any }[] = [];
  let domainsCalls: { commandName: string; input: any }[] = [];
  let mockR53Responses: Record<string, any> = {};
  let mockDomainsResponses: Record<string, any> = {};

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {
        aws: { region: 'us-east-1' }
      }
    });

    r53Calls = [];
    domainsCalls = [];
    mockR53Responses = {};
    mockDomainsResponses = {};

    originalR53Send = Route53Client.prototype.send;
    originalDomainsSend = Route53DomainsClient.prototype.send;

    // Prototype mocks to intercept Route53 and Route53 Domains API commands
    Route53Client.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      r53Calls.push({ commandName, input });

      if (mockR53Responses[commandName]) {
        const handler = mockR53Responses[commandName];
        if (typeof handler === 'function') return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;

    Route53DomainsClient.prototype.send = async function(command: any) {
      const commandName = command.constructor.name;
      const input = command.input;
      domainsCalls.push({ commandName, input });

      if (mockDomainsResponses[commandName]) {
        const handler = mockDomainsResponses[commandName];
        if (typeof handler === 'function') return handler(input);
        if (handler instanceof Error) throw handler;
        return handler;
      }
      return {};
    } as any;
  });

  afterEach(() => {
    Route53Client.prototype.send = originalR53Send;
    Route53DomainsClient.prototype.send = originalDomainsSend;
  });

  test('gracefully handles discovery when hosted zone does not exist', async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = { HostedZones: [] };

    const builder = new Route53Builder('example.com');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.strictEqual(discoveryResult, null);
    assert.strictEqual(r53Calls.length, 1);
    assert.strictEqual(r53Calls[0].commandName, 'ListHostedZonesByNameCommand');
    assert.strictEqual(r53Calls[0].input.DNSName, 'example.com');
  });

  test('discovers hosted zone successfully when it exists', async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = {
      HostedZones: [{ Id: '/hostedzone/Z111222', Name: 'example.com.' }]
    };

    const builder = new Route53Builder('example.com');
    const discoveryResult = await (builder as any).discoveryPromise;

    assert.ok(discoveryResult);
    assert.strictEqual(discoveryResult.Id, '/hostedzone/Z111222');
    assert.strictEqual(builder.zoneId, 'Z111222');

    const resolved = await builder.out.zone.get();
    assert.deepStrictEqual(resolved, { name: 'example.com', id: 'Z111222' });
  });

  test('performs clean dry-run planning without making write requests', async () => {
    Config.set({
      dryRun: true,
      providers: { aws: { region: 'us-east-1' } }
    });

    mockR53Responses['ListHostedZonesByNameCommand'] = { HostedZones: [] };

    const builder = new Route53Builder('example.com');
    builder
      .record('@', 'A', '1.2.3.4')
      .withWildcardSSL()
      .register({
        FIRSTNAME: 'Jane', LASTNAME: 'Doe', EMAIL: 'jane@example.com',
        MOBILE: '+1.5555550100', CONTACT_TYPE: 'PERSON', ORGANIZATION: 'N/A',
        ADDRESSLINE: '123 Main St', CITY: 'Seattle', ZIPCODE: '98101', COUNTRY: 'US'
      });

    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.zone, 'example.com');

    // Hosted zone, certificate validations, domain registrations are planned, but no writes occur
    const writeCalls = r53Calls.filter(c => c.commandName !== 'ListHostedZonesByNameCommand');
    assert.strictEqual(writeCalls.length, 0);
    assert.strictEqual(domainsCalls.length, 0);

    const resolved = await builder.out.zone.get();
    assert.deepStrictEqual(resolved, { name: 'example.com', id: 'PENDING' });
  });

  test('deploys new hosted zone when missing', async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = { HostedZones: [] };
    mockR53Responses['CreateHostedZoneCommand'] = {
      HostedZone: { Id: '/hostedzone/Z999888', Name: 'example.com.' }
    };

    const builder = new Route53Builder('example.com');
    const result = await builder.deploy();

    assert.ok(result);
    assert.strictEqual(result.id, 'Z999888');

    const createCall = r53Calls.find(c => c.commandName === 'CreateHostedZoneCommand');
    assert.ok(createCall);
    assert.strictEqual(createCall.input.Name, 'example.com');
  });

  test('deploys records with automatic double quoting for TXT/SPF and custom TTLs', async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = {
      HostedZones: [{ Id: '/hostedzone/Z123', Name: 'example.com.' }]
    };
    mockR53Responses['ChangeResourceRecordSetsCommand'] = {};

    const builder = new Route53Builder('example.com');
    builder
      .record('www', 'CNAME', 'example.com', 120)
      .record('@', 'TXT', 'v=spf1 include:_spf.google.com ~all')
      .record('spf-record', 'SPF', '"v=spf1 -all"', 600); // already quoted

    await builder.deploy();

    const changeCall = r53Calls.find(c => c.commandName === 'ChangeResourceRecordSetsCommand');
    assert.ok(changeCall);
    assert.strictEqual(changeCall.input.HostedZoneId, 'Z123');

    const changes = changeCall.input.ChangeBatch.Changes;
    assert.strictEqual(changes.length, 3);

    // Assert CNAME configuration
    assert.deepStrictEqual(changes[0], {
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: 'www',
        Type: 'CNAME',
        TTL: 120,
        ResourceRecords: [{ Value: 'example.com' }]
      }
    });

    // Assert TXT quoting
    assert.deepStrictEqual(changes[1].ResourceRecordSet, {
      Name: '@',
      Type: 'TXT',
      TTL: 300, // default
      ResourceRecords: [{ Value: '"v=spf1 include:_spf.google.com ~all"' }] // wrapped in quotes
    });

    // Assert already quoted SPF remains same with custom TTL
    assert.deepStrictEqual(changes[2].ResourceRecordSet, {
      Name: 'spf-record',
      Type: 'SPF',
      TTL: 600,
      ResourceRecords: [{ Value: '"v=spf1 -all"' }] // no extra quotes
    });
  });

  test('adds DNS alias pointers to other builders correctly', async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = {
      HostedZones: [{ Id: '/hostedzone/Z123', Name: 'example.com.' }]
    };

    const mockTarget: any = {
      name: 'api-service'
    };

    const builder = new Route53Builder('example.com');
    builder.pointer('api', mockTarget);

    const result = await builder.deploy();
    assert.ok(result);

    // Pointers are logged correctly (in real mode pointers don't write via upsertRecords because ChangeResourceRecordSets requires an alias target config, which puls handles, or mocks out here)
    const recordsField = (builder as any).records;
    const pointerRecord = recordsField.find((r: any) => r.name === 'api');
    assert.ok(pointerRecord);
    assert.strictEqual(pointerRecord.type, 'A');
    assert.strictEqual(pointerRecord.isAlias, true);
    assert.strictEqual(pointerRecord.value, mockTarget);
  });

  test('registers domain, normalizes phone, and awaits status: successful', async () => {
    let listCallCount = 0;
    mockR53Responses['ListHostedZonesByNameCommand'] = () => {
      listCallCount++;
      if (listCallCount === 1) {
        return { HostedZones: [] };
      }
      return {
        HostedZones: [{ Id: '/hostedzone/Z123', Name: 'random-domain.com.' }]
      };
    };
    mockDomainsResponses['CheckDomainAvailabilityCommand'] = { Availability: 'AVAILABLE' };
    mockDomainsResponses['RegisterDomainCommand'] = { OperationId: 'op-registration-abc' };

    let pollCount = 0;
    mockDomainsResponses['GetOperationDetailCommand'] = () => {
      pollCount++;
      return {
        Status: pollCount === 1 ? 'PENDING' : 'SUCCESSFUL'
      };
    };

    const builder = new Route53Builder('random-domain.com');
    builder.register({
      FIRSTNAME: 'Jane', LASTNAME: 'Doe', EMAIL: 'jane@example.com',
      MOBILE: '+46708339809', CONTACT_TYPE: 'PERSON', ORGANIZATION: 'N/A',
      ADDRESSLINE: '123 Main St', CITY: 'Seattle', ZIPCODE: '98101', COUNTRY: 'US'
    });

    // Override the protected waitFor method to execute polling instantly
    (builder as any).waitFor = async (label: string, condition: () => Promise<boolean>) => {
      let done = false;
      while (!done) {
        done = await condition();
      }
    };

    await builder.deploy();

    // Verify Check Availability was executed
    const checkCall = domainsCalls.find(c => c.commandName === 'CheckDomainAvailabilityCommand');
    assert.ok(checkCall);
    assert.strictEqual(checkCall.input.DomainName, 'random-domain.com');

    // Verify Phone Normalization (+CC.subscriberSwedish example)
    const registerCall = domainsCalls.find(c => c.commandName === 'RegisterDomainCommand');
    assert.ok(registerCall);
    assert.strictEqual(registerCall.input.DomainName, 'random-domain.com');
    
    // Normalization should transform "+46708339809" into "+46.708339809"
    assert.strictEqual(registerCall.input.RegistrantContact.PhoneNumber, '+46.708339809');

    // Verify polling was performed
    const pollCall = domainsCalls.filter(c => c.commandName === 'GetOperationDetailCommand');
    assert.strictEqual(pollCall.length, 2);
    assert.strictEqual(pollCall[0].input.OperationId, 'op-registration-abc');
  });

  test("loads records from a configuration file (JSON) successfully", async () => {
    mockR53Responses['ListHostedZonesByNameCommand'] = {
      HostedZones: [{ Id: '/hostedzone/Z123', Name: 'example.com.' }]
    };
    mockR53Responses['ChangeResourceRecordSetsCommand'] = {};

    // Mock JSON file creation
    const tempJsonPath = path.resolve(process.cwd(), "temp-route53-records.json");
    const jsonContent = JSON.stringify([
      { name: "www", type: "CNAME", value: "lb.com", ttl: 120 },
      { name: "mail", type: "A", value: "1.1.1.1" }
    ]);
    fs.writeFileSync(tempJsonPath, jsonContent, "utf-8");

    try {
      const builder = new Route53Builder("example.com")
        .record("temp-route53-records.json")
        .record("api", "A", "2.2.2.2"); // Hybrid programmatic record!

      await builder.deploy();

      const changeCall = r53Calls.find(c => c.commandName === 'ChangeResourceRecordSetsCommand');
      assert.ok(changeCall);

      const changes = changeCall.input.ChangeBatch.Changes;
      assert.strictEqual(changes.length, 3);

      assert.deepStrictEqual(changes[0].ResourceRecordSet, {
        Name: "www",
        Type: "CNAME",
        TTL: 120,
        ResourceRecords: [{ Value: "lb.com" }]
      });

      assert.deepStrictEqual(changes[1].ResourceRecordSet, {
        Name: "mail",
        Type: "A",
        TTL: 300, // default
        ResourceRecords: [{ Value: "1.1.1.1" }]
      });

      assert.deepStrictEqual(changes[2].ResourceRecordSet, {
        Name: "api",
        Type: "A",
        TTL: 300,
        ResourceRecords: [{ Value: "2.2.2.2" }]
      });
    } finally {
      if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);
    }
  });
});
