export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  retryable?: (error: any) => boolean;
  delayFn?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;
  const useJitter = options.jitter ?? true;
  const retryable = options.retryable ?? (() => true);
  const delayFn = options.delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      if (attempt >= maxAttempts || !retryable(error)) {
        throw error;
      }

      let delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      if (useJitter) {
        // Add random jitter offset of +/- 10%
        const jitterAmount = (Math.random() * 0.2 - 0.1) * delay;
        delay += jitterAmount;
      }

      console.warn(
        `   ⚠️  Transient error encountered: ${error.message || error}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxAttempts})...`
      );

      await delayFn(delay);
    }
  }
}
