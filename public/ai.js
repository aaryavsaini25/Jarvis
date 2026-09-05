// script.js
// Frontend now talks to our own backend (/api/chat) instead of calling
// Gemini directly. No API key lives in this file anymore.

const URL = "/api/chat"; // same-origin call to our Express server

const chat = document.getElementById("chatbox");
const form = document.getElementById("form_input");
const input = document.getElementById("inputbox");
const welcome = document.getElementById("Welcome");
const chatListEl = document.getElementById("chatList");     // <div> that lists saved chats
const newChatBtn = document.getElementById("newChatBtn");   // "+ New Chat" button

const STORAGE_KEY = "gemini_chat_sessions_v1";

// Must be even so we never cut mid-(user, model) pair, and Gemini requires
// the first turn in `contents` to be role "user".
const MAX_HISTORY_MESSAGES = 20;
const NAME_WORD_LIMIT = 6;     // how many words of the first message to use
const NAME_CHAR_LIMIT = 40;    // hard cap so long words don't blow out the sidebar

/** @type {{id:string, name:string, named:boolean, history:Array}[]} */
let sessions = [];
let currentSessionId = null;

// ---------- Persistence ----------

function loadSessions() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.sessions) && parsed.sessions.length) {
                sessions = parsed.sessions;
                currentSessionId = parsed.currentSessionId || sessions[0].id;
                return;
            }
        }
    } catch {
        // corrupted storage — fall through to creating a fresh session
    }
    const fresh = makeSession();
    sessions = [fresh];
    currentSessionId = fresh.id;
}

function saveSessions() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, currentSessionId }));
    } catch {
        // storage full or unavailable — chat still works, just won't persist
        console.warn("Could not save chat sessions to localStorage.");
    }
}

// ---------- Session management ----------

function makeSession() {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        name: "New chat",
        named: false, // becomes true once we've derived a name from the first message
        history: [],
    };
}

function getCurrentSession() {
    return sessions.find(s => s.id === currentSessionId);
}

function createNewChat() {
    // If we're already sitting on an empty, unstarted chat, just stay on it
    // instead of piling up duplicate blank sessions in the sidebar.
    const current = getCurrentSession();
    if (current && current.history.length === 0) {
        return;
    }

    const s = makeSession();
    sessions.unshift(s); // newest chat at the top of the list
    currentSessionId = s.id;
    saveSessions();
    renderChatList();
    renderActiveChat();
}

function switchToSession(id) {
    if (id === currentSessionId) return;
    currentSessionId = id;
    saveSessions();
    renderChatList();
    renderActiveChat();
}

/**
 * Turns a user's first message into a short chat title.
 * e.g. "how do I center a div in css??" -> "How Do I Center A Div"
 */
function generateChatName(text) {
    const cleaned = text.trim().replace(/\s+/g, " ");
    const words = cleaned.split(" ").slice(0, NAME_WORD_LIMIT);
    let name = words.join(" ");
    if (name.length > NAME_CHAR_LIMIT) {
        name = name.slice(0, NAME_CHAR_LIMIT).trimEnd() + "…";
    } else if (words.length < cleaned.split(" ").length) {
        name += "…";
    }
    // Title-case each word for a cleaner sidebar look
    name = name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1));
    return name || "New chat";
}

function ensureUniqueName(name, excludeId) {
    const taken = new Set(sessions.filter(s => s.id !== excludeId).map(s => s.name));
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
}

// ---------- Rendering ----------

function renderChatList() {
    if (!chatListEl) return;
    chatListEl.innerHTML = "";
    for (const s of sessions) {
        const item = document.createElement("div");
        item.className = "chat-list-item" + (s.id === currentSessionId ? " active" : "");
        item.textContent = s.name;
        item.title = s.name;
        item.addEventListener("click", () => switchToSession(s.id));
        chatListEl.appendChild(item);
    }
}

function renderActiveChat() {
    const session = getCurrentSession();

    // Remove only message bubbles / typing indicators — never touch #Welcome
    // itself (removing it from the DOM would make it impossible to show
    // again later, since `welcome` is a cached reference to that one node).
    chat.querySelectorAll(".user, .bot").forEach(el => el.remove());

    if (!session || session.history.length === 0) {
        if (welcome) welcome.style.display = "";
        return;
    }
    if (welcome) welcome.style.display = "none";

    for (const turn of session.history) {
        const text = turn.parts?.[0]?.text || "";
        if (turn.role === "user") {
            const p = document.createElement("div");
            p.className = "user";
            p.textContent = text;
            chat.appendChild(p);
        } else {
            const p = document.createElement("div");
            p.className = "bot";
            renderBotMarkdown(p, text);
            chat.appendChild(p);
        }
    }
    chat.scrollTop = chat.scrollHeight;
}

function addUserMessage(text) {
    if (welcome) welcome.style.display = "none";
    const p = document.createElement("div");
    p.className = "user";
    p.textContent = text; // plain text only — never render user input as HTML
    chat.appendChild(p);
    chat.scrollTop = chat.scrollHeight;
    return p;
}

function createBotMessageContainer() {
    const p = document.createElement("div");
    p.className = "bot";
    chat.appendChild(p);
    chat.scrollTop = chat.scrollHeight;
    return p;
}

function showTypingIndicator() {
    const wrap = document.createElement("div");
    wrap.className = "bot typing-indicator";
    wrap.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
}

function renderBotMarkdown(el, text) {
    el.innerHTML = marked.parse(text);
    if (window.renderMathInElement) {
        renderMathInElement(el, {
            delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "$", right: "$", display: false }
            ]
        });
    }
}

function trimHistory(history) {
    if (history.length > MAX_HISTORY_MESSAGES) {
        let excess = history.length - MAX_HISTORY_MESSAGES;
        if (excess % 2 !== 0) excess += 1; // keep pairs intact, keep first entry role "user"
        return history.slice(excess);
    }
    return history;
}

// ---------- Init ----------

loadSessions();
renderChatList();
renderActiveChat();

if (newChatBtn) newChatBtn.addEventListener("click", createNewChat);

// ---------- Send flow ----------

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    const session = getCurrentSession();
    const sessionId = session.id; // pin this — currentSessionId may change mid-stream
    const isActive = () => currentSessionId === sessionId;

    addUserMessage(message);
    input.value = "";
    session.history.push({ role: "user", parts: [{ text: message }] });
    session.history = trimHistory(session.history);

    // Name the chat off the very first user message
    if (!session.named) {
        session.name = ensureUniqueName(generateChatName(message), session.id);
        session.named = true;
        renderChatList();
    }
    saveSessions();

    const typingEl = isActive() ? showTypingIndicator() : null;
    let botEl = null;
    let fullText = "";

    try {
        const res = await fetch(URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: session.history }),
        });

        if (!res.ok || !res.body) {
            const errData = await res.json().catch(() => null);
            const msg = errData?.error?.message || `HTTP ${res.status}`;
            if (isActive()) {
                typingEl?.remove();
                botEl = createBotMessageContainer();
                botEl.textContent = `Error: ${msg}`;
            }
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep last (possibly incomplete) line for next chunk

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine.startsWith("data:")) continue;

                const jsonStr = trimmedLine.slice(5).trim();
                if (!jsonStr || jsonStr === "[DONE]") continue;

                try {
                    const parsed = JSON.parse(jsonStr);

                    if (parsed.error) {
                        if (isActive()) {
                            if (!botEl) { typingEl?.remove(); botEl = createBotMessageContainer(); }
                            botEl.textContent = `Error: ${parsed.error.message}`;
                        }
                        continue;
                    }

                    const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
                    if (chunk) {
                        fullText += chunk;
                        // Only touch the DOM if the user is still looking at this chat.
                        if (isActive()) {
                            if (!botEl) {
                                typingEl?.remove(); // swap the typing dots for the real message on first chunk
                                botEl = createBotMessageContainer();
                            }
                            // Show plain text while streaming (fast); full markdown render happens once at the end
                            botEl.textContent = fullText;
                            chat.scrollTop = chat.scrollHeight;
                        }
                    }
                } catch {
                    // Incomplete JSON chunk split across reads — ignore and wait for more data
                }
            }
        }

        if (fullText) {
            // Always save to the *originating* session's history, even if the
            // user has since switched chats.
            session.history.push({ role: "model", parts: [{ text: fullText }] });
            session.history = trimHistory(session.history);
            saveSessions();

            if (isActive() && botEl) {
                renderBotMarkdown(botEl, fullText);
            }
        } else if (isActive() && !botEl) {
            typingEl?.remove();
            botEl = createBotMessageContainer();
            botEl.textContent = "Error: no reply";
        }
    } catch (err) {
        console.error(err);
        if (isActive()) {
            if (!botEl) { typingEl?.remove(); botEl = createBotMessageContainer(); }
            botEl.textContent = `Error: ${err.message}`;
        }
    } finally {
        if (typingEl?.isConnected) typingEl.remove();
    }
});