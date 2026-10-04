// Gedeeld door de statuspagina en de beheerpagina: inloggen met een
// GitHub-token en bestanden lezen/schrijven via de GitHub-API.
//
// De gegevens staan bij voorkeur in de privé repository DATA_REPO. Bestaat die
// (nog) niet of heeft het token er geen toegang toe, dan vallen we terug op
// deze openbare repository.

export const OWNER = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : "Derkvg158";
export const PUBLIC_REPO = location.hostname.endsWith(".github.io") ? location.pathname.split("/")[1] : "UptimeMonitoring";
export const DATA_REPO = "UptimeData";

const TOKEN_KEY = "uptime-token";
const OLD_TOKEN_KEY = "uptime-beheer-token";

export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
        || localStorage.getItem(OLD_TOKEN_KEY) || sessionStorage.getItem(OLD_TOKEN_KEY);
    } catch { return null; }
  },
  set(value, remember) {
    try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value); } catch {}
  },
  clear() {
    try {
      for (const s of [localStorage, sessionStorage]) { s.removeItem(TOKEN_KEY); s.removeItem(OLD_TOKEN_KEY); }
    } catch {}
  },
};

export class GitHubError extends Error {
  constructor(status) { super(`GitHub gaf ${status}`); this.status = status; }
}

export const errorText = (err, repo) => ({
  401: "Token ongeldig of verlopen.",
  403: "Dit token heeft niet genoeg rechten. Geef het Contents: Read and write.",
  404: `Niets gevonden in ${OWNER}/${repo ?? DATA_REPO}. Heeft het token toegang tot deze repository?`,
  409: "Iemand anders heeft net ook iets aangepast. Probeer het nog eens.",
  422: "Iemand anders heeft net ook iets aangepast. Probeer het nog eens.",
})[err?.status] ?? `Er ging iets mis: ${err?.message ?? err}`;

// Base64 met UTF-8, zodat namen met é of — goed opgeslagen worden.
export const toBase64 = (text) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};
export const fromBase64 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export function client(token) {
  let repo = null;

  async function request(method, repoName, path, body) {
    const url = `https://api.github.com/repos/${OWNER}/${repoName}/contents/${path}` + (method === "GET" ? `?t=${Date.now()}` : "");
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GitHubError(res.status);
    return res.json();
  }

  return {
    get repo() { return repo; },

    // Bepaalt waar de gegevens staan en controleert meteen of het token werkt.
    async connect() {
      try {
        await request("GET", DATA_REPO, "monitors.json");
        repo = DATA_REPO;
      } catch (err) {
        if (err.status !== 404) throw err;
        await request("GET", PUBLIC_REPO, "monitors.json");
        repo = PUBLIC_REPO;
      }
      return repo;
    },

    async readJson(path) {
      const data = await request("GET", repo, path);
      return { json: JSON.parse(fromBase64(data.content)), sha: data.sha };
    },

    async writeJson(path, value, sha, message) {
      const content = toBase64(JSON.stringify(value, null, 2) + "\n");
      const data = await request("PUT", repo, path, { message, content, sha });
      return data.content.sha;
    },
  };
}

// Kleine hulpjes voor beide pagina's.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Inlogscherm koppelen. onLogin krijgt een verbonden client.
export function setupLogin({ onLogin, onLogout }) {
  const form = $("login");
  const msg = $("login-msg");

  async function attempt(token, remember, store) {
    msg.className = "msg";
    msg.textContent = "Bezig…";
    const gh = client(token.trim());
    try {
      await gh.connect();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = errorText(err);
      if (!store) tokenStore.clear();
      return;
    }
    if (store) tokenStore.set(token.trim(), remember);
    msg.textContent = "";
    form.classList.add("hidden");
    await onLogin(gh);
  }

  $("login-btn").addEventListener("click", () => {
    if ($("token").value.trim()) attempt($("token").value, $("remember").checked, true);
  });
  $("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });
  for (const el of document.querySelectorAll("[data-logout]")) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      tokenStore.clear();
      $("token").value = "";
      form.classList.remove("hidden");
      onLogout?.();
    });
  }

  const saved = tokenStore.get();
  if (saved) attempt(saved, true, false);
}
