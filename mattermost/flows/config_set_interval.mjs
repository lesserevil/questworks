import { setConfig } from '../../db/config.mjs';

export async function handle(ctx) {
  const { db, scheduler, conversation, message } = ctx;
  const { step } = conversation;

  switch (step) {
    case 0:
      return {
        reply: 'Sync interval in seconds? (default: `60`)',
        step: 1,
        data: conversation.data,
      };

    case 1: {
      const input = message.trim();
      const seconds = parseInt(input, 10) || 60;
      if (seconds < 10) {
        return { reply: 'Interval must be at least 10 seconds. Please enter a value:', step: 1, data: conversation.data };
      }

      setConfig(db, 'sync_interval_seconds', seconds);

      // Update live scheduler
      if (scheduler) {
        scheduler.stop();
        scheduler.interval = seconds * 1000;
        if (scheduler.adapters.size > 0) scheduler.start();
      }

      return {
        reply: `✅ Sync interval set to **${seconds}s**`,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong.', done: true };
  }
}
