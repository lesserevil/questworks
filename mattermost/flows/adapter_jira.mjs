/**
 * Flow: /qw adapter add jira
 * Steps: URL → token → project key → name → save+sync
 */
import { encryptJson, maskToken, isEncryptionAvailable } from '../crypto.mjs';
import { JiraAdapter } from '../../adapters/jira.mjs';

export async function start(ctx, conv) {
  if (!isEncryptionAvailable()) {
    return { reply: '⚠️ `QW_ENCRYPTION_KEY` is not set. Cannot safely store credentials.', done: true };
  }
  return { reply: "Adding a Jira adapter. What's your Jira URL? (e.g. `https://yourco.atlassian.net`)" };
}

export async function step(ctx, stepNum, message, data) {
  const { db, adapters, scheduler } = ctx;
  const text = message.trim();

  switch (stepNum) {
    case 1: {
      if (!text.startsWith('http')) {
        return { reply: "Please enter a valid URL (e.g. `https://yourco.atlassian.net`):", nextStep: 1, newData: data, done: false };
      }
      return { reply: 'Paste your Jira API token:', nextStep: 2, newData: { ...data, url: text.replace(/\/$/, '') }, done: false };
    }

    case 2: {
      if (!text) {
        return { reply: 'A token is required. Paste your Jira API token:', nextStep: 2, newData: data, done: false };
      }
      return {
        reply: "Got it, token received. What's the project key? (e.g. `QUEST`)",
        nextStep: 3,
        newData: { ...data, token: text, token_masked: maskToken(text) },
        done: false,
      };
    }

    case 3: {
      if (!text) {
        return { reply: 'A project key is required. What is it? (e.g. `QUEST`)', nextStep: 3, newData: data, done: false };
      }
      const project = text.toUpperCase();
      return {
        reply: `Optional: name for this adapter? (press Enter for default: \`jira-${project.toLowerCase()}\`)`,
        nextStep: 4,
        newData: { ...data, project },
        done: false,
      };
    }

    case 4: {
      const name = text || `jira-${data.project.toLowerCase()}`;
      const now = new Date().toISOString();

      await db.run(`
        INSERT OR REPLACE INTO adapters_config (id, type, name, config_json_encrypted, created_at, status)
        VALUES (?, 'jira', ?, ?, ?, 'ok')
      `, [name, name, encryptJson({
        url: data.url,
        token: data.token,
        token_masked: data.token_masked,
        project: data.project,
      }), now]);

      adapters.set(name, new JiraAdapter(name, {
        url: data.url,
        token: data.token,
        project: data.project,
      }));
      if (scheduler && !scheduler._timer && adapters.size > 0) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync for ${name} failed:`, err.message));

      return {
        reply: `✅ Jira adapter **${name}** added.\nURL: \`${data.url}\` | Project: \`${data.project}\` | Token: \`${data.token_masked}\`\nSyncing tasks in the background...`,
        nextStep: 0, newData: {}, done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Try `/qw adapter add jira` again.', nextStep: 0, newData: {}, done: true };
  }
}
