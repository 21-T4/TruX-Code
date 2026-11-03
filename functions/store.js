'use strict';

// Chat storage on Cloud Firestore.
//
//   users/{uid}/chats/{chatId}                 title, updatedAt, createdAt, messageCount, sig[]
//   users/{uid}/chats/{chatId}/messages/{n}    one document per message ("000000", "000001", ...)
//
// Why Firestore and not the Realtime Database: chats are many small ordered documents that are listed by
// recency and loaded one at a time, which is exactly what Firestore's indexed queries, per-document pricing
// and document model handle well. The Realtime Database bills and syncs by whole subtrees.
//
// What keeps it cheap:
//   - `sig` is a short hash per message kept on the chat document. A save compares the new hashes with the
//     stored ones and writes only the messages that changed, with no reads of the message documents at all.
//     (The old code rewrote and re-read every message on every save.)
//   - Listing chats returns the chat documents only, selected down to the fields the sidebar needs.
//     Messages are fetched for the one chat that is opened.
//   - Deleting a chat uses a bulk delete of the whole subtree.

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');

const BATCH_SIZE = 400;
const MAX_MESSAGES = 2000;
const LIST_LIMIT = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function chatsRef(uid) {
  return getFirestore().collection('users').doc(uid).collection('chats');
}

function messageKey(index) {
  return String(index).padStart(6, '0');
}

function normalizeActivitySteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 60).flatMap((step) => {
    if (!step || typeof step !== 'object') return [];
    const id = typeof step.id === 'string' ? step.id.trim().slice(0, 80) : '';
    const title = typeof step.title === 'string' ? step.title.trim().slice(0, 100) : '';
    if (!id || !title) return [];
    return [{
      id,
      title,
      detail: typeof step.detail === 'string' ? step.detail.slice(0, 2000) : '',
      status: ['active', 'complete', 'error'].includes(step.status) ? step.status : 'complete'
    }];
  });
}

function signature(message) {
  const text = JSON.stringify([message.role, message.content, message.error, message.activity]);
  return crypto.createHash('sha1').update(text).digest('base64url').slice(0, 10);
}

async function listChats(uid) {
  const snapshot = await chatsRef(uid).orderBy('updatedAt', 'desc').limit(LIST_LIMIT)
    .select('title', 'updatedAt', 'messageCount').get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      title: typeof data.title === 'string' ? data.title : 'New chat',
      updatedAt: Number(data.updatedAt) || 0,
      messageCount: Number(data.messageCount) || 0
    };
  });
}

async function getChat(uid, id) {
  const ref = chatsRef(uid).doc(id);
  const [meta, messages] = await Promise.all([ref.get(), ref.collection('messages').orderBy('index', 'asc').get()]);
  if (!meta.exists) return null;
  const data = meta.data();
  return {
    id,
    title: typeof data.title === 'string' ? data.title : 'New chat',
    updatedAt: Number(data.updatedAt) || 0,
    messages: messages.docs.map((doc) => {
      const item = doc.data();
      return {
        role: item.role,
        content: typeof item.content === 'string' ? item.content : '',
        error: typeof item.error === 'string' ? item.error : '',
        activity: normalizeActivitySteps(item.activity)
      };
    })
  };
}

// `body.messages` must already be validated. Returns { ignoredStaleWrite } when a newer copy exists.
async function saveChat(uid, id, body, messages) {
  if (messages.length > MAX_MESSAGES) {
    const error = new Error('This conversation is too long to sync. Keep the browser copy and start a new chat.');
    error.code = 'TOO_LARGE';
    throw error;
  }
  const db = getFirestore();
  const ref = chatsRef(uid).doc(id);
  const existing = await ref.get();
  const previous = existing.exists ? existing.data() : {};
  const updatedAtValue = Number(body.updatedAt);
  const updatedAt = Number.isFinite(updatedAtValue) && updatedAtValue > 0 ? updatedAtValue : Date.now();

  // An older in-flight update must never replace a more recent transcript.
  if (existing.exists && Number(previous.updatedAt) > updatedAt) return { ignoredStaleWrite: true };

  const oldSig = Array.isArray(previous.sig) ? previous.sig : [];
  const oldCount = Math.max(Number(previous.messageCount) || 0, oldSig.length);
  const sig = messages.map(signature);

  const operations = [];
  messages.forEach((message, index) => {
    if (oldSig[index] !== sig[index]) {
      operations.push({ ref: ref.collection('messages').doc(messageKey(index)), data: { ...message, index } });
    }
  });
  for (let index = messages.length; index < oldCount; index += 1) {
    operations.push({ ref: ref.collection('messages').doc(messageKey(index)), remove: true });
  }

  for (let start = 0; start < operations.length; start += BATCH_SIZE) {
    const batch = db.batch();
    operations.slice(start, start + BATCH_SIZE).forEach((operation) => {
      if (operation.remove) batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    });
    await batch.commit();
  }

  // The chat document goes last, so `sig` only ever describes messages that were really written.
  await ref.set({
    id,
    title: String(body.title || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 120) || 'New chat',
    updatedAt,
    createdAt: Number(previous.createdAt) || Date.now(),
    messageCount: messages.length,
    sig
  }, { merge: true });
  return { written: operations.length };
}

// Title-only change, used for chats whose messages have not been loaded on this device.
async function renameChat(uid, id, title) {
  const ref = chatsRef(uid).doc(id);
  const existing = await ref.get();
  if (!existing.exists) return false;
  await ref.update({ title: String(title || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 120) || 'New chat' });
  return true;
}

async function deleteChat(uid, id) {
  await getFirestore().recursiveDelete(chatsRef(uid).doc(id));
}

// Called by the server when a background reply finishes, so the finished answer is in the account even if the
// browser that asked for it went offline. It writes only the question and the answer, in a transaction.
async function recordExchange(uid, chatId, userIndex, userText, assistant) {
  if (!ID_PATTERN.test(chatId) || !Number.isInteger(userIndex) || userIndex < 0 || userIndex >= MAX_MESSAGES - 1) return false;
  const db = getFirestore();
  const ref = chatsRef(uid).doc(chatId);
  const question = { role: 'user', content: String(userText || '').slice(0, 200000), error: '', activity: [] };
  const answer = {
    role: 'assistant',
    content: String(assistant.content || '').slice(0, 200000),
    error: String(assistant.error || '').slice(0, 3000),
    activity: normalizeActivitySteps(assistant.activity)
  };
  const questionSig = signature(question);
  const answerSig = signature(answer);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists ? snapshot.data() : {};
    const sig = Array.isArray(previous.sig) ? previous.sig.slice() : [];
    if (sig[userIndex] === questionSig && sig[userIndex + 1] === answerSig) return; // the browser already saved it
    while (sig.length < userIndex + 2) sig.push('');
    sig[userIndex] = questionSig;
    sig[userIndex + 1] = answerSig;
    transaction.set(ref.collection('messages').doc(messageKey(userIndex)), { ...question, index: userIndex });
    transaction.set(ref.collection('messages').doc(messageKey(userIndex + 1)), { ...answer, index: userIndex + 1 });
    const now = Date.now();
    transaction.set(ref, {
      id: chatId,
      title: typeof previous.title === 'string' && previous.title ? previous.title
        : question.content.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat',
      updatedAt: now,
      createdAt: Number(previous.createdAt) || now,
      messageCount: Math.max(Number(previous.messageCount) || 0, userIndex + 2),
      sig
    }, { merge: true });
  });
  return true;
}

module.exports = {
  ID_PATTERN,
  deleteChat,
  getChat,
  listChats,
  normalizeActivitySteps,
  recordExchange,
  renameChat,
  saveChat
};
