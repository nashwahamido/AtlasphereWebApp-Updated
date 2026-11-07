module.exports = {
  secret: process.env.SESSION_SECRET || 'atlasphere-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,   // not readable from page scripts
    sameSite: 'lax',  // not sent on cross-site form posts (CSRF protection)
    secure: 'auto',   // HTTPS-only cookie whenever the request came over HTTPS
  }
};
