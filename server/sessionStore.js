'use strict';
// Minimal file-backed session store so logins survive pm2 restarts.
// Sessions are small JSON files in server/../sessions/; no extra dependencies.
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

class FileSessionStore extends session.Store {
  constructor() {
    super();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  _file(sid) {
    // sid comes from express-session (base64url); strip anything path-unsafe anyway
    return path.join(SESSIONS_DIR, sid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  }

  get(sid, cb) {
    fs.readFile(this._file(sid), 'utf8', (err, data) => {
      if (err) return cb(null, null);
      try {
        const sess = JSON.parse(data);
        const expires = sess.cookie && sess.cookie.expires;
        if (expires && new Date(expires) < new Date()) {
          this.destroy(sid, () => cb(null, null));
          return;
        }
        cb(null, sess);
      } catch {
        cb(null, null);
      }
    });
  }

  set(sid, sess, cb) {
    fs.writeFile(this._file(sid), JSON.stringify(sess), err => cb && cb(err));
  }

  destroy(sid, cb) {
    fs.unlink(this._file(sid), () => cb && cb());
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = { FileSessionStore };
