'use strict';

// Durable chat jobs: a reply keeps being written on the server even when the browser disconnects, goes offline,
// or the tab is closed, and the browser picks the result up again when it is back.
//
//   users/{uid}/jobs/{key}   status, step, text, activity, error, heartbeatAt, expireAt
//
// `key` is a hash of the user's id and a client-chosen request id, so the browser can ask about its request
// knowing only that id, and sending the same request twice (for example after a dropped connection) attaches to
// the first one instead of starting a second reply.
//
// Cost design: the reply is held in memory while the model writes and is saved ONCE, in a single bundled update,
// when the model has finished. While it runs the document only gets a tiny heartbeat (and the name of the current
// step, when it changed) every HEARTBEAT_MS, so a reply costs a handful of writes instead of one per second with
// the whole text each time. A browser that is connected sees the live text over the stream; one that reconnects
// shows "working in the background" and receives the finished answer (and the thinking steps, which are stored
// apart from the answer text) when it lands. A poll for a reply running on this same instance is answered from
// memory with no database read at all. When a reply ends, the finished answer is also written into the chat itself
// (store.recordExchange).
//
// Two deployment requirements, see README "Background replies":
//   1. Cloud Run must keep CPU allocated after the client disconnects:  --no-cpu-throttling
//   2. Add a Firestore TTL policy on field `expireAt` for collection group `jobs`, so old jobs delete themselves.

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const store = require('./store');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const HEARTBEAT_MS = 15000;
const STALE_AFTER_MS = 50000;
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
    this.step = null;       // the step being worked on now, shown to a browser that is following in the background
    this.stepSaved = '';
    this.finished = false;
    this.heartbeat = null;
    this.unsubscribe = null;
    this.stopped = false;
  }

  start() {
    active.set(this.key, this);
    this.heartbeat = setInterval(() => { this.beat(); }, HEARTBEAT_MS);
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
    } else if (event.type === 'activity' && event.step) {
      this.setStep(event.step);
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
    if (record.status === 'active') this.step = { id: record.id, title: record.title };
  }

  // A small write that proves the server is alive, plus the name of the current step when it changed.
  // It never carries the reply text.
  async beat() {
    if (this.finished) return;
    const now = Date.now();
    const update = { heartbeatAt: now, updatedAt: now };
    const stepName = this.step ? this.step.title : '';
    if (stepName !== this.stepSaved) update.step = stepName;
    try {
      await this.ref.update(update);
      if ('step' in update) this.stepSaved = stepName;
    } catch (error) {
      console.warn('Reply heartbeat could not be saved:', error && (error.code || error.name));
    }
  }

  // Where the reply stands, for a poll that reaches the instance running it: no database read needed.
  snapshot() {
    return { status: 'running', step: this.step ? this.step.title : '', text: '', activity: [], error: '' };
  }

  // status: 'done' | 'error' | 'stopped' | 'interrupted'
  async finish(status, errorMessage) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.heartbeat);
    if (this.unsubscribe) { try { this.unsubscribe(); } catch { /* already closed */ } }
    active.delete(this.key);
    this.activity = this.activity.map((item) => (item.status === 'active' ? { ...item, status: status === 'error' ? 'error' : 'complete' } : item));

    // The one bundled write: the whole answer and its steps together. Retried a few times so a blip cannot lose a reply.
    const now = Date.now();
    const result = {
      status,
      step: '',
      text: this.text,
      activity: this.activity,
      error: String(errorMessage || '').slice(0, 3000),
      finishedAt: now,
      updatedAt: now,
      heartbeatAt: now
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.ref.update(result);
        break;
      } catch (error) {
        console.error('Reply result could not be saved (attempt ' + attempt + '/3):', error && (error.code || error.name), error && error.message);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
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
      step: '',
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
  const local = active.get(jobKey(uid, requestId));
  if (local && local.uid === uid && !local.finished) return local.snapshot();
  const snapshot = await jobsRef(uid).doc(jobKey(uid, requestId)).get();
  if (!snapshot.exists) return { status: 'none' };
  const data = snapshot.data();
  let status = data.status;
  if (status === 'running' && Date.now() - Number(data.heartbeatAt || 0) > STALE_AFTER_MS) status = 'interrupted';
  const terminal = status !== 'running';
  return {
    status,
    step: !terminal && typeof data.step === 'string' ? data.step : '',
    text: terminal && typeof data.text === 'string' ? data.text : '',
    activity: terminal ? store.normalizeActivitySteps(data.activity) : [],
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
