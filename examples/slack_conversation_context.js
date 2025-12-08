'use webmcp-tool v1';

export const metadata = {
  name: "conversation_context",
  namespace: "slack",
  version: "0.4.0",
  description: "Fetch Slack conversation from the current channel, DM, thread. When available always use this tool over other page context tools to obtain the most complete context.",
  match: "https://app.slack.com/*",
  inputSchema: {
    type: "object",
    properties: {
      maxMessages: { type: "number", description: "Maximum number of messages to fetch.", default: 100 },
      unreadOnly: { type: "boolean", description: "Fetch only unread messages.", default: false },
    },
    required: [],
    additionalProperties: false
  }
};

/**
 * Get current Slack context - channel and optionally thread.
 * Falls back through multiple detection methods since Slack doesn't
 * reliably update the URL when opening threads.
 */
function getSlackContext() {
  const path = window.location.pathname.split('/');
  let channelId = path[3] || null;
  let threadTs = null;

  // Method 1: Check URL for thread segment (most reliable when present)
  const threadIndex = path.indexOf('thread');
  if (threadIndex !== -1 && path[threadIndex + 2]) {
    threadTs = path[threadIndex + 2];
  }

  // Method 2: If no thread in URL, check if thread flexpane is open
  if (!threadTs) {
    // Try broadcast checkbox first (has both channel and thread_ts in ID)
    const checkbox = document.querySelector('[data-qa="threads_footer_broadcast_checkbox"]');
    if (checkbox?.id) {
      const match = checkbox.id.match(/--([A-Z0-9]+)-(\d+\.\d+)--/);
      if (match) {
        channelId = match[1];
        threadTs = match[2];
      }
    }

    // Fallback: first data-ts in flexpane is the thread parent
    if (!threadTs) {
      const flexpane = document.querySelector('[data-qa="threads_flexpane"]');
      const firstTs = flexpane?.querySelector('[data-ts]');
      if (firstTs) {
        threadTs = firstTs.getAttribute('data-ts');
      }
    }
  }

  return { channelId, threadTs };
}

export async function execute(args) {
  const { maxMessages = 100, unreadOnly = false } = args;

  async function fetchApi(endpoint, bodyParams) {
    const token = JSON.parse(localStorage.localConfig_v2).teams[window.location.pathname.split('/')[2]].token;
    if (!token) throw new Error("Slack token not found.");

    const formData = new FormData();
    formData.append('token', token);
    for (const key in bodyParams) {
      formData.append(key, bodyParams[key]);
    }

    const res = await fetch(`https://${window.location.host}/api/${endpoint}`, {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });

    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (${endpoint}): ${data.error}`);
    return data;
  }

  const { channelId, threadTs } = getSlackContext();
  if (!channelId) throw new Error("Could not determine Slack channel ID.");

  // Always fetch channel history first (it has user_profile embedded)
  let oldest = null;
  if (unreadOnly) {
    const infoData = await fetchApi('conversations.info', { channel: channelId });
    if (infoData.channel?.last_read) {
      oldest = infoData.channel.last_read;
    }
  }

  let mainMessages = [];
  let cursor = null;
  while (mainMessages.length < maxMessages) {
    const params = { channel: channelId, limit: Math.min(maxMessages - mainMessages.length, 100) };
    if (cursor) params.cursor = cursor;
    if (oldest) params.oldest = oldest;

    const data = await fetchApi('conversations.history', params);
    mainMessages.push(...(data.messages || []));

    if (!data.has_more || !data.response_metadata?.next_cursor) break;
    cursor = data.response_metadata.next_cursor;
  }

  // Fetch thread replies for messages that have them
  const repliesMap = new Map();
  const threadStarters = mainMessages.filter(msg => msg.reply_count > 0);

  const threadPromises = threadStarters.map(msg =>
    fetchApi('conversations.replies', { channel: channelId, ts: msg.ts })
      .catch(e => {
        console.error(`Failed to fetch replies for thread ${msg.ts}`, e);
        return null;
      })
  );

  const results = await Promise.all(threadPromises);

  for (const data of results) {
    if (data && data.ok && data.messages && data.messages.length > 0) {
      const parentTs = data.messages[0].ts;
      const replies = data.messages.slice(1);
      repliesMap.set(parentTs, replies);
    }
  }

  // Build user map from all messages (mainMessages have user_profile, replies don't)
  const allMessages = [...mainMessages];
  repliesMap.forEach(replies => allMessages.push(...replies));
  const userMap = buildUserMap(allMessages);

  // Fetch profiles for users in replies who aren't in the userMap
  // (conversations.replies doesn't include user_profile)
  const missingUserIds = [];
  repliesMap.forEach(replies => {
    for (const reply of replies) {
      if (reply.user && !userMap.has(reply.user)) {
        missingUserIds.push(reply.user);
      }
    }
  });

  if (missingUserIds.length > 0) {
    const uniqueMissing = [...new Set(missingUserIds)];
    const userPromises = uniqueMissing.map(userId =>
      fetchApi('users.info', { user: userId })
        .then(data => {
          if (data.user) {
            userMap.set(userId, data.user.real_name || data.user.profile?.display_name || userId);
          }
        })
        .catch(() => { /* silently fail, will use ID */ })
    );
    await Promise.all(userPromises);
  }

  // Format messages chronologically
  const chronologicalMessages = mainMessages.slice().reverse();
  const topLevelMessages = [];

  for (const msg of chronologicalMessages) {
    // Skip threaded replies (they appear under their parent)
    if (msg.thread_ts && msg.ts !== msg.thread_ts) {
      continue;
    }

    const formattedMsg = formatMessage(msg, userMap);

    if (repliesMap.has(msg.ts)) {
      formattedMsg.replies = repliesMap.get(msg.ts).map(reply => formatMessage(reply, userMap));
    }

    topLevelMessages.push(formattedMsg);
  }

  // If thread context detected, return just that thread
  if (threadTs) {
    const threadParent = topLevelMessages.find(msg => msg.timestamp === threadTs);
    if (threadParent) {
      return {
        content: [
          {
            type: 'json',
            json: {
              context: 'thread',
              channelId,
              threadTs,
              messages: [threadParent, ...threadParent.replies]
            }
          }
        ]
      };
    }
  }

  return {
    content: [
      {
        type: 'json',
        json: {
          context: 'channel',
          channelId,
          messages: topLevelMessages
        }
      }
    ]
  };
}

function buildUserMap(messages) {
  const userMap = new Map();
  for (const msg of messages) {
    if (msg.user && msg.user_profile && !userMap.has(msg.user)) {
      userMap.set(msg.user, msg.user_profile.real_name || msg.user_profile.display_name);
    }
  }
  return userMap;
}

function resolveUserMentions(text, userMap) {
  if (!text) return '';
  return text.replace(/<@(\w+)>/g, (match, userId) => `@${userMap.get(userId) || userId}`);
}

function formatMessage(msg, userMap) {
  return {
    author: userMap.get(msg.user) || msg.user,
    timestamp: msg.ts,
    date: new Date(parseFloat(msg.ts) * 1000).toUTCString(),
    content: resolveUserMentions(msg.text, userMap),
    reactions: (msg.reactions || []).reduce((acc, r) => ({ ...acc, [r.name]: r.count }), {}),
    replies: []
  };
}
