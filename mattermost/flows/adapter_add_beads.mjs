import { encrypt, isEncryptionAvailable, maskToken, encryptJson, decrypt } from '../crypto.mjs';
import { saveAdapterConfig } from '../../db/adapters.mjs';
import { BeadsAdapter } from '../../adapters/beads.mjs';

function isSkip(msg) {
  const t = (msg || '').trim().toLowerCase();
  return t === '' || t === 'skip' || t === 'none' || t === '-';
}

export async function handle(ctx) {
  const { db, adapters, scheduler, conversation, message } = ctx;
  const { step, data } = conversation;

  switch (step) {
    case 0:
      if (!isEncryptionAvailable()) {
        return {
          reply: '⚠️ `QW_ENCRYPTION_KEY` is not set. Cannot safely store credentials.',
          done: true,
        };
      }
      return {
        reply: "Adding a Beads adapter. What's the Beads endpoint URL?",
        step: 1,
        data,
      };

    case 1: {
      const endpoint = message.trim();
      if (!endpoint.startsWith('http')) {
        return { reply: 'Please enter a valid URL (starting with http:// or https://):',  step: 1, data };
      }
      return {
        reply: 'Paste your Beads API token:',
        step: 2,
        data: { ...data, endpoint },
      };
    }

    case 2: {
      const token = message.trim();
      if (!token) {
        return { reply: 'Token cannot be empty. Please paste your Beads API token:', step: 2, data };
      }
      return {
        reply: "Got it, token received. What's the board ID?",
        step: 3,
        data: { ...data, token: encrypt(token), token_masked: maskToken(token) },
      };
    }

    case 3: {
      const boardId = message.trim();
      if (!boardId) {
        return { reply: "Board ID cannot be empty. What's the board ID?", step: 3, data };
      }
      return {
        reply: `Optional: name for this adapter? (default: \`beads-${boardId}\`)`,
        step: 4,
        data: { ...data, board_id: boardId },
      };
    }

    case 4: {
      const name = isSkip(message) ? `beads-${data.board_id}` : message.trim();

      const configObj = {
        endpoint: data.endpoint,
        token: data.token,
        token_masked: data.token_masked,
        board_id: data.board_id,
      };

      saveAdapterConfig(db, {
        id: name,
        type: 'beads',
        name,
        configEncrypted: encryptJson(configObj),
      });

      adapters.set(name, new BeadsAdapter(name, {
        endpoint: data.endpoint,
        token: decrypt(data.token),
        board_id: data.board_id,
      }));

      if (scheduler && !scheduler._timer) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync failed: ${err.message}`));

      return {
        reply: `✅ Beads adapter **${name}** added successfully!\nEndpoint: \`${data.endpoint}\` | Board: \`${data.board_id}\` | Token: \`${data.token_masked}\`\nSyncing tasks in the background...`,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Please start over with `/qw adapter add beads`.', done: true };
  }
}
