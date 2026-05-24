import {
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { getCWClient } from "./api.js";
import { FargateBuilder } from "./fargate.js";
import { RDSBuilder } from "./rds.js";
import { SNSTopicBuilder } from "./sns.js";

type ComparisonOperator =
  | "GreaterThanOrEqualToThreshold"
  | "GreaterThanThreshold"
  | "LessThanThreshold"
  | "LessThanOrEqualToThreshold";

type Statistic = "Average" | "Sum" | "SampleCount" | "Maximum" | "Minimum";

export class CloudWatchAlarmBuilder extends BaseBuilder {
  readonly out = {
    name: new Output<string>(),
    arn: new Output<string>(),
  };

  private _namespace?: string;
  private _metricName?: string;
  private _dimensions?: Record<string, string>;
  private _comparison?: ComparisonOperator;
  private _threshold?: number;
  private _period?: number;
  private _evaluationPeriods?: number;
  private _statistic?: Statistic;
  private _actions: Array<string | SNSTopicBuilder> = [];
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.out.name.resolve(name);
    this.discoveryPromise = this.discoverAlarm(name);
  }

  metric(namespace: string, name: string, dimensions?: Record<string, string>) {
    this._namespace = namespace;
    this._metricName = name;
    if (dimensions) {
      this._dimensions = dimensions;
    }
    return this;
  }

  comparison(op: ComparisonOperator) {
    this._comparison = op;
    return this;
  }

  threshold(value: number) {
    this._threshold = value;
    return this;
  }

  period(seconds: number) {
    this._period = seconds;
    return this;
  }

  evaluationPeriods(periods: number) {
    this._evaluationPeriods = periods;
    return this;
  }

  statistic(stat: Statistic) {
    this._statistic = stat;
    return this;
  }

  actions(sns: string | SNSTopicBuilder) {
    this._actions.push(sns);
    return this;
  }

  fargateCPU(fargate: FargateBuilder, thresholdPercent: number) {
    this._namespace = "AWS/ECS";
    this._metricName = "CPUUtilization";
    this._dimensions = {
      ClusterName: fargate.clusterName,
      ServiceName: fargate.serviceName,
    };
    this._comparison = "GreaterThanOrEqualToThreshold";
    this._threshold = thresholdPercent;
    this._period = this._period ?? 300;
    this._evaluationPeriods = this._evaluationPeriods ?? 1;
    this._statistic = this._statistic ?? "Average";
    return this;
  }

  fargateMemory(fargate: FargateBuilder, thresholdPercent: number) {
    this._namespace = "AWS/ECS";
    this._metricName = "MemoryUtilization";
    this._dimensions = {
      ClusterName: fargate.clusterName,
      ServiceName: fargate.serviceName,
    };
    this._comparison = "GreaterThanOrEqualToThreshold";
    this._threshold = thresholdPercent;
    this._period = this._period ?? 300;
    this._evaluationPeriods = this._evaluationPeriods ?? 1;
    this._statistic = this._statistic ?? "Average";
    return this;
  }

  rdsCPU(rds: RDSBuilder, thresholdPercent: number) {
    this._namespace = "AWS/RDS";
    this._metricName = "CPUUtilization";
    this._dimensions = {
      DBInstanceIdentifier: rds.dbInstanceIdentifier,
    };
    this._comparison = "GreaterThanOrEqualToThreshold";
    this._threshold = thresholdPercent;
    this._period = this._period ?? 300;
    this._evaluationPeriods = this._evaluationPeriods ?? 1;
    this._statistic = this._statistic ?? "Average";
    return this;
  }

  rdsStorage(rds: RDSBuilder, thresholdBytes: number) {
    this._namespace = "AWS/RDS";
    this._metricName = "FreeStorageSpace";
    this._dimensions = {
      DBInstanceIdentifier: rds.dbInstanceIdentifier,
    };
    this._comparison = "LessThanThreshold";
    this._threshold = thresholdBytes;
    this._period = this._period ?? 300;
    this._evaluationPeriods = this._evaluationPeriods ?? 1;
    this._statistic = this._statistic ?? "Average";
    return this;
  }

  private async discoverAlarm(name: string): Promise<any> {
    const cw = getCWClient();
    try {
      const result = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [name] }));
      const match = (result.MetricAlarms ?? []).find((a) => a.AlarmName === name);
      if (match) {
        this.resolvedArn = match.AlarmArn ?? null;
        if (this.resolvedArn) {
          this.out.arn.resolve(this.resolvedArn);
        }
        return match;
      }
      return null;
    } catch (e: any) {
      if (e.name === "CredentialsProviderError") return null;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const cw = getCWClient();

    console.log(`\n⏰ Finalizing CloudWatch Alarm "${this.name}"...`);

    if (!this._namespace || !this._metricName || !this._comparison || this._threshold === undefined) {
      throw new Error(
        `[CloudWatchAlarm:${this.name}] Metric namespace, name, comparison operator, and threshold are required.`
      );
    }

    // Resolve SNS action ARNs
    const alarmActions: string[] = [];
    for (const action of this._actions) {
      if (typeof action === "string") {
        alarmActions.push(action);
      } else {
        const arn = await action.out.arn.get();
        alarmActions.push(arn);
      }
    }

    const dimensionsArray = this._dimensions
      ? Object.entries(this._dimensions).map(([Name, Value]) => ({ Name, Value }))
      : undefined;

    const alarmParams = {
      AlarmName: this.name,
      ComparisonOperator: this._comparison,
      EvaluationPeriods: this._evaluationPeriods ?? 1,
      MetricName: this._metricName,
      Namespace: this._namespace,
      Period: this._period ?? 300,
      Threshold: this._threshold,
      Statistic: this._statistic ?? "Average",
      ActionsEnabled: alarmActions.length > 0,
      AlarmActions: alarmActions.length > 0 ? alarmActions : undefined,
      Dimensions: dimensionsArray,
    };

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? "Update" : "Create"} CloudWatch alarm "${this.name}"`);
      console.log(`      └─ Metric: ${this._namespace}/${this._metricName}`);
      console.log(`      └─ Comparison: ${this._comparison} | Threshold: ${this._threshold}`);
      if (this._dimensions) {
        console.log(`      └─ Dimensions: ${JSON.stringify(this._dimensions)}`);
      }
      if (alarmActions.length > 0) {
        console.log(`      └─ Actions: ${alarmActions.join(", ")}`);
      }
      this.resolvedArn = existing?.AlarmArn ?? `arn:aws:cloudwatch:us-east-1:000000000000:alarm:DRYRUN-${this.name}`;
      this.out.arn.resolve(this.resolvedArn!);
      return { name: this.name, arn: this.resolvedArn };
    }

    await cw.send(new PutMetricAlarmCommand(alarmParams));

    const describeResult = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [this.name] }));
    this.resolvedArn = describeResult.MetricAlarms?.[0]?.AlarmArn ?? `arn:aws:cloudwatch:us-east-1:000000000000:alarm:${this.name}`;
    this.out.arn.resolve(this.resolvedArn);

    console.log(`🚀 Created/Updated CloudWatch Alarm "${this.name}" (arn=${this.resolvedArn})`);
    await this.deploySidecars();
    return { name: this.name, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying CloudWatch Alarm "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ Alarm "${this.name}" does not exist - nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete CloudWatch alarm "${this.name}"`);
      return { destroyed: this.name };
    }

    const cw = getCWClient();
    await cw.send(new DeleteAlarmsCommand({ AlarmNames: [this.name] }));
    console.log(`   ✅ Deleted CloudWatch alarm "${this.name}"`);
    return { destroyed: this.name };
  }
}
