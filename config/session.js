// Session cookie settings, and the secret that signs logins (website session
// cookies and the app's sign-in tokens).
const crypto = require('crypto');

const DEV_SECRET = 'atlasphere-secret-key-change-in-production';
const hosted = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production');

function chooseSecret() {
  const set = String(process.env.SESSION_SECRET || '').trim();
  if (set) {
    if (set.length < 32) console.warn('WARNING: SESSION_SECRET is short; use at least 32 random characters.');
    return set;
  }
  // Never sign real logins with a secret that's in the public source code.
  // Without SESSION_SECRET the live site makes a random one at start-up: it's
  // safe, but everyone is signed out at each restart until it's set.
  if (hosted) {
    console.error('SECURITY: SESSION_SECRET is not set. Using a random secret for now; set SESSION_SECRET in the environment.');
    return crypto.randomBytes(48).toString('hex');
  }
  return DEV_SECRET; // local development only
}

module.exports = {
  secret: chooseSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,   // not readable from page scripts
    sameSite: 'lax',  // not sent on cross-site form posts (CSRF protection)
    secure: 'auto',   // HTTPS-only cookie whenever the request came over HTTPS
  }
};
