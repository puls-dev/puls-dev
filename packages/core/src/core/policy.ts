import { BaseBuilder } from "./resource.js";
import type { FieldDiff } from "../types/diff.js";

export interface PolicyRule {
  name: string;
  validate?: (resource: BaseBuilder) => void | string | boolean;
  mode?: "warn" | "fail";
  onDrift?: (resource: BaseBuilder, expected: FieldDiff[], actual: any) => void;
}

export class Policy {
  private static rules: PolicyRule[] = [];

  /**
   * Register a compliance or drift policy rule.
   */
  static register(rule: PolicyRule) {
    this.rules.push(rule);
  }

  /**
   * Clear all registered compliance rules (useful for test isolation).
   */
  static clear() {
    this.rules = [];
  }

  /**
   * Run all registered compliance rules against the list of resources.
   * Throws an error if any policy is violated.
   */
  static validate(resources: BaseBuilder[]): void {
    const violations: string[] = [];

    for (const resource of resources) {
      for (const rule of this.rules) {
        if (!rule.validate) continue;
        try {
          const result = rule.validate(resource);
          if (result === false) {
            violations.push(`Policy "${rule.name}" violated on resource "${resource.name}"`);
          } else if (typeof result === "string") {
            violations.push(result);
          }
        } catch (err: any) {
          violations.push(`Policy "${rule.name}" failed on resource "${resource.name}": ${err.message}`);
        }
      }
    }

    if (violations.length > 0) {
      console.error(`\n🛑 [POLICY VIOLATION] Compliance check failed with ${violations.length} error(s):`);
      for (const v of violations) {
        console.error(`   - ${v}`);
      }
      throw new Error(`Policy compliance checks failed. Deployment aborted.`);
    }
  }

  /**
   * Run drift policies against a drifted resource.
   */
  static triggerDrift(resource: BaseBuilder, changes: FieldDiff[], liveState: any): void {
    const failures: string[] = [];
    for (const rule of this.rules) {
      if (rule.onDrift) {
        try {
          rule.onDrift(resource, changes, liveState);
          if (rule.mode === "fail") {
            failures.push(`Drift policy "${rule.name}" failed on resource "${resource.name}"`);
          }
        } catch (err: any) {
          console.error(`   ⚠️  Drift policy "${rule.name}" failed: ${err.message}`);
          if (rule.mode === "fail") {
            failures.push(`Drift policy "${rule.name}" failed on resource "${resource.name}": ${err.message}`);
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`Policy compliance checks failed. Drift policies failed:\n${failures.join("\n")}`);
    }
  }
}
