// signaling.js — minimal WebSocket client with typed events and request/response support.
//
// Usage:
//   const sig = new Signaling(wsURL);
//   await sig.connect();
//   sig.on('peer-joined', payload => ...);
//   sig.send('chat', { text: 'hi' });
//   const answer = await sig.request('webrtc-offer', { ... });

export class Signaling {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.listeners = new Map();       // type -> Set<handler>
    this.pending = new Map();         // reqId -> {resolve, reject, timer}
    this._reqSeq = 0;
    this._closedByUser = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      const ws = this.ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => {
        // First connection failure rejects the connect promise.
        if (ws.readyState !== WebSocket.OPEN) reject(new Error('WebSocket failed'));
        this._emit('_error', e);
      });
      ws.addEventListener('close', () => {
        // Reject any in-flight requests.
        for (const [reqId, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          p.reject(new Error('connection closed'));
          this.pending.delete(reqId);
        }
        this._emit('_close');
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
    });
  }

  _onMessage(ev) {
    let env;
    try {
      env = JSON.parse(ev.data);
    } catch (err) {
      console.warn('[sig] bad json', err);
      return;
    }
    const { type, reqId, payload } = env;

    // Resolve pending request first.
    if (reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId);
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (type === 'error') {
        p.reject(new Error(payload && payload.message ? payload.message : 'server error'));
      } else {
        p.resolve(payload || {});
      }
      return;
    }
    this._emit(type, payload || {});
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }
  off(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }
  _emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try { h(payload); } catch (e) { console.error(`[sig] listener for ${type} threw`, e); }
    }
  }

  /** Send a fire-and-forget message. */
  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    const env = { type, payload: payload || {} };
    this.ws.send(JSON.stringify(env));
  }

  /** Send a request expecting a single reply with the same reqId. */
  request(type, payload, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const reqId = `r${++this._reqSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`request ${type} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      const env = { type, reqId, payload: payload || {} };
      this.ws.send(JSON.stringify(env));
    });
  }

  close() {
    this._closedByUser = true;
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch (_) {}
    }
  }
}
