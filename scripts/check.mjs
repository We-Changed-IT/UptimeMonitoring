// Uptime checker — draait in GitHub Actions, schrijft resultaten naar docs/
// Geen npm-dependencies: alles met ingebouwde Node-modules.
//
// DATA_DIR wijst naar de map met monitors.json en docs/: normaal een checkout
// van de privé datarepository, zonder die instelling deze repository zelf.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runCheck, typeOf, CERT_WARN_DAYS } from "./checks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.DATA_DIR ? process.env.DATA_DIR.replace(/\/?$/, "/") : ROOT;
const MONITORS = `${DATA}monitors.json`;
const STATUS = `${DATA}docs/status.json`;
const HISTORY_DIR = `${DATA}docs/history`;
const ALERT_FILE = `${ROOT}alert.txt`;

const SLOW_MS = 3000;        // boven deze responstijd: "traag", geen storing
const RECENT_KEEP = 288;     // ruwe metingen die we bewaren (~24u bij 5 min)
const DAILY_KEEP = 90;       // dagtotalen die we bewaren
const INCIDENTS_KEEP = 500;  // afgesloten en lopende storingen die we bewaren
const CONFIRM_ROUNDS = 2;    // pas melden als een monitor zoveel rondes achter elkaar faalt

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

// Telegram gebruikt HTML-opmaak; tekst uit DNS-records kan < of & bevatten.
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

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

const TYPE_LABEL = { website: "Website", mail: "Mail", domein: "Domein", dns: "DNS", poort: "Poort" };
// Website en poort zijn "onbereikbaar"; bij mail, domein en DNS klopt er iets niet.
const downText = (type) => (type === "website" || type === "poort" ? "is onbereikbaar" : "heeft een storing");
const upText = (type) => (type === "website" || type === "poort" ? "is weer bereikbaar" : "is weer in orde");

const config = await readJson(MONITORS, { monitors: [] });
const previous = await readJson(STATUS, { monitors: [] });
const prevBySlug = Object.fromEntries((previous.monitors ?? []).map((m) => [m.slug, m]));
await mkdir(HISTORY_DIR, { recursive: true });

const now = new Date().toISOString();
const events = [];
const monitors = [];

for (const monitor of config.monitors) {
  const type = typeOf(monitor);
  const target = type === "website" ? monitor.url : monitor.target;
  const slug = monitor.slug ?? slugify(monitor.name ?? target);
  const prev = prevBySlug[slug] ?? {};
  const base = {
    slug,
    name: monitor.name,
    type,
    url: type === "website" ? monitor.url : null,
    target: type === "website" ? null : monitor.target,
    ...(type === "mail" ? { provider: monitor.provider ?? "overig" } : {}),
    ...(type === "dns" ? { record: monitor.record ?? "A", expect: monitor.expect ?? null } : {}),
    group: monitor.group ?? "klant",
    client: monitor.client ?? null,
  };

  // Onderhoud: monitor overslaan, geen metingen en geen meldingen.
  if (monitor.paused) {
    monitors.push({ ...prev, ...base, paused: true });
    console.log(`PAUZE ${monitor.name}`);
    continue;
  }

  const result = await runCheck(monitor);
  const cert = type !== "website" ? null : result.ok ? result.cert : (result.cert ?? prev.cert ?? null);

  const historyPath = `${HISTORY_DIR}/${slug}.json`;
  const history = updateHistory(await readJson(historyPath, {}), result, now);

  const changed = prev.ok !== result.ok;
  const since = changed || prev.since === undefined ? now : prev.since;
  const link = target ?? "";

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
    events.push({ level: "down", name: monitor.name, url: link, text: `${monitor.name} ${downText(type)} — ${result.reason}` });
  }
  if (!result.ok && alerted) noteIncidentReason(history, result);
  if (result.ok && (prev.alerted ?? prev.ok === false)) {
    closeIncident(history, now);
    const minutes = prev.since ? Math.round((Date.parse(now) - Date.parse(prev.since)) / 60000) : null;
    events.push({ level: "up", name: monitor.name, url: link, text: `${monitor.name} ${upText(type)}${minutes !== null ? ` (${minutes} min ${type === "website" || type === "poort" ? "offline" : "storing"})` : ""}` });
  }
  await writeAtomic(historyPath, JSON.stringify(history));

  // Certificaatwaarschuwing: hooguit één keer per dag per site, zolang het speelt.
  let certAlertedOn = prev.certAlertedOn ?? null;
  if (cert && cert.daysLeft <= CERT_WARN_DAYS && certAlertedOn !== today()) {
    events.push({ level: "warn", name: monitor.name, url: link, text: `SSL-certificaat van ${monitor.name} verloopt over ${cert.daysLeft} dagen (${cert.validTo})` });
    certAlertedOn = today();
  }

  // Overige waarschuwingen (SPF, DKIM, DMARC, vervaldatum domein, ...): één
  // melding zodra er een nieuwe bijkomt, hooguit één keer per dag per monitor.
  // Verdwijnt een waarschuwing, dan telt hij later weer als nieuw.
  const warnings = result.warnings ?? [];
  const activeKeys = warnings.map((w) => w.key);
  let warnAlertedOn = prev.warnAlertedOn ?? null;
  let warnAlerted = (prev.warnAlerted ?? []).filter((k) => activeKeys.includes(k));
  const fresh = warnings.filter((w) => w.key !== "cert" && !warnAlerted.includes(w.key));
  if (fresh.length && warnAlertedOn !== today()) {
    events.push({ level: "warn", name: monitor.name, url: link, text: `Let op bij ${monitor.name}: ${fresh.map((w) => w.text).join("; ")}` });
    warnAlerted = [...warnAlerted, ...fresh.map((w) => w.key)];
    warnAlertedOn = today();
  }

  monitors.push({
    ...base,
    ok: result.ok,
    code: result.code,
    ms: result.ms,
    slow: result.ok && (type === "website" || type === "poort") && result.ms > (monitor.slowMs ?? SLOW_MS),
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
    warnings,
    warnAlerted,
    warnAlertedOn,
    details: result.details ?? null,
    uptime: { d1: uptimeRecent(history.recent, 24), d7: uptimePct(history.daily, 7), d30: uptimePct(history.daily, 30), d90: uptimePct(history.daily, 90) },
  });

  const extra = [result.reason, ...warnings.map((w) => `let op: ${w.text}`)].filter(Boolean).join("; ");
  console.log(`${result.ok ? "OK  " : "DOWN"} [${type}] ${monitor.name} — ${result.code || "-"} in ${result.ms}ms${extra ? ` (${extra})` : ""}`);
}

const down = monitors.filter((m) => !m.ok && !m.paused);
await writeAtomic(STATUS, JSON.stringify({ title: config.title ?? null, generated: now, monitors }, null, 2));

if (events.length) {
  const icon = { down: "🔴", up: "🟢", warn: "🟠" };
  await telegram(events.map((e) => `${icon[e.level]} <b>${escapeHtml(e.text)}</b>${e.url ? `\n${escapeHtml(e.url)}` : ""}`).join("\n\n"));

  const subject = events.some((e) => e.level === "down")
    ? `Storing: ${events.filter((e) => e.level === "down").map((e) => e.name).join(", ")}`
    : events[0].text;
  const body = events.map((e) => `${e.text}${e.url ? `\n${e.url}` : ""}`).join("\n\n") + `\n\nGecontroleerd om ${new Date(now).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`;
  await writeFile(ALERT_FILE, `${subject}\n---\n${body}`);
}

console.log(down.length ? `\n${down.length} monitor(s) met een storing.` : "\nAlles draait.");
