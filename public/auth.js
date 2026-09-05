// auth.js
// Gates the entire chat UI behind Google sign-in and fills in the sidebar
// footer with the real logged-in user's name/photo.

const overlay = document.getElementById("authOverlay");
const site = document.getElementById("site");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const authBtn = document.getElementById("authBtn");
const userAvatarEl = document.getElementById("userAvatar");
const userInfoEl = document.getElementById("userInfo");

function applyAuthState(data) {
    if (data.loggedIn) {
        if (overlay) overlay.style.display = "none";
        if (site) site.style.display = "flex";

        if (userAvatarEl) {
            if (data.user.photo) {
                userAvatarEl.innerHTML = `<img src="${data.user.photo}" alt="">`;
            } else {
                userAvatarEl.textContent = (data.user.name || "?").charAt(0).toUpperCase();
            }
        }
        if (userInfoEl) {
            userInfoEl.innerHTML = `${data.user.name}<span>Signed in</span>`;
        }
        if (authBtn) authBtn.textContent = "Log out";
    } else {
        if (overlay) overlay.style.display = "flex";
        if (site) site.style.display = "none";
        if (authBtn) authBtn.textContent = "Sign in";
    }
}

async function checkAuth() {
    try {
        const res = await fetch("/api/me", { credentials: "include" });
        const data = await res.json();
        applyAuthState(data);
        return data;
    } catch (err) {
        console.error("Auth check failed:", err);
        applyAuthState({ loggedIn: false });
        return { loggedIn: false };
    }
}

if (googleSignInBtn) {
    googleSignInBtn.addEventListener("click", () => {
        window.location.href = "/auth/google";
    });
}

if (authBtn) {
    authBtn.addEventListener("click", async () => {
        const data = await checkAuth();
        if (data.loggedIn) {
            window.location.href = "/auth/logout";
        } else {
            window.location.href = "/auth/google";
        }
    });
}

// Run immediately so the overlay/site visibility is correct before ai.js
// starts touching the chat.
checkAuth();



