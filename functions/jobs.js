'use strict';

// Durable chat jobs: a reply keeps being written on the server even when the browser disconnects, goes offline,
// or the tab is closed, and the browser picks the result up again when it is back.
//
//   users/{uid}/jobs/{key}   status, text, activity, error, heartbeatAt, expireAt
//
// `key` is a hash of the user's id and a client-chosen request id, so the browser can ask about its request
// knowing only that id, and sending the same request twice (for example after a dropped connection) attaches to
// the first one instead of starting a second reply. While a reply runs, its partial text and steps are saved about
// once a second. When it ends, the finished answer is also written into the chat itself (store.recordExchange).
//
// Two deployment requirements, see README "Background replies":
//   1. Cloud Run must keep CPU allocated after the client disconnects:  --no-cpu-throttling
//   2. Add a Firestore TTL policy on field `expireAt` for collection group `jobs`, so old jobs delete themselves.

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const store = require('./store');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const FLUSH_MS = 1000;
const HEARTBEAT_MS = 5000;
const STALE_AFTER_MS = 45000;
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 700000;
const MAX_STEPS = 60;

const active = new Map(); // key -> Recorder, for jobs running on this instance

function jobKey(uid, requestId) {
  return crypto.createHash('sha256').update(uid + ':' + requestId).digest('hex').slice(0, 32);
}

function jobsRef(uid) {
  return getFirestore().collection('users').doc(uid).collection('jobs');
}

function isAlreadyExists(error) {
  return Boolean(error) && (error.code === 6 || error.code === 'already-exists' || /ALREADY_EXISTS/.test(String(error.message || '')));
}

class Recorder {
  constructor(uid, key, requestId, info) {
    this.uid = uid;
    this.key = key;
    this.requestId = requestId;
    this.info = info || {};
    this.ref = jobsRef(uid).doc(key);
    this.controller = new AbortController();
    this.text = '';
    this.activity = [];
    this.dirty = false;
    this.finished = false;
    this.flushTimer = null;
    this.heartbeat = null;
    this.unsubscribe = null;
    this.stopped = false;
  }

  start() {
    active.set(this.key, this);
    this.heartbeat = setInterval(() => { this.flush(true); }, HEARTBEAT_MS);
    // A "stop" can arrive on a different Cloud Run instance than the one running the reply, so watch the document.
    this.unsubscribe = this.ref.onSnapshot((snapshot) => {
      const data = snapshot.data();
      if (data && data.stopRequested && !this.stopped) this.requestStop();
    }, () => {});
  }

  requestStop() {
    this.stopped = true;
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  get signal() { return this.controller.signal; }

  observe(event) {
    if (!event || this.finished) return;
    if (event.type === 'delta' && typeof event.text === 'string') {
      if (this.text.length < MAX_TEXT) this.text += event.text;
      this.dirty = true;
      this.schedule();
    } else if (event.type === 'activity' && event.step) {
      this.setStep(event.step);
      this.dirty = true;
      this.schedule();
    }
  }

  setStep(step) {
    const record = {
      id: String(step.id || '').slice(0, 80),
      title: String(step.title || '').slice(0, 100),
      detail: String(step.detail || '').slice(0, 2000),
      status: ['active', 'complete', 'error'].includes(step.status) ? step.status : 'complete'
    };
    if (!record.id || !record.title) return;
    // Thinking text is long while it streams; once finished, only its tail is worth storing.
    if (record.status === 'complete' && record.title === 'Thinking') record.detail = record.detail.slice(-800);
    this.activity = this.activity.map((item) => (item.status === 'active' && item.id !== record.id ? { ...item, status: 'complete' } : item));
    const index = this.activity.findIndex((item) => item.id === record.id);
    if (index >= 0) this.activity[index] = record;
    else if (this.activity.length < MAX_STEPS) this.activity.push(record);
  }

  schedule() {
    if (this.flushTimer || this.finished) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(false); }, FLUSH_MS);
  }

  async flush(heartbeatOnly) {
    if (this.finished || (heartbeatOnly && this.dirty)) return;
    const now = Date.now();
    const update = { heartbeatAt: now, updatedAt: now };
    if (this.dirty) {
      update.text = this.text;
      update.activity = this.activity;
      this.dirty = false;
    }
    try {
      await this.ref.update(update);
    } catch (error) {
      this.dirty = true;
      console.warn('Reply progress could not be saved:', error && (error.code || error.name));
    }
  }

  // status: 'done' | 'error' | 'stopped' | 'interrupted'
  async finish(status, errorMessage) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.flushTimer);
    clearInterval(this.heartbeat);
    if (this.unsubscribe) { try { this.unsubscribe(); } catch { /* already closed */ } }
    active.delete(this.key);
    this.activity = this.activity.map((item) => (item.status === 'active' ? { ...item, status: status === 'error' ? 'error' : 'complete' } : item));

    const now = Date.now();
    try {
      await this.ref.update({
        status,
        text: this.text,
        activity: this.activity,
        error: String(errorMessage || '').slice(0, 3000),
        finishedAt: now,
        updatedAt: now,
        heartbeatAt: now
      });
    } catch (error) {
      console.error('Reply result could not be saved:', error && (error.code || error.name), error && error.message);
    }

    const chat = this.info.chat;
    if (chat && status !== 'interrupted') {
      try {
        await store.recordExchange(this.uid, chat.id, chat.userIndex, chat.userText, {
          content: this.text,
          error: status === 'error' ? errorMessage : status === 'stopped' && !this.text.trim() ? 'Stopped before a response was written.' : '',
          activity: this.activity
        });
      } catch (error) {
        console.warn('Finished reply could not be added to the chat:', error && (error.code || error.name));
      }
    }
  }
}

// Starts a job, or reports that one already exists for this request.
async function begin(uid, requestId, info) {
  if (!REQUEST_ID_PATTERN.test(String(requestId || ''))) {
    const error = new Error('The request is missing a valid request id.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  const key = jobKey(uid, requestId);
  const now = Date.now();
  try {
    await jobsRef(uid).doc(key).create({
      requestId,
      status: 'running',
      model: String(info.model || ''),
      text: '',
      activity: [],
      error: '',
      stopRequested: false,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      expireAt: Timestamp.fromMillis(now + TTL_MS)
    });
  } catch (error) {
    if (isAlreadyExists(error)) return { existing: true, key };
    throw error;
  }
  const recorder = new Recorder(uid, key, requestId, info);
  recorder.start();
  return { existing: false, key, recorder };
}

async function read(uid, requestId) {
  if (!REQUEST_ID_PATTERN.test(String(requestId || ''))) return { status: 'none' };
  const snapshot = await jobsRef(uid).doc(jobKey(uid, requestId)).get();
  if (!snapshot.exists) return { status: 'none' };
  const data = snapshot.data();
  let status = data.status;
  if (status === 'running' && Date.now() - Number(data.heartbeatAt || 0) > STALE_AFTER_MS) status = 'interrupted';
  return {
    status,
    text: typeof data.text === 'string' ? data.text : '',
    activity: store.normalizeActivitySteps(data.activity),
    error: typeof data.error === 'string' ? data.error : ''
  };
}

async function requestStop(uid, requestId) {
  if (!REQUEST_ID_PATTERN.test(String(requestId || ''))) return false;
  const key = jobKey(uid, requestId);
  const local = active.get(key);
  if (local && local.uid === uid) local.requestStop();
  try {
    await jobsRef(uid).doc(key).update({ stopRequested: true });
  } catch { /* the job may not exist; stopping is then a no-op */ }
  return true;
}

// Called on SIGTERM so browsers learn quickly that a reply will not finish, and can offer to retry.
async function interruptAll() {
  const running = Array.from(active.values());
  await Promise.allSettled(running.map((recorder) => {
    recorder.requestStop();
    return recorder.finish('interrupted', 'The server restarted before this reply finished. Retry to generate it again.');
  }));
}

module.exports = { REQUEST_ID_PATTERN, begin, interruptAll, read, requestStop };
