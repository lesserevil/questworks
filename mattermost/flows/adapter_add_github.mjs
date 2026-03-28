import { isEncryptionAvailable, maskToken, encryptJson } from '../crypto.mjs';
import { saveAdapterConfig } from '../../db/adapters.mjs';
import { GitHubAdapter } from '../../adapters/github.mjs';

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
          reply: '⚠️ `QW_ENCRYPTION_KEY` is not set. Cannot safely store credentials. Please set this environment variable and restart QuestWorks.',
          done: true,
        };
      }
      return {
        reply: "Adding a GitHub adapter. What's the repo? (format: `owner/repo`)",
        step: 1,
        data,
      };

    case 1: {
      const repo = message.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return {
          reply: 'Invalid format. Please use `owner/repo` (e.g. `acme/widget`):',
          step: 1,
          data,
        };
      }
      return {
        reply: 'Got it. Paste your GitHub personal access token:',
        step: 2,
        data: { ...data, repo },
      };
    }

    case 2: {
      const token = message.trim();
      if (!token) {
        return { reply: 'Token cannot be empty. Please paste your GitHub personal access token:', step: 2, data };
      }
      return {
        reply: 'Got it, token received. Optional: only sync issues with a specific label? (press Enter to skip)',
        step: 3,
        data: { ...data, token, token_masked: maskToken(token) },
      };
    }

    case 3: {
      const raw = message.trim();
      const label = (!raw || raw.toLowerCase() === 'skip') ? null : raw;
      const slug = data.repo.replace('/', '-');
      return {
        reply: `Optional: give this adapter a name? (default: \`github-${slug}\`)`,
        step: 4,
        data: { ...data, label_filter: label },
      };
    }

    case 4: {
      const slug = data.repo.replace('/', '-');
      const name = isSkip(message) ? `github-${slug}` : message.trim();

      // Store plaintext token in configObj — the outer encryptJson protects it at rest
      saveAdapterConfig(db, {
        id: name,
        type: 'github',
        name,
        configEncrypted: encryptJson({
          repo: data.repo,
          token: data.token,
          token_masked: data.token_masked,
          label_filter: data.label_filter || null,
        }),
      });

      adapters.set(name, new GitHubAdapter(name, {
        repo: data.repo,
        token: data.token,
        label_filter: data.label_filter || null,
      }));

      if (scheduler && !scheduler._timer) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync failed: ${err.message}`));

      return {
        reply: `✅ GitHub adapter **${name}** added!\nRepo: \`${data.repo}\` | Token: \`${data.token_masked}\`${data.label_filter ? ` | Label: \`${data.label_filter}\`` : ''}\nSyncing in the background...`,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Please start over with `/qw adapter add github`.', done: true };
  }
}
