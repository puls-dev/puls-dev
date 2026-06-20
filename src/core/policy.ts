import { BaseBuilder } from "./resource.js";

export interface PolicyRule {
  name: string;
  validate: (resource: BaseBuilder) => void | string | boolean;
}

export class Policy {
  private static rules: PolicyRule[] = [];

  /**
   * Register a compliance rule to run against resources.
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
}
