const app = document.getElementById('app');
const chatListEl = document.getElementById('chatList');
const messagesEl = document.getElementById('messages');
const chatHeaderEl = document.getElementById('chatHeader');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const searchInput = document.getElementById('search');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statsEl = document.getElementById('stats');
const toastEl = document.getElementById('toast');

const READ_KEY = 'tg-dashboard-read';
const state = {
  chats: [],
  messages: [],
  activeId: null,
  read: loadRead(),
  status: {},
};

function loadRead() {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY)) || {};
  } catch {
    return {};
  }
}

function saveRead() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(state.read));
  } catch {}
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'tg:', 'mailto:'].includes(url.protocol) ? value : '#';
  } catch {
    return '#';
  }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(seed) {
  let hash = 0;
  const text = String(seed ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 55% 45%)`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  const date = new Date(ts);
  const now = new Date();
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function formatListTime(ts) {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatTime(ts);
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function formatBytes(size) {
  if (!size) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function renderRich(text, entities) {
  if (!entities || !entities.length) return escapeHtml(text).replace(/\n/g, '<br>');

  const sorted = [...entities]
    .filter((entity) => typeof entity.offset === 'number' && typeof entity.length === 'number')
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  let html = '';
  let cursor = 0;

  for (const entity of sorted) {
    if (entity.offset < cursor) continue;
    if (entity.offset > text.length) break;
    html += escapeHtml(text.slice(cursor, entity.offset));

    const inner = escapeHtml(text.slice(entity.offset, entity.offset + entity.length));
    switch (entity.type) {
      case 'bold':
        html += `<strong>${inner}</strong>`;
        break;
      case 'italic':
        html += `<em>${inner}</em>`;
        break;
      case 'underline':
        html += `<u>${inner}</u>`;
        break;
      case 'strikethrough':
        html += `<s>${inner}</s>`;
        break;
      case 'spoiler':
        html += `<span class="spoiler">${inner}</span>`;
        break;
      case 'code':
        html += `<code>${inner}</code>`;
        break;
      case 'pre':
        html += `<pre>${inner}</pre>`;
        break;
      case 'blockquote':
      case 'expandable_blockquote':
        html += `<blockquote>${inner}</blockquote>`;
        break;
      case 'text_link':
        html += `<a href="${escapeHtml(safeUrl(entity.url || ''))}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        break;
      case 'url':
      case 'email':
        html += `<a href="${escapeHtml(safeUrl(entity.type === 'email' ? `mailto:${text.slice(entity.offset, entity.offset + entity.length)}` : text.slice(entity.offset, entity.offset + entity.length)))}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        break;
      default:
        html += inner;
    }
    cursor = entity.offset + entity.length;
  }

  html += escapeHtml(text.slice(cursor));
  return html.replace(/\n/g, '<br>');
}

function fileUrl(fileId, inline, name) {
  const params = new URLSearchParams();
  if (inline) params.set('inline', '1');
  if (name) params.set('name', name);
  const query = params.toString();
  return `/api/file/${encodeURIComponent(fileId)}${query ? `?${query}` : ''}`;
}

function attachmentHtml(attachment) {
  if (!attachment) return '';
  const { kind, fileId, thumbFileId, name, size, width, height } = attachment;

  if (kind === 'photo' || kind === 'sticker') {
    const src = fileUrl(thumbFileId || fileId, true);
    const href = fileUrl(fileId, false, name || `${kind}.jpg`);
    const ratio = width && height ? ` style="aspect-ratio:${width}/${height}"` : '';
    return `<a class="media" href="${href}" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="${src}" alt="${kind}"${ratio} /></a>`;
  }

  if (kind === 'video' || kind === 'animation' || kind === 'video_note') {
    const poster = thumbFileId ? ` poster="${fileUrl(thumbFileId, true)}"` : '';
    return `<video class="media" controls preload="metadata"${poster} src="${fileUrl(fileId, true)}"></video>`;
  }

  if (kind === 'audio' || kind === 'voice') {
    return `<audio class="audio" controls preload="none" src="${fileUrl(fileId, true)}"></audio>`;
  }

  if (kind === 'document') {
    return `<a class="file" href="${fileUrl(fileId, false, name || 'document')}" target="_blank" rel="noopener noreferrer">
      <span class="file-kind">DOC</span>
      <span class="file-name">${escapeHtml(name || 'Document')}</span>
      <span class="file-size">${formatBytes(size)}</span>
    </a>`;
  }

  const labels = {
    contact: 'Contact',
    location: 'Location',
    venue: 'Venue',
    poll: 'Poll',
    dice: 'Dice',
  };

  return `<div class="attachment-note">${labels[kind] || 'Attachment'}${name ? `: ${escapeHtml(name)}` : ''}</div>`;
}

function renderChats() {
  const query = searchInput.value.trim().toLowerCase();
  const chats = state.chats.filter(
    (chat) =>
      !query ||
      chat.title.toLowerCase().includes(query) ||
      String(chat.username || '').toLowerCase().includes(query),
  );

  if (!chats.length) {
    chatListEl.innerHTML = `<li class="empty">${query ? 'No matching chats' : 'No chats yet'}</li>`;
    return;
  }

  chatListEl.innerHTML = chats
    .map((chat) => {
      const last = chat.lastMessage;
      const unread = Boolean(last && !last.outgoing && last.id > (state.read[chat.id] || 0));
      return `<li class="chat-item${chat.id === state.activeId ? ' active' : ''}" data-id="${chat.id}" tabindex="0">
        <div class="avatar" style="--c:${colorFor(chat.id)}">${escapeHtml(initials(chat.title))}</div>
        <div class="chat-meta">
          <div class="chat-row">
            <span class="chat-name">${escapeHtml(chat.title)}</span>
            <span class="chat-time">${last ? formatListTime(last.date) : ''}</span>
          </div>
          <div class="chat-row">
            <span class="chat-preview">${escapeHtml(last ? `${last.outgoing ? 'You: ' : ''}${last.text}` : 'No messages')}</span>
            ${unread ? '<span class="badge"></span>' : ''}
          </div>
        </div>
      </li>`;
    })
    .join('');
}

function currentChat() {
  return state.chats.find((chat) => chat.id === state.activeId) || null;
}

function renderHeader() {
  const chat = currentChat();
  if (!chat) {
    chatHeaderEl.innerHTML = `<div class="empty-head">Select a chat to view messages</div>`;
    composer.classList.add('hidden');
    return;
  }

  const subtitle = chat.username ? `@${chat.username}` : chat.type;
  chatHeaderEl.innerHTML = `<button class="back" id="back" type="button" aria-label="Back">&#8592;</button>
    <div class="avatar" style="--c:${colorFor(chat.id)}">${escapeHtml(initials(chat.title))}</div>
    <div class="chat-title">
      <h2>${escapeHtml(chat.title)}</h2>
      <span>${escapeHtml(subtitle)}</span>
    </div>
    <span class="count">${chat.messageCount} messages</span>`;

  chatHeaderEl.querySelector('#back').addEventListener('click', closeChat);
  composer.classList.remove('hidden');
}

function renderMessages() {
  if (!state.activeId) {
    messagesEl.innerHTML = `<div class="placeholder">
      <div class="placeholder-logo">TG</div>
      <p>Messages received by your bot will appear here.</p>
      <p class="hint">Send a message to the bot, or add it to a group or channel.</p>
    </div>`;
    return;
  }

  if (!state.messages.length) {
    messagesEl.innerHTML = `<div class="placeholder"><p>No messages in this chat yet.</p></div>`;
    return;
  }

  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  let lastDay = '';
  let html = '';

  for (const message of state.messages) {
    const day = formatDay(message.date);
    if (day !== lastDay) {
      html += `<div class="day"><span>${escapeHtml(day)}</span></div>`;
      lastDay = day;
    }
    html += messageHtml(message);
  }

  messagesEl.innerHTML = html;
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function messageHtml(message) {
  const mine = Boolean(message.outgoing);
  const sender = message.from?.name || 'Unknown';
  return `<div class="msg ${mine ? 'out' : 'in'}" data-id="${message.id}">
    ${mine ? '' : `<div class="avatar sm" style="--c:${colorFor(message.from?.id || message.chatId)}">${escapeHtml(initials(sender))}</div>`}
    <div class="bubble">
      ${mine ? '' : `<div class="sender">${escapeHtml(sender)}</div>`}
      ${message.replyTo ? `<div class="quote">${escapeHtml(message.replyTo.text || 'Replied message')}</div>` : ''}
      ${attachmentHtml(message.attachment)}
      ${message.text ? `<div class="text">${renderRich(message.text, message.entities)}</div>` : ''}
      <div class="meta"><span>${formatTime(message.date)}</span>${message.edited ? '<span>edited</span>' : ''}</div>
    </div>
  </div>`;
}

function markRead(chatId) {
  const chat = state.chats.find((item) => item.id === Number(chatId));
  if (!chat?.lastMessage) return;
  if (chat.lastMessage.id > (state.read[chatId] || 0)) {
    state.read[chatId] = chat.lastMessage.id;
    saveRead();
  }
}

async function loadChats() {
  try {
    const response = await fetch('/api/chats');
    const data = await response.json();
    state.chats = data.chats || [];
    renderChats();
    renderStats();
    if (state.activeId && !state.chats.some((chat) => chat.id === state.activeId)) {
      closeChat();
    }
  } catch {
    setConnection('offline', 'Cannot reach dashboard server');
  }
}

async function loadMessages(chatId) {
  try {
    const response = await fetch(`/api/chats/${chatId}/messages?limit=500`);
    if (!response.ok) throw new Error('Failed to load messages');
    const data = await response.json();
    if (state.activeId !== Number(chatId)) return;
    state.messages = data.messages || [];
    const last = state.messages[state.messages.length - 1];
    if (last) state.read[chatId] = Math.max(state.read[chatId] || 0, last.id);
    saveRead();
    renderMessages();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    renderChats();
    renderHeader();
  } catch (error) {
    showToast(error.message);
  }
}

async function openChat(chatId) {
  state.activeId = Number(chatId);
  app.classList.add('chat-open');
  state.messages = [];
  renderHeader();
  renderMessages();
  renderChats();
  await loadMessages(chatId);
  input.focus();
}

function closeChat() {
  state.activeId = null;
  state.messages = [];
  app.classList.remove('chat-open');
  composer.classList.add('hidden');
  renderHeader();
  renderMessages();
  renderChats();
}

function renderStats() {
  const status = state.status;
  const parts = [];
  if (status.chatCount != null) parts.push(`${status.chatCount} chats`);
  if (status.messageCount != null) parts.push(`${status.messageCount} messages`);
  statsEl.textContent = parts.join(' / ');
}

function setConnection(kind, text) {
  statusDot.className = `dot ${kind}`;
  statusText.textContent = text;
}

function applyStatus(status) {
  state.status = status || {};
  if (status.bot?.username) {
    setConnection(
      status.telegramOk ? 'ok' : 'error',
      status.telegramOk ? `@${status.bot.username} - live` : `@${status.bot.username} - error`,
    );
  } else {
    setConnection(status.telegramOk ? 'ok' : status.telegramOk === false ? 'error' : 'wait',
      status.telegramOk ? 'Connected' : status.telegramOk === false ? 'Connection error' : 'Connecting...');
  }
  if (status.telegramOk === false && status.error) {
    statusText.textContent = `Error: ${status.error}`;
    statusText.title = status.error;
  } else {
    statusText.removeAttribute('title');
  }
  renderStats();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    applyStatus(await response.json());
  } catch {
    setConnection('offline', 'Server offline');
  }
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

function upsertChatFromMessage(chat, message) {
  let existing = state.chats.find((item) => item.id === chat.id);
  const summary = {
    id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username || null,
    messageCount: existing?.messageCount || 0,
    lastMessage: {
      id: message.id,
      date: message.date,
      text: message.text ? message.text.replace(/\s+/g, ' ').slice(0, 140) : previewLabel(message),
      from: message.from?.name || null,
      outgoing: Boolean(message.outgoing),
    },
  };

  if (existing) {
    existing.lastMessage = summary.lastMessage;
    existing.messageCount += 1;
    existing.title = chat.title;
    existing.username = chat.username || existing.username;
  } else {
    summary.messageCount = 1;
    state.chats.push(summary);
  }

  state.chats.sort((a, b) => (b.lastMessage?.date || 0) - (a.lastMessage?.date || 0));
}

function previewLabel(message) {
  const labels = {
    photo: 'Photo',
    sticker: 'Sticker',
    video: 'Video',
    video_note: 'Video message',
    voice: 'Voice message',
    audio: 'Audio',
    animation: 'GIF',
    document: 'Document',
    contact: 'Contact',
    location: 'Location',
    venue: 'Venue',
    poll: 'Poll',
    dice: 'Dice',
  };
  return labels[message.attachment?.kind] || 'Message';
}

function connectEvents() {
  const source = new EventSource('/api/events');

  source.addEventListener('hello', (event) => {
    try {
      applyStatus(JSON.parse(event.data));
    } catch {}
  });

  source.addEventListener('status', (event) => {
    try {
      applyStatus(JSON.parse(event.data));
    } catch {}
  });

  source.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const { chat, message } = payload || {};
    if (!chat || !message) return;

    upsertChatFromMessage(chat, message);

    if (state.activeId === chat.id) {
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) state.messages[index] = { ...state.messages[index], ...message };
      else state.messages.push(message);
      state.read[chat.id] = Math.max(state.read[chat.id] || 0, message.id);
      saveRead();
      renderMessages();
    }

    renderChats();
    renderHeader();
  });

  source.onerror = () => setConnection('offline', 'Live updates reconnecting...');
}

messagesEl.addEventListener('click', (event) => {
  const spoiler = event.target.closest('.spoiler');
  if (spoiler) spoiler.classList.toggle('revealed');
});

searchInput.addEventListener('input', renderChats);

chatListEl.addEventListener('click', (event) => {
  const item = event.target.closest('.chat-item');
  if (item) openChat(item.dataset.id);
});

chatListEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const item = event.target.closest('.chat-item');
  if (item) openChat(item.dataset.id);
});

document.getElementById('refresh').addEventListener('click', async () => {
  await Promise.all([loadChats(), loadStatus()]);
  if (state.activeId) await loadMessages(state.activeId);
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !state.activeId) return;

  const button = document.getElementById('send');
  button.disabled = true;
  try {
    const response = await fetch(`/api/chats/${state.activeId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to send message');

    const message = data.message;
    if (message) {
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) state.messages[index] = { ...state.messages[index], ...message };
      else state.messages.push(message);
      upsertChatFromMessage(state.chats.find((chat) => chat.id === state.activeId) || { id: state.activeId, title: 'Chat' }, message);
      renderMessages();
      renderChats();
    }
    input.value = '';
    input.style.height = 'auto';
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    input.focus();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

loadStatus();
loadChats();
connectEvents();
setInterval(loadStatus, 30000);
setInterval(loadChats, 60000);
