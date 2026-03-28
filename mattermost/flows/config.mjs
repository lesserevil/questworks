/**
 * Flows: /qw config set channel  (data.subflow = 'channel')
 *        /qw config set sync-interval  (data.subflow = 'interval')
 */
import { getConfig, setConfig } from '../../db/config.mjs';

export async function start(ctx, conv) {
  const subflow = conv.data.subflow;
  if (subflow === 'channel') {
    return { reply: 'Which channel for task notifications? (e.g. `#paperwork`)' };
  }
  if (subflow === 'interval') {
    const current = getConfig(ctx.db, 'sync_interval_seconds', 60);
    return { reply: `Sync interval in seconds? (current: \`${current}\`)` };
  }
  return { reply: 'Unknown config subflow.', done: true };
}

export async function step(ctx, stepNum, message, data) {
  const { db, notifier, scheduler, adapters } = ctx;
  const text = message.trim();

  if (data.subflow === 'channel') {
    if (!text) {
      return { reply: 'Channel name cannot be empty. Enter the channel name:', nextStep: 1, newData: data, done: false };
    }
    const channel = text.replace(/^#/, '');
    setConfig(db, 'notification_channel', channel);
    if (notifier) {
      notifier.channel = channel;
      notifier._channelId = null;
    }
    return { reply: `✅ Notification channel set to **#${channel}**`, nextStep: 0, newData: {}, done: true };
  }

  if (data.subflow === 'interval') {
    const val = parseInt(text, 10);
    if (isNaN(val) || val < 10) {
      return { reply: 'Please enter a number ≥ 10 (seconds):', nextStep: 1, newData: data, done: false };
    }
    setConfig(db, 'sync_interval_seconds', val);
    if (scheduler) {
      scheduler.stop();
      scheduler.interval = val * 1000;
      if (adapters && adapters.size > 0) scheduler.start();
    }
    return { reply: `✅ Sync interval set to **${val}s**`, nextStep: 0, newData: {}, done: true };
  }

  return { reply: 'Something went wrong.', nextStep: 0, newData: {}, done: true };
}
