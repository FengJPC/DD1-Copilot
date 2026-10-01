/** Dispose resources on EOF, signals and broken output; remove our listeners afterward. */
export function registerProcessShutdown(shutdown: () => void): () => void {
  const onError = () => shutdown();
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.stdin.once('error', onError);
  process.stdout.once('error', onError);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return () => {
    process.stdin.off('end', shutdown);
    process.stdin.off('close', shutdown);
    process.stdin.off('error', onError);
    process.stdout.off('error', onError);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
}
