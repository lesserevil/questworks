import { encrypt, isEncryptionAvailable, maskToken } from '../crypto.mjs';
import { saveAdapterConfig } from '../../db/adapters.mjs';
import { GitHubAdapter } from '../../adapters/github.mjs';
import { encryptJson } from '../crypto.mjs';

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
        reply: 'What label marks issues for this team? (required — only labeled issues will sync)',
        step: 3,
        data: { ...data, token: encrypt(token), token_masked: maskToken(token) },
      };
    }

    case 3: {
      const label = message.trim();
      if (!label) {
        return {
          reply: 'A label is required — without one, no issues will sync. What label should we use?',
          step: 3,
          data,
        };
      }
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

      const configObj = {
        repo: data.repo,
        token: data.token,       // encrypted
        token_masked: data.token_masked,
        label_filter: data.label_filter || null,
      };

      saveAdapterConfig(db, {
        id: name,
        type: 'github',
        name,
        configEncrypted: encryptJson(configObj),
      });

      // Instantiate and register
      const { decrypt } = await import('../crypto.mjs');
      const liveConfig = {
        repo: data.repo,
        token: decrypt(data.token),
        label_filter: data.label_filter || null,
      };
      adapters.set(name, new GitHubAdapter(name, liveConfig));

      if (scheduler && !scheduler._timer) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync failed: ${err.message}`));

      return {
        reply: `✅ GitHub adapter added — syncing \`${data.repo}\`, label: \`${data.label_filter}\``,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Please start over with `/qw adapter add github`.', done: true };
  }
}
