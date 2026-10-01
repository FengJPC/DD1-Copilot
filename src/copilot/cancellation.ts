/** Interruptible polling without leaving timeout handles behind on shutdown. */
export class PollingLifetime {
  private readonly controller = new AbortController();

  get closed() { return this.controller.signal.aborted; }

  ensureOpen() {
    if (this.closed) throw new Error('The DD1 session is closed.');
  }

  close() { this.controller.abort(); }

  wait(milliseconds: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.controller.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
