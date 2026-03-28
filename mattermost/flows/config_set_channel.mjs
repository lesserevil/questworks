import { setConfig } from '../../db/config.mjs';

export async function handle(ctx) {
  const { db, notifier, conversation, message } = ctx;
  const { step } = conversation;

  switch (step) {
    case 0:
      return {
        reply: 'Which channel for task notifications? (e.g. `#paperwork`)',
        step: 1,
        data: conversation.data,
      };

    case 1: {
      const channel = message.trim().replace(/^#/, '');
      if (!channel) {
        return { reply: 'Channel name cannot be empty. Please enter a channel name:', step: 1, data: conversation.data };
      }

      setConfig(db, 'notification_channel', channel);

      // Update live notifier
      if (notifier) {
        notifier.channel = channel;
        notifier._channelId = null; // invalidate cache
      }

      return {
        reply: `✅ Notification channel set to **#${channel}**`,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong.', done: true };
  }
}
