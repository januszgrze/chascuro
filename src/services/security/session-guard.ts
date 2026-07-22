export interface SessionToken {
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export class SessionGuard {
  private epoch = 0;
  private abortController = new AbortController();

  current(): SessionToken {
    return {
      epoch: this.epoch,
      signal: this.abortController.signal,
    };
  }

  renew(): SessionToken {
    this.abortController.abort();
    this.epoch += 1;
    this.abortController = new AbortController();
    return this.current();
  }

  invalidate(): void {
    this.abortController.abort();
    this.epoch += 1;
    this.abortController = new AbortController();
  }

  isCurrent(token: SessionToken): boolean {
    return (
      token.epoch === this.epoch &&
      token.signal === this.abortController.signal &&
      !token.signal.aborted
    );
  }
}
