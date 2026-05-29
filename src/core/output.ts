export class Output<T> {
  private _promise: Promise<T>;
  private _resolve!: (value: T) => void;
  private _reject!: (reason: any) => void;

  constructor() {
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(value: T): void {
    this._resolve(value);
  }

  reject(reason: any): void {
    this._reject(reason);
  }

  get(): Promise<T> {
    return this._promise;
  }

  // Transform this output into a new Output<U> without awaiting it yourself.
  apply<U>(fn: (val: T) => U): Output<U> {
    const out = new Output<U>();
    this._promise.then(
      v => out.resolve(fn(v)),
      err => out.reject(err)
    );
    return out;
  }
}
