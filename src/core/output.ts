export class Output<T> {
  private _promise: Promise<T>;
  private _resolve!: (value: T) => void;

  constructor() {
    this._promise = new Promise(resolve => (this._resolve = resolve));
  }

  resolve(value: T): void {
    this._resolve(value);
  }

  get(): Promise<T> {
    return this._promise;
  }

  // Transform this output into a new Output<U> without awaiting it yourself.
  apply<U>(fn: (val: T) => U): Output<U> {
    const out = new Output<U>();
    this._promise.then(v => out.resolve(fn(v)));
    return out;
  }
}
