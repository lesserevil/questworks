import { encrypt, isEncryptionAvailable, maskToken, encryptJson, decrypt } from '../crypto.mjs';
import { saveAdapterConfig } from '../../db/adapters.mjs';
import { JiraAdapter } from '../../adapters/jira.mjs';

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
        reply: "Adding a Jira adapter. What's your Jira URL? (e.g. `https://yourco.atlassian.net`)",
        step: 1,
        data,
      };

    case 1: {
      const url = message.trim();
      if (!url.startsWith('http')) {
        return { reply: 'Please enter a valid URL (e.g. `https://yourco.atlassian.net`):', step: 1, data };
      }
      return {
        reply: 'Paste your Jira API token:',
        step: 2,
        data: { ...data, url },
      };
    }

    case 2: {
      const token = message.trim();
      if (!token) {
        return { reply: 'Token cannot be empty. Please paste your Jira API token:', step: 2, data };
      }
      return {
        reply: "Got it, token received. What's the project key? (e.g. `QUEST`)",
        step: 3,
        data: { ...data, token: encrypt(token), token_masked: maskToken(token) },
      };
    }

    case 3: {
      const project = message.trim().toUpperCase();
      if (!project) {
        return { reply: "Project key cannot be empty. What's the project key? (e.g. `QUEST`)", step: 3, data };
      }
      return {
        reply: `Optional: name for this adapter? (default: \`jira-${project.toLowerCase()}\`)`,
        step: 4,
        data: { ...data, project },
      };
    }

    case 4: {
      const name = isSkip(message) ? `jira-${data.project.toLowerCase()}` : message.trim();

      const configObj = {
        url: data.url,
        token: data.token,
        token_masked: data.token_masked,
        project: data.project,
      };

      saveAdapterConfig(db, {
        id: name,
        type: 'jira',
        name,
        configEncrypted: encryptJson(configObj),
      });

      adapters.set(name, new JiraAdapter(name, {
        url: data.url,
        token: decrypt(data.token),
        project: data.project,
      }));

      if (scheduler && !scheduler._timer) scheduler.start();
      scheduler.syncAdapter(name).catch(err => console.error(`[slash] initial sync failed: ${err.message}`));

      return {
        reply: `✅ Jira adapter **${name}** added successfully!\nURL: \`${data.url}\` | Project: \`${data.project}\` | Token: \`${data.token_masked}\`\nSyncing tasks in the background...`,
        done: true,
      };
    }

    default:
      return { reply: 'Something went wrong. Please start over with `/qw adapter add jira`.', done: true };
  }
}
