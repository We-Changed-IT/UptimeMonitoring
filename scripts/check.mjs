// Uptime checker — draait in GitHub Actions, schrijft resultaten naar docs/
// Geen npm-dependencies: alles met ingebouwde Node-modules.
//
// DATA_DIR wijst naar de map met monitors.json en docs/: normaal een checkout
// van de privé datarepository, zonder die instelling deze repository zelf.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.DATA_DIR ? process.env.DATA_DIR.replace(/\/?$/, "/") : ROOT;
const MONITORS = `${DATA}monitors.json`;
const STATUS = `${DATA}docs/status.json`;
const HISTORY_DIR = `${DATA}docs/history`;
const ALERT_FILE = `${ROOT}alert.txt`;

const DEFAULT_TIMEOUT = 15000;
const SLOW_MS = 3000;        // boven deze responstijd: "traag", geen storing
const CERT_WARN_DAYS = 14;   // waarschuwen als SSL-certificaat hierbinnen verloopt
const RECENT_KEEP = 288;     // ruwe metingen die we bewaren (~24u bij 5 min)
const DAILY_KEEP = 90;       // dagtotalen die we bewaren
const INCIDENTS_KEEP = 500;  // afgesloten en lopende storingen die we bewaren
const CONFIRM_ROUNDS = 2;    // pas melden als een site zoveel rondes achter elkaar faalt
const RETRY_DELAYS = [8000, 20000]; // wachttijd vóór de 2e en 3e poging binnen één ronde

const readJson = async (path, fallback) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Eerst naar een tijdelijk bestand, dan hernoemen: breekt het script halverwege
// af, dan blijft het oude bestand heel in plaats van leeg.
const writeAtomic = async (path, data) => {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
};

const slugify = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const today = () => new Date().toISOString().slice(0, 10);

// Technische foutcodes omzetten naar iets wat je zonder opzoeken begrijpt.
const ERROR_TEXT = {
  ENOTFOUND: "domein niet gevonden (DNS)",
  EAI_AGAIN: "DNS reageert niet",
  ECONNREFUSED: "server weigert de verbinding",
  ECONNRESET: "verbinding verbroken door de server",
  ETIMEDOUT: "verbinding verloopt",
  EHOSTUNREACH: "server onbereikbaar",
  ENETUNREACH: "netwerk onbereikbaar",
  UND_ERR_CONNECT_TIMEOUT: "verbinding maken duurt te lang",
  UND_ERR_SOCKET: "verbinding onverwacht gesloten",
  CERT_HAS_EXPIRED: "SSL-certificaat verlopen",
  DEPTH_ZERO_SELF_SIGNED_CERT: "SSL-certificaat ongeldig (zelf ondertekend)",
  SELF_SIGNED_CERT_IN_CHAIN: "SSL-certificaat ongeldig (zelf ondertekend)",
  ERR_TLS_CERT_ALTNAME_INVALID: "SSL-certificaat hoort bij een ander domein",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "SSL-certificaatketen onvolledig",
};

const explain = (code) => (ERROR_TEXT[code] ? `${ERROR_TEXT[code]} (${code})` : code);

const HTTP_TEXT = {
  400: "ongeldig verzoek", 401: "inloggen vereist", 403: "toegang geweigerd", 404: "pagina niet gevonden",
  410: "pagina verwijderd", 429: "te veel verzoeken", 500: "interne serverfout", 501: "niet ondersteund",
  502: "bad gateway: achterliggende server geeft geen goed antwoord", 503: "dienst tijdelijk niet beschikbaar",
  504: "gateway time-out: achterliggende server reageert niet", 508: "resourcelimiet van de hosting bereikt",
  520: "onbekende fout bij de server (Cloudflare)", 521: "webserver staat uit (Cloudflare)",
  522: "verbinding met de server verloopt (Cloudflare)", 523: "server onbereikbaar (Cloudflare)",
  524: "server reageert te traag (Cloudflare)", 525: "SSL-handshake mislukt (Cloudflare)", 526: "ongeldig SSL-certificaat op de server (Cloudflare)",
};

// Soorten storingen. De statuspagina toont deze als label.
//   dns      domeinnaam wijst nergens (meer) heen
//   connect  server onbereikbaar of weigert de verbinding
//   timeout  verbinding wel gemaakt, maar geen antwoord binnen de tijd
//   cert     probleem met het SSL-certificaat
//   server   server antwoordt met een 5xx-fout
//   http     server antwoordt met een 4xx-fout
//   content  pagina laadt, maar de inhoud klopt niet
const CERT_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_REVOKED", "CERT_UNTRUSTED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

// --- één site checken -------------------------------------------------------

async function probe(monitor) {
  const timeout = monitor.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = Date.now();
  try {
    const res = await fetch(monitor.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "uptime-monitor (github actions)",
        "Accept": "text/html,*/*",
        "Cache-Control": "no-cache",
      },
    });
    const ms = Date.now() - started;
    const code = res.status;

    const min = monitor.expectStatus?.[0] ?? 200;
    const max = monitor.expectStatus?.[1] ?? 399;
    if (code < min || code > max) {
      const text = HTTP_TEXT[code];
      return { ok: false, code, ms, category: code >= 500 ? "server" : "http", reason: `HTTP ${code}${text ? ` — ${text}` : ""}` };
    }

    // Inhoud controleren: een site kan 200 teruggeven en tóch stuk zijn.
    if (monitor.mustContain || monitor.mustNotContain) {
      const body = await res.text();
      if (monitor.mustContain && !body.includes(monitor.mustContain)) {
        return { ok: false, code, ms, category: "content", reason: `tekst "${monitor.mustContain}" niet gevonden` };
      }
      const banned = monitor.mustNotContain ?? [];
      for (const needle of [].concat(banned)) {
        if (body.includes(needle)) {
          return { ok: false, code, ms, category: "content", reason: `foutmelding gevonden: "${needle}"` };
        }
      }
    }
    return { ok: true, code, ms, reason: null, category: null };
  } catch (err) {
    const ms = Date.now() - started;
    const errCode = err?.cause?.code || err?.code;
    if (err?.name === "TimeoutError") {
      return { ok: false, code: 0, ms, category: "timeout", reason: `geen antwoord binnen ${timeout / 1000}s` };
    }
    const category = CERT_CODES.has(errCode) ? "cert"
      : errCode === "ENOTFOUND" || errCode === "EAI_AGAIN" ? "dns"
      : "connect";
    return { ok: false, code: 0, ms, category, reason: String(explain(errCode || err?.message || "netwerkfout")) };
  }
}

// --- oorzaak uitzoeken ---------------------------------------------------------
// Als een site geen HTTP-antwoord geeft, lopen we de stappen los na: DNS,
// verbinding met de server, SSL-certificaat. Zo zie je precies waar het vastloopt.

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms))]);

function tcpConnect(host, port, ms) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, ms);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function peerCertificate(host, port, ip, verify) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port, servername: host, rejectUnauthorized: verify, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert);
    });
    socket.once("error", reject);
    socket.once("timeout", () => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); });
  });
}

const certSummary = (cert) => {
  if (!cert?.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  return {
    validTo: validTo.toISOString().slice(0, 10),
    daysLeft: Math.floor((validTo - Date.now()) / 86400000),
    issuer: cert.issuer?.O ?? cert.issuer?.CN ?? null,
    subject: cert.subject?.CN ?? null,
  };
};

async function diagnose(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname;
  const https = u.protocol === "https:";
  const port = Number(u.port) || (https ? 443 : 80);

  let ip;
  try {
    const addrs = await withTimeout(dns.lookup(host, { all: true }), 10000);
    ip = addrs.find((a) => a.family === 4)?.address ?? addrs[0]?.address;
    if (!ip) throw Object.assign(new Error("geen adres"), { code: "ENODATA" });
  } catch (err) {
    const why = err.code === "ENOTFOUND" ? `${host} bestaat niet of heeft geen IP-adres`
      : err.code === "ENODATA" ? `${host} heeft geen IP-adres (A/AAAA-record ontbreekt)`
      : `DNS-server geeft geen antwoord voor ${host}`;
    return { category: "dns", reason: `DNS: ${why} (${err.code})`, ip: null };
  }

  try {
    await tcpConnect(ip, port, 10000);
  } catch (err) {
    const why = err.code === "ECONNREFUSED" ? "server weigert de verbinding"
      : err.code === "ETIMEDOUT" ? "server reageert niet"
      : err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH" ? "server onbereikbaar"
      : "verbinding mislukt";
    return { category: "connect", reason: `${why} op ${ip}:${port} (${err.code})`, ip };
  }

  if (https) {
    try {
      await peerCertificate(host, port, ip, true);
    } catch (err) {
      if (CERT_CODES.has(err.code) || /certificate|SSL|TLS/i.test(err.message)) {
        const cert = await peerCertificate(host, port, ip, false).then(certSummary).catch(() => null);
        const extra = cert
          ? [cert.subject && `voor ${cert.subject}`, cert.issuer && `uitgegeven door ${cert.issuer}`, `geldig tot ${cert.validTo}`].filter(Boolean).join(", ")
          : "";
        return { category: "cert", reason: `${explain(err.code ?? "SSL-fout")}${extra ? ` — ${extra}` : ""}`, ip, cert };
      }
      return { category: "connect", reason: `SSL-verbinding mislukt op ${ip} (${err.code ?? err.message})`, ip };
    }
  }

  // DNS, verbinding en certificaat zijn in orde: de webserver zelf antwoordt niet.
  return { category: "timeout", reason: null, ip };
}

// Een paar keer opnieuw proberen voordat we een ronde als mislukt tellen —
// scheelt loze meldingen bij een hikje in het netwerk of een herstartende server.
async function check(monitor) {
  let result = await probe(monitor);
  for (const delay of RETRY_DELAYS) {
    if (result.ok) return result;
    await new Promise((r) => setTimeout(r, delay));
    const next = await probe(monitor);
    result = next.ok ? { ...next, flaky: true } : next;
  }
  if (!result.ok && result.code === 0) {
    const found = await diagnose(monitor.url).catch(() => null);
    if (found) {
      result = {
        ...result,
        category: found.reason ? found.category : result.category,
        reason: found.reason ?? `${result.reason} — DNS, verbinding en certificaat in orde, webserver antwoordt niet`,
        ip: found.ip,
        cert: found.cert,
      };
    }
  }
  return result;
}

// --- SSL-certificaat ---------------------------------------------------------

function certificateInfo(url) {
  return new Promise((resolve) => {
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return resolve(null);
      host = u.hostname;
    } catch {
      return resolve(null);
    }
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: 10000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(certSummary(cert));
      }
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

// --- geschiedenis ------------------------------------------------------------

function updateHistory(history, result, now) {
  const point = { t: now, ok: result.ok ? 1 : 0, ms: result.ms, code: result.code };
  if (!result.ok) { point.r = result.reason; point.c = result.category; }
  const recent = [...(history.recent ?? []), point];
  const daily = { ...(history.daily ?? {}) };
  const day = today();
  const entry = daily[day] ?? { up: 0, total: 0, msSum: 0 };
  entry.total += 1;
  if (result.ok) { entry.up += 1; entry.msSum += result.ms; }
  daily[day] = entry;

  const days = Object.keys(daily).sort();
  for (const d of days.slice(0, Math.max(0, days.length - DAILY_KEEP))) delete daily[d];

  return { recent: recent.slice(-RECENT_KEEP), daily, incidents: history.incidents ?? [] };
}

// Storingslog: één regel per bevestigde storing, met begin, einde en oorzaak.
function openIncident(history, start, result) {
  if (history.incidents.some((i) => i.end === null)) return;
  const incident = { start, end: null, category: result.category, reason: result.reason, code: result.code || null };
  history.incidents = [...history.incidents, incident].slice(-INCIDENTS_KEEP);
}

// Tijdens een lopende storing kan de oorzaak veranderen (bijv. eerst geen
// verbinding, daarna een 503). We onthouden alle verschillende oorzaken.
function noteIncidentReason(history, result) {
  const open = history.incidents.findLast((i) => i.end === null);
  if (!open || open.reason === result.reason) return;
  open.also = [...new Set([...(open.also ?? []), result.reason])].slice(0, 5);
}

function closeIncident(history, end) {
  const open = history.incidents.findLast((i) => i.end === null);
  if (open) open.end = end;
}

// Uptime over de laatste 24 uur rekenen we uit de losse metingen; de dagtotalen
// zouden hier ook gisteren (en dus tot 48 uur) meetellen.
function uptimeRecent(recent, hours) {
  const cutoff = Date.now() - hours * 3600000;
  const points = recent.filter((p) => Date.parse(p.t) >= cutoff);
  if (!points.length) return null;
  return Math.round((points.filter((p) => p.ok).length / points.length) * 10000) / 100;
}

function uptimePct(daily, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let up = 0, total = 0;
  for (const [d, v] of Object.entries(daily)) {
    if (d >= cutoff) { up += v.up; total += v.total; }
  }
  return total ? Math.round((up / total) * 10000) / 100 : null;
}

// --- meldingen ---------------------------------------------------------------

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("Telegram mislukt:", err.message);
  }
}

// --- hoofdprogramma ----------------------------------------------------------

const config = await readJson(MONITORS, { monitors: [] });
const previous = await readJson(STATUS, { monitors: [] });
const prevBySlug = Object.fromEntries((previous.monitors ?? []).map((m) => [m.slug, m]));
await mkdir(HISTORY_DIR, { recursive: true });

const now = new Date().toISOString();
const events = [];
const monitors = [];

for (const monitor of config.monitors) {
  const slug = monitor.slug ?? slugify(monitor.name ?? monitor.url);
  const prev = prevBySlug[slug] ?? {};

  // Onderhoud: site overslaan, geen metingen en geen meldingen.
  if (monitor.paused) {
    monitors.push({ ...prev, slug, name: monitor.name, url: monitor.url, group: monitor.group ?? "klant", client: monitor.client ?? null, paused: true });
    console.log(`PAUZE ${monitor.name}`);
    continue;
  }

  const result = await check(monitor);

  const cert = result.ok ? await certificateInfo(monitor.url) : (result.cert ?? prev.cert ?? null);

  const historyPath = `${HISTORY_DIR}/${slug}.json`;
  const history = updateHistory(await readJson(historyPath, {}), result, now);

  const changed = prev.ok !== result.ok;
  const since = changed || prev.since === undefined ? now : prev.since;

  // Pas een storing melden als hij meerdere rondes achter elkaar aanhoudt.
  // "Weer bereikbaar" alleen als er eerder ook echt een storing gemeld is.
  const confirmRounds = monitor.confirmRounds ?? config.confirmRounds ?? CONFIRM_ROUNDS;
  const failCount = result.ok ? 0 : (prev.failCount ?? 0) + 1;
  // Oudere status.json kent `alerted` nog niet: een site die toen al plat lag,
  // is toen ook al gemeld.
  let alerted = result.ok ? false : (prev.alerted ?? prev.ok === false);

  if (!result.ok && !alerted && failCount >= confirmRounds) {
    alerted = true;
    openIncident(history, since, result);
    events.push({ level: "down", name: monitor.name, url: monitor.url, text: `${monitor.name} is onbereikbaar — ${result.reason}` });
  }
  if (!result.ok && alerted) noteIncidentReason(history, result);
  if (result.ok && (prev.alerted ?? prev.ok === false)) {
    closeIncident(history, now);
    const minutes = prev.since ? Math.round((Date.parse(now) - Date.parse(prev.since)) / 60000) : null;
    events.push({ level: "up", name: monitor.name, url: monitor.url, text: `${monitor.name} is weer bereikbaar${minutes !== null ? ` (${minutes} min offline)` : ""}` });
  }
  await writeAtomic(historyPath, JSON.stringify(history));

  // Certificaatwaarschuwing: hooguit één keer per dag per site.
  let certAlertedOn = prev.certAlertedOn ?? null;
  if (cert && cert.daysLeft <= CERT_WARN_DAYS && certAlertedOn !== today()) {
    events.push({ level: "cert", name: monitor.name, url: monitor.url, text: `SSL-certificaat van ${monitor.name} verloopt over ${cert.daysLeft} dagen (${cert.validTo})` });
    certAlertedOn = today();
  }

  monitors.push({
    slug,
    name: monitor.name,
    url: monitor.url,
    group: monitor.group ?? "klant",
    client: monitor.client ?? null,
    ok: result.ok,
    code: result.code,
    ms: result.ms,
    slow: result.ok && result.ms > (monitor.slowMs ?? SLOW_MS),
    reason: result.reason,
    category: result.category ?? null,
    ip: result.ip ?? null,
    flaky: result.flaky ?? false,
    since,
    failCount,
    alerted,
    checkedAt: now,
    cert,
    certAlertedOn,
    uptime: { d1: uptimeRecent(history.recent, 24), d7: uptimePct(history.daily, 7), d30: uptimePct(history.daily, 30), d90: uptimePct(history.daily, 90) },
  });

  console.log(`${result.ok ? "OK  " : "DOWN"} ${monitor.name} — ${result.code || "-"} in ${result.ms}ms${result.reason ? ` (${result.reason})` : ""}`);
}

const down = monitors.filter((m) => !m.ok && !m.paused);
await writeAtomic(STATUS, JSON.stringify({ title: config.title ?? null, generated: now, monitors }, null, 2));

if (events.length) {
  const icon = { down: "🔴", up: "🟢", cert: "🟠" };
  await telegram(events.map((e) => `${icon[e.level]} <b>${e.text}</b>\n${e.url}`).join("\n\n"));

  const subject = events.some((e) => e.level === "down")
    ? `Storing: ${events.filter((e) => e.level === "down").map((e) => e.name).join(", ")}`
    : events[0].text;
  const body = events.map((e) => `${e.text}\n${e.url}`).join("\n\n") + `\n\nGecontroleerd om ${new Date(now).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`;
  await writeFile(ALERT_FILE, `${subject}\n---\n${body}`);
}

console.log(down.length ? `\n${down.length} site(s) offline.` : "\nAlles draait.");
