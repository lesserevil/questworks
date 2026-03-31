/**
 * Flow: /qw adapter add beads
 * Steps: endpoint → token → board ID → name → save+sync
 */
import { encryptJson, maskToken, isEncryptionAvailable } from '../crypto.mjs';
import { BeadsAdapter } from '../../adapters/beads.mjs';

export async function start(ctx, conv) {
  if (!isEncryptionAvailable()) {
    return { reply: '⚠️ `QW_ENCRYPTION_KEY` is not set. Cannot safely store credentials.', done: true };
  }
  return { reply: "Adding a Beads adapter. What's the Beads endpoint URL?" };
}

export async function step(ctx, stepNum, message, data) {
  const { db, adapters, scheduler } = ctx;
  const text = message.trim();

  switch (stepNum) {
    case 1: {
      if (!text.startsWith('http')) {
        return { reply: "Please enter a valid URL (e.g. `https://beads.example.com`):", nextStep: 1, newData: data, done: false };
      }
      return { reply: 'Paste your Beads API token:', nextStep: 2, newData: { ...data, endpoint: text.replace(/\/$/, '') }, done: false };
    }

    case 2: {
      if (!text) {
        return { reply: 'A token is required. Paste your Beads API token:', nextStep: 2, newData: data, done: false };
      }
      return {
        reply: "Got it, token received. What's the board ID?",
        nextStep: 3,
        newData: { ...data, token: text, token_masked: maskToken(text) },
        done: false,
      };
    }

    case 3: {
      if (!text) {
        return { reply: 'A board ID is required. What is it?', nextStep: 3, newData: data, done: false };
      }
      return {
        reply: `Optional: name for this adapter? (press Enter for default: \`beads-${text}\`)`,
        nextStep: 4,
        newData: { ...data, board_id: text },
        done: false,
      };
    }

    case 4: {
      const name = text || `beads-${data.board_id}`;
      const now = new Date().toISOString();

      await db.run(`
        INSERT OR REPLACE INTO adapters_config (id, type, name, config_encrypted, created_at, status)
        VALUES (?, 'beads', ?, ?, ?, 'ok')
      `, [name, name, encryptJson({
        endpoint: data.endpoint,
        token: data.token,
        token_masked: data.token_masked,
        board_id: data.board_id,
      }), now]);

      adapters.set(name, new BeadsAdapter(name, {
        endpoint: data.endpoint,
        token: data.token,
        board_id: data.board_id,
      }));
      if (scheduler && !scheduler._timer && adapters.size > 0) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync for ${name} failed:`, err.message));

      return {
        reply: `✅ Beads adapter **${name}** added.\nEndpoint: \`${data.endpoint}\` | Board: \`${data.board_id}\` | Token: \`${data.token_masked}\`\nSyncing tasks in the background...`,
        nextStep: 0, newData: {}, done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Try `/qw adapter add beads` again.', nextStep: 0, newData: {}, done: true };
  }
}
