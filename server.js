// server.js
// Backend proxy: holds the Gemini API key server-side and streams the
// response through to the frontend. The browser never sees the key.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();
app.set("trust proxy", 1); // required behind Render's proxy so secure cookies (HTTPS) work correctly
app.use(cors({ origin: true, credentials: true })); // credentials:true so the session cookie is sent
app.use(express.json());

// ---------- Sessions & Passport ----------

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
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
      // profile.id is Google's permanent, unique user id — use this (not
      // email) as your account's primary key so one Google account can
      // never end up mapped to two of your app's accounts.
      let user = users.get(profile.id);
      if (!user) {
        user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails?.[0]?.value,
          photo: profile.photos?.[0]?.value,
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

// requireAuth here is what actually enforces the login gate the frontend
// overlay shows — without it, someone could still call this endpoint
// directly and bypass the overlay entirely.
app.post("/api/chat", requireAuth, async (req, res) => {
  const { contents } = req.body;

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'contents' array." });
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${API_KEY}&alt=sse`;

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });

    if (!geminiRes.ok || !geminiRes.body) {
      const errData = await geminiRes.json().catch(() => null);
      const message = errData?.error?.message || `HTTP ${geminiRes.status}`;
      return res.status(geminiRes.status).json({ error: message });
    }

    // Stream Server-Sent Events straight through to the client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();
  } catch (err) {
    console.error("Gemini proxy error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// --- Setup ---
// 1. npm init -y
// 2. npm install express cors dotenv express-session passport passport-google-oauth20
//    (Node 18+ has global fetch built in, so node-fetch isn't needed)
// 3. Fill in .env: GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//    GOOGLE_CALLBACK_URL, SESSION_SECRET (never commit .env to git)
// 4. In Google Auth Platform > Clients, make sure the redirect URI you
//    registered matches GOOGLE_CALLBACK_URL exactly.
// 5. node server.js