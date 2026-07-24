const EventEmitter = require('events');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  registerSession(session) {
    if (!session || !session.id) return false;
    if (this.sessions.has(session.id)) {
      this.removeSession(session.id);
    }
    this.sessions.set(session.id, session);
    return true;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  removeSession(sessionId, getMainWindow = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    try {
      if (typeof session.dispose === 'function') {
        session.dispose();
      }
    } catch {
      /* ignore cleanup errors */
    }
    this.sessions.delete(sessionId);
    this.emitSessionEvent(
      { kind: 'session', type: 'removed', sessionId },
      getMainWindow
    );
    return true;
  }

  listSessions() {
    const list = [];
    for (const session of this.sessions.values()) {
      if (typeof session.describe === 'function') {
        list.push(session.describe());
      } else {
        list.push({
          sessionId: session.id,
          kind: session.kind || 'unknown',
          status: session.status || 'active',
          metadata: session.metadata || {},
        });
      }
    }
    return list;
  }

  stopAllSessions() {
    for (const id of Array.from(this.sessions.keys())) {
      this.removeSession(id);
    }
  }

  emitSessionEvent(event, getMainWindow = null) {
    this.emit('session-event', event);
    if (typeof getMainWindow === 'function') {
      try {
        const win = getMainWindow();
        if (win && !win.isDestroyed() && win.webContents && (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())) {
          win.webContents.send('session:event', event);
        }
      } catch (err) {
        console.error('Error sending session:event event:', err);
      }
    }
  }
}

const sessionManager = new SessionManager();

module.exports = {
  sessionManager,
  SessionManager,
};
