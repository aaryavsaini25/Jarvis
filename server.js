// server.js
// Backend proxy: holds the Gemini API key server-side and streams the
// response through to the frontend. The browser never sees the key.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const session = require('express-session');
const MemoryStore = require('session-memory-store')(session); 
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();
app.set("trust proxy", 1); // required behind Render's proxy so secure cookies (HTTPS) work correctly
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

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new MemoryStore({
      checkPeriod: 86400000 // Prunes expired entries every 24h to save RAM
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // requires HTTPS in production
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// TEMPORARY in-memory user store — swap for a real database (MySQL etc.)
// before going to production. Keyed by Google's stable user id.
const users = new Map();

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      // profile.id is Google's permanent, unique user id
      let user = users.get(profile.id);
      if (!user) {
        user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails && profile.emails[0] ? profile.emails[0].value : null, // Fixed syntax error safely
          photo: profile.photos && profile.photos[0] ? profile.photos[0].value : null, // Fixed syntax error safely
        };
        users.set(profile.id, user);
      }
      done(null, user);
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, users.get(id) || null));

// ---------- Auth routes ----------

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/") // send them back to your app once logged in
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
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
app.use(express.static("public"));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env — the server will not be able to reach Gemini.");
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { contents } = req.body;

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'contents' array." });
  }

  const geminiUrl = `https://googleapis.com{MODEL}:streamGenerateContent?key=${API_KEY}&alt=sse`;

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
        await new Promise(resolve => setTimeout(resolve, delay));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
