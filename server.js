// server.js
// Backend proxy: holds the Gemini API key server-side and streams the
// response through to the frontend. The browser never sees the key.
//
// Vercel-ready: exports the app, serves /public with an absolute path, and
// uses cookie-based sessions (serverless functions can't keep sessions in
// memory between requests).

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const cookieSession = require("cookie-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();
app.set("trust proxy", 1); // required behind Vercel's proxy so secure cookies (HTTPS) work correctly
app.use(cors({ origin: true, credentials: true })); // credentials:true so the session cookie is sent

// Gzip/Brotli-compress responses to speed up page loads — but never the
// SSE chat stream, since compression buffers chunks and would kill the
// real-time "typing" effect.
app.use(
  compression({
    filter: (req, res) => {
      if (res.getHeader("Content-Type") === "text/event-stream") return false;
      return compression.filter(req, res);
    },
  })
);

app.use(express.json());

// ---------- Sessions & Passport ----------

// The whole session lives inside a signed cookie, so it works no matter
// which serverless instance handles the request.
app.use(
  cookieSession({
    name: "jarvis_session",
    keys: [process.env.SESSION_SECRET || "dev-only-secret-change-me"],
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // requires HTTPS in production
    sameSite: "lax", // lax is needed so the cookie survives the redirect back from Google
  })
);

// passport 0.6+ calls req.session.regenerate/save, which cookie-session
// doesn't provide. These no-op shims make the two work together.
app.use((req, res, next) => {
  if (req.session && !req.session.regenerate) {
    req.session.regenerate = (cb) => cb();
  }
  if (req.session && !req.session.save) {
    req.session.save = (cb) => cb();
  }
  next();
});

app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      // profile.id is Google's permanent, unique user id
      const user = {
        id: profile.id,
        name: profile.displayName,
        email: profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null,
        photo: profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null,
      };
      done(null, user);
    }
  )
);

// Store the small user object directly in the cookie (no server-side user
// store needed). Swap for a real database (MySQL etc.) later if you want
// to save per-user data like chat history.
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ---------- Auth routes ----------

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/") // send them back to your app once logged in
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    req.session = null; // clear the session cookie
    res.redirect("/");
  });
});

// Frontend calls this to check "am I logged in, and as who?"
app.get("/api/me", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ loggedIn: true, user: req.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// Optional: block a route unless the user is logged in
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Login required" });
}

// Serve the frontend files (index.html, script.js, css, etc.) from /public
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY — the server will not be able to reach Gemini.");
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { contents } = req.body;

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'contents' array." });
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${API_KEY}&alt=sse`;

  let retries = 3;
  let delay = 2000; // Start with a 2-second delay

  while (retries > 0) {
    try {
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      });

      // Handle 429 Too Many Requests (Rate Limiting) with Exponential Backoff
      if (geminiRes.status === 429 && retries > 1) {
        console.warn(`Hit Gemini 429 Rate Limit. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        retries--;
        delay *= 2;
        continue;
      }

      if (!geminiRes.ok || !geminiRes.body) {
        const errData = await geminiRes.json().catch(() => null);
        const message = errData?.error?.message || `HTTP ${geminiRes.status}`;
        return res.status(geminiRes.status).json({ error: message });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const reader = geminiRes.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const flushed = res.write(value);
        if (!flushed) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }

      return res.end();
    } catch (err) {
      console.error("Gemini proxy error:", err);
      if (!res.headersSent) {
        return res.status(500).json({ error: err.message });
      } else {
        return res.end();
      }
    }
  }

  if (!res.headersSent) {
    res.status(429).json({ error: "Jarvis is currently processing too many requests. Please try again in a few moments." });
  }
});

// Vercel imports the app; locally, `node server.js` starts a normal server.
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// --- Setup ---
// 1. npm install express cors compression dotenv cookie-session passport passport-google-oauth20
//    (express-session and session-memory-store are no longer needed;
//     Node 18+ has global fetch built in, so node-fetch isn't needed)
// 2. Env vars (locally in .env, on Vercel under Settings > Environment Variables):
//    GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//    GOOGLE_CALLBACK_URL, SESSION_SECRET  (never commit .env to git)
// 3. GOOGLE_CALLBACK_URL on Vercel must be your Vercel URL + /auth/google/callback,
//    and that exact URL must be registered as a redirect URI in Google Auth Platform > Clients.
// 4. Local run: node server.js