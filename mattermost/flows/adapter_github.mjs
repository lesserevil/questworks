/**
 * Flow: /qw adapter add github
 * Steps: repo → token → label filter → name → save+sync
 */
import { encrypt, encryptJson, maskToken, isEncryptionAvailable } from '../crypto.mjs';
import { GitHubAdapter } from '../../adapters/github.mjs';

export async function start(ctx, conv) {
  if (!isEncryptionAvailable()) {
    return { reply: '⚠️ `QW_ENCRYPTION_KEY` is not set. Cannot safely store credentials. Set this env var and restart QuestWorks.', done: true };
  }
  return { reply: "Adding a GitHub adapter. What's the repo? (format: `owner/repo`)" };
}

export async function step(ctx, stepNum, message, data) {
  const { db, adapters, scheduler } = ctx;
  const text = message.trim();

  switch (stepNum) {
    case 1: {
      if (!text.match(/^[\w.-]+\/[\w.-]+$/)) {
        return { reply: "That doesn't look right — please use `owner/repo` (e.g. `acme/api`).", nextStep: 1, newData: data, done: false };
      }
      return { reply: 'Paste your GitHub personal access token:', nextStep: 2, newData: { ...data, repo: text }, done: false };
    }

    case 2: {
      if (!text) {
        return { reply: 'A token is required. Paste your GitHub personal access token:', nextStep: 2, newData: data, done: false };
      }
      return {
        reply: 'Got it, token received. Optional: only sync issues with this label? (press Enter to skip)',
        nextStep: 3,
        newData: { ...data, token: text, token_masked: maskToken(text) },
        done: false,
      };
    }

    case 3: {
      const label = (!text || text.toLowerCase() === 'skip') ? null : text;
      const slug = data.repo.replace('/', '-');
      return {
        reply: `Optional: name for this adapter? (press Enter for default: \`github-${slug}\`)`,
        nextStep: 4,
        newData: { ...data, label_filter: label },
        done: false,
      };
    }

    case 4: {
      const slug = data.repo.replace('/', '-');
      const name = text || `github-${slug}`;

      const now = new Date().toISOString();
      const configEncrypted = encryptJson({
        repo: data.repo,
        token: data.token,
        token_masked: data.token_masked,
        label_filter: data.label_filter,
      });

      await db.run(`
        INSERT OR REPLACE INTO adapters_config (id, type, name, config_json_encrypted, created_at, status)
        VALUES (?, 'github', ?, ?, ?, 'ok')
      `, [name, name, configEncrypted, now]);

      adapters.set(name, new GitHubAdapter(name, {
        repo: data.repo,
        token: data.token,
        label_filter: data.label_filter,
      }));
      if (scheduler && !scheduler._timer && adapters.size > 0) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync for ${name} failed:`, err.message));

      return {
        reply: `✅ GitHub adapter **${name}** added.\nRepo: \`${data.repo}\` | Token: \`${data.token_masked}\`${data.label_filter ? ` | Label: \`${data.label_filter}\`` : ''}\nSyncing tasks in the background...`,
        nextStep: 0, newData: {}, done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Try `/qw adapter add github` again.', nextStep: 0, newData: {}, done: true };
  }
}
