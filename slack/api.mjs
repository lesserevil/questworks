/**
 * Shared Slack API helpers and command parser used by both the HTTP slash
 * router (slash.mjs) and the Socket Mode client (socket.mjs).
 */

export const SLACK_API = 'https://slack.com/api';

export async function slackPost(token, endpoint, body) {
  if (!token) return null;
  try {
    const res = await fetch(`${SLACK_API}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[slack] ${endpoint} → ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.ok) console.error(`[slack] ${endpoint} error:`, data.error);
    return data;
  } catch (err) {
    console.error(`[slack] ${endpoint} error:`, err.message);
    return null;
  }
}

export async function postToSlack(token, channelId, text) {
  return slackPost(token, '/chat.postMessage', { channel: channelId, text });
}

export async function openSlackModal(token, triggerId, metadata, modalDef) {
  return slackPost(token, '/views.open', {
    trigger_id: triggerId,
    view: { ...modalDef, private_metadata: JSON.stringify(metadata) },
  });
}

// ── Command parser ────────────────────────────────────────────────────────────

export const COMMAND_MAP = [
  ['adapter add github',       'adapter_add_github'],
  ['adapter add beads',        'adapter_add_beads'],
  ['adapter add jira',         'adapter_add_jira'],
  ['adapter list',             'adapter_list'],
  ['adapter remove',           'adapter_remove'],
  ['adapter sync',             'adapter_sync'],
  ['task list',                'task_list'],
  ['task claim',               'task_claim'],
  ['task done',                'task_done'],
  ['task block',               'task_block'],
  ['task add',                 'task_add'],
  ['config set channel',       'config_set_channel'],
  ['config set sync-interval', 'config_set_sync_interval'],
  ['config show',              'config_show'],
  ['help',                     'help'],
];

export function parseCommand(text) {
  const lower = (text || '').trim().toLowerCase();
  for (const [cmd, flowName] of COMMAND_MAP) {
    if (lower === cmd || lower.startsWith(cmd + ' ')) {
      return { flowName, args: lower.slice(cmd.length).trim() };
    }
  }
  return null;
}
