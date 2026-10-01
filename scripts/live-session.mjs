import { runLiveSession } from '../dist/cli/live-session.js';
try {
  await runLiveSession();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
