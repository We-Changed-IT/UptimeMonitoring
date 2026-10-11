// De testsoorten van de uptime-monitor. Elke test geeft hetzelfde resultaat:
//   { ok, reason, category, ms, code, warnings: [{ key, text }], details }
// zodat storingen, meldingen en uptime voor alle soorten precies hetzelfde werken.
//
// DNS, fetch en TCP zijn injecteerbaar (deps), zodat je de tests zonder
// internet kunt nabootsen. Geen npm-dependencies.

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

export const TYPES = ["website", "mail", "domein", "dns", "poort"];
export const typeOf = (monitor) => (TYPES.includes(monitor?.type) ? monitor.type : "website");

const DEFAULT_TIMEOUT = 15000;
export const CERT_WARN_DAYS = 14;    // waarschuwen als SSL-certificaat hierbinnen verloopt
const DOMAIN_WARN_DAYS = 30;         // waarschuwen als een domein hierbinnen verloopt
const RETRY_DELAYS = [8000, 20000];  // wachttijd vóór de 2e en 3e poging binnen één ronde

const defaultResolver = () => new dns.Resolver({ timeout: 5000, tries: 2 });
export const defaultDeps = () => ({ resolver: defaultResolver(), fetch: globalThis.fetch, lookup: dns.lookup, retryDelays: RETRY_DELAYS });

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
//   dns      domeinnaam of record wijst nergens (meer) heen, of klopt niet
//   connect  server onbereikbaar of weigert de verbinding
//   timeout  verbinding wel gemaakt, maar geen antwoord binnen de tijd
//   cert     probleem met het SSL-certificaat
//   server   server antwoordt met een 5xx-fout
//   http     server antwoordt met een 4xx-fout
//   content  pagina laadt, maar de inhoud klopt niet
//   mail     MX-record ontbreekt, wijst naar de verkeerde provider of resolvet niet
//   domein   domein niet (actief) geregistreerd of zonder nameservers
const CERT_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_REVOKED", "CERT_UNTRUSTED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

// "Bestaat niet" bij een DNS-vraag, tegenover "DNS-server geeft geen antwoord".
const DNS_MISSING = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms))]);

// --- website -------------------------------------------------------------------

async function probeWebsite(monitor, deps) {
  const timeout = monitor.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = Date.now();
  try {
    const res = await deps.fetch(monitor.url, {
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

// Als een site geen HTTP-antwoord geeft, lopen we de stappen los na: DNS,
// verbinding met de server, SSL-certificaat. Zo zie je precies waar het vastloopt.

export function tcpConnect(host, port, ms) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, ms);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function peerCertificate(host, port, ip, verify) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: verify, timeout: 10000 }, () => {
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

async function diagnose(url, deps) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const https = u.protocol === "https:";
  const port = Number(u.port) || (https ? 443 : 80);

  let ip;
  try {
    const addrs = await withTimeout(deps.lookup(host, { all: true }), 10000);
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

export function certificateInfo(url) {
  return new Promise((resolve) => {
    let host, port;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return resolve(null);
      host = u.hostname;
      port = Number(u.port) || 443;
    } catch {
      return resolve(null);
    }
    const socket = tls.connect(
      { host, port, servername: net.isIP(host) ? undefined : host, timeout: 10000 },
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

async function checkWebsite(monitor, deps) {
  let result = await retry(() => probeWebsite(monitor, deps), deps);
  if (!result.ok && result.code === 0) {
    const found = await diagnose(monitor.url, deps).catch(() => null);
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
  const cert = result.ok ? await (deps.certificateInfo ?? certificateInfo)(monitor.url) : (result.cert ?? null);
  const warnings = [];
  if (cert && cert.daysLeft <= CERT_WARN_DAYS) {
    warnings.push({ key: "cert", text: cert.daysLeft < 0 ? `SSL-certificaat verlopen op ${cert.validTo}` : `SSL-certificaat verloopt over ${cert.daysLeft} dagen (${cert.validTo})` });
  }
  return { ...result, cert, warnings };
}

// --- DNS-hulpjes ------------------------------------------------------------------

const norm = (name) => String(name ?? "").trim().toLowerCase().replace(/\.$/, "");

// Eén DNS-vraag. Geeft { values } of { missing: true } of { error: code }.
async function ask(resolver, method, name) {
  try {
    const values = await resolver[method](name);
    return { values: values ?? [] };
  } catch (err) {
    if (DNS_MISSING.has(err?.code)) return { missing: true, code: err.code };
    return { error: err?.code ?? err?.message ?? "DNS-fout" };
  }
}

const txtValues = (records) => records.map((chunks) => [].concat(chunks).join(""));

// Tekst bij een DNS-fout die geen "bestaat niet" is.
const dnsError = (code) => ({
  ETIMEOUT: "DNS-server reageert niet", ESERVFAIL: "DNS-server geeft een fout (SERVFAIL)",
  ECONNREFUSED: "DNS-server weigert de vraag", EREFUSED: "DNS-server weigert de vraag",
})[code] ?? `DNS-fout`;

// --- mail -------------------------------------------------------------------------

export const MAIL_PROVIDERS = {
  microsoft365: {
    label: "Microsoft 365",
    // Klassiek *.mail.protection.outlook.com, nieuwer (met DNSSEC) *.mx.microsoft.
    mx: (host) => /\.mail\.protection\.outlook\.com$/.test(host) || /\.mx\.microsoft$/.test(host),
    mxText: "*.mail.protection.outlook.com",
    spf: "include:spf.protection.outlook.com",
    dkim: ["selector1", "selector2"],
    autodiscover: "autodiscover.outlook.com",
  },
  google: {
    label: "Google Workspace",
    mx: (host) => /(^|\.)google\.com$/.test(host) || /(^|\.)googlemail\.com$/.test(host),
    mxText: "*.google.com (aspmx)",
    spf: "include:_spf.google.com",
    dkim: ["google"],
  },
  overig: { label: "Overig" },
};

async function checkMail(monitor, deps) {
  const started = Date.now();
  const domain = norm(monitor.target);
  const provider = MAIL_PROVIDERS[monitor.provider] ? monitor.provider : "overig";
  const p = MAIL_PROVIDERS[provider];
  const r = deps.resolver;
  const checks = [];     // rijtje vinkjes voor het dashboard
  const warnings = [];
  let failure = null;    // eerste storing

  const fail = (category, reason) => { failure ??= { category, reason }; };

  // MX: moet bestaan en (bij een bekende provider) naar die provider wijzen.
  const mx = await ask(r, "resolveMx", domain);
  const mxHosts = (mx.values ?? []).slice().sort((a, b) => a.priority - b.priority).map((m) => norm(m.exchange));
  if (mx.error) {
    fail("dns", `MX-record van ${domain} niet op te vragen: ${dnsError(mx.error)} (${mx.error})`);
    checks.push({ key: "mx", label: "MX", ok: false, info: dnsError(mx.error) });
  } else if (!mxHosts.length) {
    fail("mail", `${domain} heeft geen MX-record: mail komt niet aan`);
    checks.push({ key: "mx", label: "MX", ok: false, info: "ontbreekt" });
  } else if (mxHosts.length === 1 && mxHosts[0] === "") {
    fail("mail", `${domain} ontvangt geen mail (null-MX-record)`);
    checks.push({ key: "mx", label: "MX", ok: false, info: "null-MX" });
  } else if (p.mx && !mxHosts.some(p.mx)) {
    fail("mail", `MX-record wijst niet naar ${p.label}: ${mxHosts.join(", ")} (verwacht ${p.mxText})`);
    checks.push({ key: "mx", label: "MX", ok: false, info: mxHosts.join(", ") });
  } else {
    // De mailserver uit het MX-record moet zelf ook een IP-adres hebben.
    const hosts = p.mx ? mxHosts.filter(p.mx) : mxHosts.filter(Boolean);
    const resolved = await Promise.all(hosts.map(async (host) => {
      const [a, aaaa] = await Promise.all([ask(r, "resolve4", host), ask(r, "resolve6", host)]);
      return { host, ok: !!(a.values?.length || aaaa.values?.length), error: a.error && aaaa.error ? a.error : null };
    }));
    const bad = resolved.filter((x) => !x.ok);
    if (bad.length === resolved.length) {
      const e = bad[0].error;
      fail(e ? "dns" : "mail", e
        ? `mailserver ${bad[0].host} niet op te zoeken: ${dnsError(e)} (${e})`
        : `mailserver ${bad.map((x) => x.host).join(", ")} heeft geen IP-adres (A/AAAA-record ontbreekt)`);
      checks.push({ key: "mx", label: "MX", ok: false, info: `${hosts.join(", ")} zonder IP-adres` });
    } else {
      if (bad.length) warnings.push({ key: "mx-host", text: `Mailserver ${bad.map((x) => x.host).join(", ")} heeft geen IP-adres` });
      checks.push({ key: "mx", label: "MX", ok: true, info: mxHosts.join(", ") });
    }
  }

  // SPF
  const txt = await ask(r, "resolveTxt", domain);
  const spf = txtValues(txt.values ?? []).filter((v) => /^v=spf1(\s|$)/i.test(v.trim()));
  if (txt.error) {
    checks.push({ key: "spf", label: "SPF", ok: false, info: dnsError(txt.error) });
    warnings.push({ key: "spf", text: `SPF niet op te vragen: ${dnsError(txt.error)}` });
  } else if (!spf.length) {
    checks.push({ key: "spf", label: "SPF", ok: false, info: "ontbreekt" });
    warnings.push({ key: "spf", text: "SPF-record ontbreekt: mail kan als spam worden gezien" });
  } else if (spf.length > 1) {
    checks.push({ key: "spf", label: "SPF", ok: false, info: `${spf.length} SPF-records` });
    warnings.push({ key: "spf", text: `${spf.length} SPF-records gevonden; er mag er maar één zijn` });
  } else if (p.spf && !spf[0].toLowerCase().split(/\s+/).includes(p.spf)) {
    checks.push({ key: "spf", label: "SPF", ok: false, info: spf[0] });
    warnings.push({ key: "spf", text: `SPF-record mist ${p.spf}` });
  } else {
    checks.push({ key: "spf", label: "SPF", ok: true, info: spf[0] });
  }

  // DKIM: bij Microsoft 365 twee CNAME's, bij Google een TXT. Andere selectors
  // kun je opgeven met "dkimSelectors".
  const selectors = [].concat(monitor.dkimSelectors ?? p.dkim ?? []);
  if (selectors.length) {
    const found = await Promise.all(selectors.map(async (sel) => {
      const name = `${sel}._domainkey.${domain}`;
      const cname = await ask(r, "resolveCname", name);
      if (cname.values?.length) return { sel, ok: true, value: norm(cname.values[0]) };
      const t = await ask(r, "resolveTxt", name);
      const v = txtValues(t.values ?? []).find((x) => /p=/i.test(x));
      return { sel, ok: !!v, value: v ? "TXT" : null };
    }));
    const missing = found.filter((f) => !f.ok).map((f) => f.sel);
    checks.push({ key: "dkim", label: "DKIM", ok: !missing.length, info: missing.length ? `ontbreekt: ${missing.join(", ")}` : found.map((f) => `${f.sel} → ${f.value}`).join(", ") });
    if (missing.length) warnings.push({ key: "dkim", text: `DKIM ontbreekt (${missing.map((s) => `${s}._domainkey`).join(", ")})` });
  }

  // DMARC
  const dmarcTxt = await ask(r, "resolveTxt", `_dmarc.${domain}`);
  const dmarc = txtValues(dmarcTxt.values ?? []).find((v) => /^v=DMARC1/i.test(v.trim()));
  if (dmarc) {
    const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? null;
    const valid = ["none", "quarantine", "reject"].includes(policy);
    checks.push({ key: "dmarc", label: "DMARC", ok: valid, info: valid ? `p=${policy}` : "geen geldig beleid", policy });
    if (!valid) warnings.push({ key: "dmarc", text: "DMARC-record heeft geen geldig beleid (p=none, quarantine of reject)" });
  } else {
    checks.push({ key: "dmarc", label: "DMARC", ok: false, info: dmarcTxt.error ? dnsError(dmarcTxt.error) : "ontbreekt" });
    warnings.push({ key: "dmarc", text: "DMARC-record ontbreekt (_dmarc)" });
  }

  // Autodiscover (alleen Microsoft 365): zorgt dat Outlook zichzelf instelt.
  if (p.autodiscover) {
    const ad = await ask(r, "resolveCname", `autodiscover.${domain}`);
    const target = ad.values?.length ? norm(ad.values[0]) : null;
    const ok = target === p.autodiscover;
    checks.push({ key: "autodiscover", label: "Autodiscover", ok, info: target ?? "ontbreekt" });
    if (!ok) warnings.push({ key: "autodiscover", text: target ? `Autodiscover wijst naar ${target} in plaats van ${p.autodiscover}` : `Autodiscover-CNAME ontbreekt (naar ${p.autodiscover})` });
  }

  const ms = Date.now() - started;
  const details = { provider, checks };
  if (failure) return { ok: false, code: 0, ms, ...failure, warnings, details };
  return { ok: true, code: 0, ms, reason: null, category: null, warnings, details };
}

// --- domein (RDAP) --------------------------------------------------------------------

// Statussen waarbij het domein niet (meer) werkt.
const BAD_STATUS = ["inactive", "redemption period", "pending delete", "client hold", "server hold", "quarantine", "pending restore"];

const rdapText = (status) => ({
  "inactive": "inactief", "redemption period": "in de herstelperiode (redemption)", "pending delete": "wordt verwijderd",
  "client hold": "geblokkeerd door de registrar (client hold)", "server hold": "geblokkeerd door het register (server hold)",
  "quarantine": "in quarantaine", "pending restore": "wordt hersteld",
})[status] ?? status;

async function checkDomain(monitor, deps) {
  const started = Date.now();
  const domain = norm(monitor.target);
  const warnings = [];
  let res, data;
  try {
    res = await deps.fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(monitor.timeoutMs ?? 20000),
      headers: { Accept: "application/rdap+json, application/json", "User-Agent": "uptime-monitor (github actions)" },
    });
    if (res.ok) data = await res.json();
  } catch {
    res = null;
  }
  const ms = Date.now() - started;

  if (res?.status === 404) {
    return { ok: false, code: 404, ms, category: "domein", reason: `${domain} is niet geregistreerd (volgens het register)`, warnings, details: { status: [], nameservers: [] } };
  }

  // Register niet bereikbaar: dan controleren we in elk geval de nameservers via DNS.
  if (!data) {
    const ns = await ask(deps.resolver, "resolveNs", domain);
    const nameservers = (ns.values ?? []).map(norm).sort();
    const details = { status: [], nameservers, source: "dns" };
    warnings.push({ key: "rdap", text: `Register (RDAP) niet bereikbaar${res ? ` (HTTP ${res.status})` : ""}; alleen de nameservers gecontroleerd` });
    if (nameservers.length) return { ok: true, code: 0, ms: Date.now() - started, reason: null, category: null, warnings, details };
    return {
      ok: false, code: 0, ms: Date.now() - started, category: ns.error ? "dns" : "domein",
      reason: ns.error ? `nameservers van ${domain} niet op te vragen: ${dnsError(ns.error)} (${ns.error})` : `${domain} heeft geen nameservers`,
      warnings, details,
    };
  }

  const status = (data.status ?? []).map((s) => String(s).toLowerCase());
  const nameservers = (data.nameservers ?? []).map((n) => norm(n.ldhName ?? n.unicodeName)).filter(Boolean).sort();
  const expiry = (data.events ?? []).find((e) => e.eventAction === "expiration")?.eventDate ?? null;
  const registrar = (data.entities ?? []).find((e) => (e.roles ?? []).includes("registrar"));
  const registrarName = registrar?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3] ?? null;
  const details = { status, nameservers, expires: expiry ? expiry.slice(0, 10) : null, registrar: registrarName, source: "rdap" };

  if (expiry) {
    const days = Math.floor((Date.parse(expiry) - Date.now()) / 86400000);
    if (days <= DOMAIN_WARN_DAYS) {
      warnings.push({ key: "expiry", text: days < 0 ? `Domein is verlopen op ${expiry.slice(0, 10)}` : `Domein verloopt over ${days} dagen (${expiry.slice(0, 10)})` });
    }
  }

  const bad = status.filter((s) => BAD_STATUS.includes(s));
  if (bad.length) {
    return { ok: false, code: 0, ms, category: "domein", reason: `${domain} is ${bad.map(rdapText).join(", ")}`, warnings, details };
  }
  if (!nameservers.length) {
    return { ok: false, code: 0, ms, category: "domein", reason: `${domain} heeft geen nameservers`, warnings, details };
  }
  return { ok: true, code: 0, ms, reason: null, category: null, warnings, details };
}

// --- dns-record --------------------------------------------------------------------------

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"];
const RESOLVE_METHOD = { A: "resolve4", AAAA: "resolve6", CNAME: "resolveCname", MX: "resolveMx", TXT: "resolveTxt" };

async function checkDns(monitor, deps) {
  const started = Date.now();
  const name = norm(monitor.target);
  const record = RECORD_TYPES.includes(String(monitor.record).toUpperCase()) ? String(monitor.record).toUpperCase() : "A";
  const answer = await ask(deps.resolver, RESOLVE_METHOD[record], name);
  const ms = Date.now() - started;
  const values = record === "MX" ? (answer.values ?? []).sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${norm(m.exchange)}`)
    : record === "TXT" ? txtValues(answer.values ?? [])
    : (answer.values ?? []).map(norm);
  const details = { record, values };

  if (answer.error) {
    return { ok: false, code: 0, ms, category: "dns", reason: `${record}-record van ${name} niet op te vragen: ${dnsError(answer.error)} (${answer.error})`, warnings: [], details };
  }
  if (!values.length) {
    return { ok: false, code: 0, ms, category: "dns", reason: `${record}-record van ${name} bestaat niet`, warnings: [], details };
  }
  if (monitor.expect) {
    const want = norm(monitor.expect);
    if (!values.some((v) => v.toLowerCase().includes(want))) {
      return { ok: false, code: 0, ms, category: "dns", reason: `${record}-record van ${name} is ${values.join(", ")} (verwacht ${monitor.expect})`, warnings: [], details };
    }
  }
  return { ok: true, code: 0, ms, reason: null, category: null, warnings: [], details };
}

// --- poort (TCP) ------------------------------------------------------------------------

// "host:poort", "[ipv6]:poort", of host met een los veld "port".
export function parseHostPort(target, port) {
  const s = String(target ?? "").trim();
  let m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2] ?? port) };
  m = /^([^:]+):(\d+)$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: s, port: Number(port) };
}

async function checkPort(monitor, deps) {
  const { host, port } = parseHostPort(monitor.target, monitor.port);
  const timeout = monitor.timeoutMs ?? 10000;
  const details = { host, port };
  if (!host || !(port >= 1 && port <= 65535)) {
    return { ok: false, code: 0, ms: 0, category: "connect", reason: `ongeldige host of poort (${monitor.target})`, warnings: [], details };
  }

  let ip = host;
  if (!net.isIP(host)) {
    try {
      const addrs = await withTimeout(deps.lookup(host, { all: true }), 10000);
      ip = addrs.find((a) => a.family === 4)?.address ?? addrs[0]?.address;
      if (!ip) throw Object.assign(new Error("geen adres"), { code: "ENODATA" });
    } catch (err) {
      const why = err.code === "ENOTFOUND" ? `${host} bestaat niet of heeft geen IP-adres`
        : err.code === "ENODATA" ? `${host} heeft geen IP-adres`
        : `DNS-server geeft geen antwoord voor ${host}`;
      return { ok: false, code: 0, ms: 0, category: "dns", reason: `DNS: ${why} (${err.code})`, warnings: [], details };
    }
  }
  details.ip = ip;

  const started = Date.now();
  try {
    await tcpConnect(ip, port, timeout);
    return { ok: true, code: 0, ms: Date.now() - started, reason: null, category: null, ip, warnings: [], details };
  } catch (err) {
    const ms = Date.now() - started;
    if (err.code === "ETIMEDOUT") {
      return { ok: false, code: 0, ms, category: "timeout", reason: `geen verbinding met ${host}:${port} binnen ${timeout / 1000}s (poort dicht of gefilterd)`, ip, warnings: [], details };
    }
    const why = err.code === "ECONNREFUSED" ? "server weigert de verbinding (poort dicht)"
      : err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH" ? "server onbereikbaar"
      : "verbinding mislukt";
    return { ok: false, code: 0, ms, category: "connect", reason: `${why} op ${ip}:${port} (${err.code})`, ip, warnings: [], details };
  }
}

// --- alles bij elkaar ------------------------------------------------------------------

// Een paar keer opnieuw proberen voordat we een ronde als mislukt tellen —
// scheelt loze meldingen bij een hikje in het netwerk of een herstartende server.
async function retry(attempt, deps) {
  let result = await attempt();
  for (const delay of deps.retryDelays ?? RETRY_DELAYS) {
    if (result.ok) return result;
    await sleep(delay);
    const next = await attempt();
    result = next.ok ? { ...next, flaky: true } : next;
  }
  return result;
}

const CHECKS = { mail: checkMail, domein: checkDomain, dns: checkDns, poort: checkPort };

export async function runCheck(monitor, deps = defaultDeps()) {
  const type = typeOf(monitor);
  const result = type === "website"
    ? await checkWebsite(monitor, deps)
    : await retry(() => CHECKS[type](monitor, deps).catch((err) => ({ ok: false, code: 0, ms: 0, category: "connect", reason: `test mislukt: ${err?.message ?? err}`, warnings: [] })), deps);
  return { warnings: [], details: null, ...result, type };
}
