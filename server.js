import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_PER_CHAT = 2000;
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
];

if (!TOKEN) {
  console.error('Missing BOT_TOKEN. Add it to .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = { bot: null, chats: {}, messages: {}, lastUpdateId: 0 };
try {
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  if (raw && typeof raw === 'object') {
    store.bot = raw.bot || null;
    store.chats = raw.chats || {};
    store.messages = raw.messages || {};
    store.lastUpdateId = Number(raw.lastUpdateId) || 0;
  }
} catch {}

let saveTimer = null;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, 400);
}

function flushSave() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store));
  } catch (err) {
    console.error('Failed to save store:', err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tg(method, payload = {}, { signal } = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `Telegram API error (HTTP ${res.status})`);
    err.code = data.error_code || res.status;
    throw err;
  }
  return data.result;
}

function upsertChat(chat) {
  const existing = store.chats[chat.id] || {};
  const title =
    chat.title ||
    [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
    chat.username ||
    String(chat.id);
  store.chats[chat.id] = {
    ...existing,
    id: chat.id,
    type: chat.type || existing.type || 'private',
    title,
    username: chat.username ?? existing.username ?? null,
  };
  return store.chats[chat.id];
}

function getAttachment(msg) {
  const withThumb = (kind, file, extra = {}) => ({
    kind,
    fileId: file.file_id,
    thumbFileId: file.thumbnail?.file_id || null,
    name: file.file_name || null,
    mime: file.mime_type || null,
    size: file.file_size || null,
    width: file.width || null,
    height: file.height || null,
    duration: file.duration || null,
    ...extra,
  });

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const big = msg.photo[msg.photo.length - 1];
    const small = msg.photo[0];
    return {
      kind: 'photo',
      fileId: big.file_id,
      thumbFileId: small.file_id,
      width: big.width,
      height: big.height,
      size: big.file_size || null,
    };
  }

  const simple = [
    ['sticker', 'sticker'],
    ['animation', 'animation'],
    ['video', 'video'],
    ['video_note', 'video_note'],
    ['voice', 'voice'],
    ['audio', 'audio'],
    ['document', 'document'],
  ];

  for (const [key, kind] of simple) {
    const file = msg[key];
    if (!file) continue;
    if (kind === 'document') {
      const mime = file.mime_type || '';
      if (mime.startsWith('image/')) return withThumb('photo', file);
      if (mime.startsWith('video/')) return withThumb('video', file);
      if (mime.startsWith('audio/')) return withThumb('audio', file);
    }
    return withThumb(kind, file);
  }

  if (msg.contact) {
    return {
      kind: 'contact',
      name: [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' '),
      mime: null,
    };
  }
  if (msg.venue) return { kind: 'venue', name: msg.venue.title, mime: null };
  if (msg.location) return { kind: 'location', mime: null };
  if (msg.poll) return { kind: 'poll', name: msg.poll.question, mime: null };
  if (msg.dice) return { kind: 'dice', name: msg.dice.emoji, mime: null };
  return null;
}

function normalizeMessage(msg) {
  const from = msg.from;
  return {
    id: msg.message_id,
    chatId: msg.chat.id,
    date: msg.date * 1000,
    from: from
      ? {
          id: from.id,
          name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown',
          username: from.username || null,
        }
      : null,
    text: msg.text ?? msg.caption ?? '',
    entities: msg.entities || msg.caption_entities || [],
    attachment: getAttachment(msg),
    replyTo: msg.reply_to_message
      ? {
          id: msg.reply_to_message.message_id,
          text: (msg.reply_to_message.text || msg.reply_to_message.caption || '').slice(0, 200),
        }
      : null,
    outgoing: Boolean(store.bot && from && from.id === store.bot.id),
    edited: msg.edit_date ? msg.edit_date * 1000 : null,
  };
}

function handleUpdate(update) {
  let result = null;

  if (update.my_chat_member?.chat) {
    upsertChat(update.my_chat_member.chat);
  }

  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (!msg) return null;

  const chat = upsertChat(msg.chat);
  const message = normalizeMessage(msg);
  const list = (store.messages[chat.id] ||= []);
  const index = list.findIndex((item) => item.id === message.id);

  if (index >= 0) {
    list[index] = { ...list[index], ...message };
  } else {
    list.push(message);
    if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  }

  chat.lastMessageAt = Math.max(chat.lastMessageAt || 0, message.date);
  result = { chat, message };
  return result;
}

function previewText(msg) {
  if (!msg) return 'No messages';
  if (msg.text) return msg.text.replace(/\s+/g, ' ').slice(0, 140);
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
  return labels[msg.attachment?.kind] || 'Message';
}

function chatSummaries() {
  return Object.values(store.chats)
    .map((chat) => {
      const list = store.messages[chat.id] || [];
      const last = list[list.length - 1] || null;
      return {
        id: chat.id,
        type: chat.type,
        title: chat.title,
        username: chat.username || null,
        messageCount: list.length,
        lastMessage: last
          ? {
              id: last.id,
              date: last.date,
              text: previewText(last),
              from: last.from?.name || null,
              outgoing: Boolean(last.outgoing),
            }
          : null,
      };
    })
    .sort((a, b) => (b.lastMessage?.date || 0) - (a.lastMessage?.date || 0));
}

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

const status = { running: false, ok: null, error: null, updates: 0, lastUpdateAt: null };

function publicStatus() {
  return {
    bot: store.bot
      ? { id: store.bot.id, username: store.bot.username, name: store.bot.first_name }
      : null,
    polling: status.running,
    telegramOk: status.ok,
    error: status.error,
    lastUpdateAt: status.lastUpdateAt,
    updateCount: status.updates,
    chatCount: Object.keys(store.chats).length,
    messageCount: Object.values(store.messages).reduce((sum, list) => sum + list.length, 0),
  };
}

function setStatus(ok, error) {
  const changed = status.ok !== ok || status.error !== error;
  status.ok = ok;
  status.error = error;
  if (changed) broadcast('status', publicStatus());
}

async function ensurePollingMode() {
  try {
    const info = await tg('getWebhookInfo');
    if (info.url) {
      console.log(`Webhook "${info.url}" is set; removing it so this dashboard can poll updates.`);
      await tg('deleteWebhook', { drop_pending_updates: false });
    }
  } catch (err) {
    console.error('Webhook check failed:', err.message);
  }
}

async function pollLoop() {
  status.running = true;
  broadcast('status', publicStatus());

  while (status.running) {
    try {
      if (!store.bot) {
        store.bot = await tg('getMe', {}, { signal: AbortSignal.timeout(20000) });
        console.log(`Connected as @${store.bot.username}`);
        save();
        broadcast('status', publicStatus());
      }

      const updates = await tg(
        'getUpdates',
        {
          offset: store.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ALLOWED_UPDATES,
        },
        { signal: AbortSignal.timeout(60000) },
      );

      if (!status.running) break;

      if (updates.length) {
        for (const update of updates) {
          if (update.update_id > store.lastUpdateId) store.lastUpdateId = update.update_id;
          const result = handleUpdate(update);
          if (result) broadcast('message', result);
        }
        status.updates += updates.length;
        status.lastUpdateAt = Date.now();
        save();
      }

      setStatus(true, null);
    } catch (err) {
      if (!status.running) break;
      setStatus(false, err.message);
      await sleep(err.code === 401 ? 15000 : 4000);
    }
  }
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (req, res) => {
  res.json(publicStatus());
});

app.get('/api/chats', (req, res) => {
  res.json({ chats: chatSummaries() });
});

app.get('/api/chats/:id/messages', (req, res) => {
  const list = store.messages[req.params.id] || [];
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  const sorted = [...list].sort((a, b) => a.date - b.date || a.id - b.id);
  res.json({
    chat: store.chats[req.params.id] || null,
    messages: sorted.slice(-limit),
  });
});

app.post('/api/chats/:id/messages', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required' });
  if (text.length > 4096) return res.status(400).json({ error: 'Message is too long (max 4096)' });

  try {
    const sent = await tg('sendMessage', {
      chat_id: req.params.id,
      text,
      reply_to_message_id: req.body?.replyTo || undefined,
      allow_sending_without_reply: true,
    });

    const chat = upsertChat(sent.chat);
    const message = normalizeMessage(sent);
    message.outgoing = true;

    const list = (store.messages[chat.id] ||= []);
    if (!list.some((item) => item.id === message.id)) list.push(message);
    chat.lastMessageAt = message.date;
    save();
    broadcast('message', { chat, message });
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/file/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  if (!/^[\w-]{5,200}$/.test(fileId)) return res.status(400).json({ error: 'Invalid file id' });

  try {
    const file = await tg('getFile', { file_id: fileId }, { signal: AbortSignal.timeout(20000) });
    if (!file.file_path) return res.status(404).json({ error: 'File is not available' });

    const upstream = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: 'File is not available' });
    }

    const inline = req.query.inline === '1';
    const name = String(req.query.name || path.basename(file.file_path)).replace(/[^\w.\- ]+/g, '_');

    res.setHeader('cache-control', 'public, max-age=86400');
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('content-length', length);
    res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(404).json({ error: err.message });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify(publicStatus())}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const heartbeat = setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);
heartbeat.unref();

function shutdown() {
  status.running = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  flushSave();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, HOST, async () => {
  console.log(`Telegram dashboard running at http://${HOST}:${PORT}`);
  await ensurePollingMode();
  pollLoop();
});
