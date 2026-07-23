'use strict';
const session = require('express-session');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3401';
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'krsproperty.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';

const REDIRECT_URI = `${APP_URL}/auth/callback`;
const SCOPES = ['openid', 'profile', 'email', 'User.Read'];

console.log('[auth] REDIRECT_URI:', REDIRECT_URI);

function sessionMiddleware() {
  return session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: APP_URL.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/auth/login');
}

function authRoutes(app) {
  app.get('/auth/login', (req, res) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      response_mode: 'query',
      scope: SCOPES.join(' '),
    });
    res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: req.query.code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: SCOPES.join(' '),
      });

      const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });

      const data = await tokenRes.json();
      if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
      const email = payload.preferred_username || payload.upn || payload.email || '';
      const domain = email.split('@')[1]?.toLowerCase();

      if (domain !== ALLOWED_DOMAIN.toLowerCase()) {
        return res.status(403).send(`Access denied. Only @${ALLOWED_DOMAIN} accounts are allowed.`);
      }

      req.session.user = { email, name: payload.name || email };
      res.redirect('/');
    } catch (err) {
      console.error('[auth] callback error:', err.message);
      res.status(500).send(`Auth callback error: ${err.message}`);
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${APP_URL}`);
    });
  });

  app.get('/auth/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    res.json(req.session.user);
  });
}

module.exports = { sessionMiddleware, requireAuth, authRoutes };
