import { deleteAdapterConfig, loadAdapterConfigs } from '../../db/adapters.mjs';

export async function handle(ctx) {
  const { db, adapters, conversation, message } = ctx;
  const { step, data } = conversation;

  switch (step) {
    case 0: {
      const rows = loadAdapterConfigs(db);
      if (rows.length === 0) {
        return { reply: 'No adapters configured.', done: true };
      }
      const list = rows.map(r => `- \`${r.id}\` (${r.type})`).join('\n');
      return {
        reply: `**Configured adapters:**\n${list}\n\nWhich adapter do you want to remove? (enter the id)`,
        step: 1,
        data,
      };
    }

    case 1: {
      const id = message.trim();
      const row = loadAdapterConfigs(db).find(r => r.id === id);
      if (!row) {
        return {
          reply: `Adapter \`${id}\` not found. Please enter a valid adapter id (or type \`cancel\` to abort):`,
          step: 1,
          data,
        };
      }
      return {
        reply: `Are you sure you want to remove adapter **${id}** (${row.type})? This will delete its config but not tasks already synced. (yes/no)`,
        step: 2,
        data: { ...data, targetId: id },
      };
    }

    case 2: {
      const answer = message.trim().toLowerCase();
      if (answer === 'cancel' || answer === 'no' || answer === 'n') {
        return { reply: 'Cancelled.', done: true };
      }
      if (answer !== 'yes' && answer !== 'y') {
        return { reply: 'Please answer **yes** or **no**:', step: 2, data };
      }

      const id = data.targetId;
      deleteAdapterConfig(db, id);
      adapters.delete(id);
      return { reply: `✅ Adapter **${id}** removed.`, done: true };
    }

    default:
      return { reply: 'Something went wrong. Please try `/qw adapter remove` again.', done: true };
  }
}
