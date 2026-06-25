import { test, describe } from "node:test";
import assert from "node:assert";
import { withRetry } from "@puls-dev/core";

describe("Retry & Backoff Engine Unit Tests", () => {
  test("resolves immediately if target function succeeds on the first try", async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls++;
      return "success";
    });
    assert.strictEqual(res, "success");
    assert.strictEqual(calls, 1);
  });

  test("retries up to max attempts and then throws the final error", async () => {
    let calls = 0;
    const delayTimes: number[] = [];
    
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        {
          maxAttempts: 3,
          jitter: false,
          delayFn: async (ms) => {
            delayTimes.push(ms);
          },
        }
      ),
      /fail-3/
    );

    assert.strictEqual(calls, 3);
    // Exponential backoff verification:
    // Delay 1: 1000ms * 2^0 = 1000ms
    // Delay 2: 1000ms * 2^1 = 2000ms
    assert.deepStrictEqual(delayTimes, [1000, 2000]);
  });

  test("immediately stops retrying and throws on non-retryable errors", async () => {
    let calls = 0;
    
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          if (calls === 1) throw new Error("transient");
          throw new Error("fatal");
        },
        {
          maxAttempts: 5,
          retryable: (err) => err.message === "transient",
          delayFn: async () => {},
        }
      ),
      /fatal/
    );

    assert.strictEqual(calls, 2);
  });

  test("includes randomized jitter when options.jitter is enabled", async () => {
    const delayTimes: number[] = [];
    
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("fail");
        },
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          backoffFactor: 2,
          jitter: true,
          delayFn: async (ms) => {
            delayTimes.push(ms);
          },
        }
      ),
      /fail/
    );

    assert.strictEqual(delayTimes.length, 2);
    // With 10% jitter, first delay (1000) should be between 900 and 1100
    assert.ok(delayTimes[0] >= 900 && delayTimes[0] <= 1100);

    // Second delay (2000) should be between 1800 and 2200
    assert.ok(delayTimes[1] >= 1800 && delayTimes[1] <= 2200);
  });
});
