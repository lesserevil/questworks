import { loadAdapterConfigs } from '../../db/adapters.mjs';

export async function handle(ctx) {
  const { db, adapters, scheduler, conversation, message } = ctx;
  const { step, data } = conversation;

  switch (step) {
    case 0: {
      const rows = await loadAdapterConfigs(db);
      if (rows.length === 0) {
        return { reply: 'No adapters configured. Use `/qw adapter add github` to add one.', done: true };
      }
      const list = rows.map(r => `- \`${r.id}\` (${r.type})`).join('\n');
      return {
        reply: `**Configured adapters:**\n${list}\n\nWhich adapter do you want to sync? (enter the id)`,
        step: 1,
        data,
      };
    }

    case 1: {
      const id = message.trim();
      if (!adapters.has(id)) {
        return {
          reply: `Adapter \`${id}\` not found. Please enter a valid adapter id:`,
          step: 1,
          data,
        };
      }
      try {
        const count = await scheduler.syncAdapter(id);
        return { reply: `✅ Synced adapter **${id}** — ${count} task(s) updated.`, done: true };
      } catch (err) {
        return { reply: `❌ Sync failed: ${err.message}`, done: true };
      }
    }

    default:
      return { reply: 'Something went wrong. Please try `/qw adapter sync` again.', done: true };
  }
}
