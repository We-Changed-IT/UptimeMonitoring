# Uptime-monitor via GitHub Actions

Controleert je websites elke paar minuten vanaf GitHub's servers, houdt een
geschiedenis bij, toont een statuspagina en waarschuwt je per Telegram en e-mail
zodra er iets omvalt.

Wat er per site gecontroleerd wordt:

- of de site antwoordt, en met welke HTTP-status
- hoe snel (bij trage reacties kleurt de pagina oranje, dat is geen storing)
- of er geen foutmelding in de pagina staat terwijl de status wel 200 is — zo vang
  je een WordPress- of Concrete-site die "draait" maar een Fatal error toont
- hoe lang het SSL-certificaat nog geldig is, met een waarschuwing vanaf 14 dagen

Elke 5 minuten is er een controleronde. Binnen een ronde krijgt een site drie
pogingen (na 8 en na 20 seconden opnieuw). Pas als hij **twee rondes achter
elkaar** faalt, komt er een melding — een kort hikje van de server of van
GitHub's netwerk levert dus geen loos alarm meer op. Meldingen komen alleen bij
een *verandering*: één bericht als de site omvalt, één als hij terug is.

Op de statuspagina zie je per site:

- een balk per dag (45 dagen) en het uptimepercentage over 24 uur, 7 en 30 dagen
- een lijntje met de responstijd van de laatste 24 uur, met rode streepjes op
  mislukte metingen (beweeg eroverheen voor de oorzaak)
- de laatste vijf storingen met begin, duur en oorzaak, in gewone taal
  ("SSL-certificaat ongeldig", "domein niet gevonden") in plaats van foutcodes

## Opzetten

**1. Repository aanmaken**

Maak op GitHub een nieuwe repository, bijvoorbeeld `uptime`, en zet hem op
**Public**. Dat is belangrijk: op publieke repositories zijn Actions-minuten en
GitHub Pages gratis, op private niet. Er staat niets gevoeligs in — alleen de
adressen van je eigen websites.

Upload de inhoud van deze map naar de repository (drag-and-drop via de knop
"Add file" werkt, of met git).

**2. Je sites invullen**

In `monitors.json` staan BPCF, Overlast van wespen en Je Grote Dag al klaar.
Controleer of de URL's kloppen (mét of zónder `www`, precies zoals je site
draait) en voeg de rest toe:

```json
{
  "name": "Testverhuur",
  "url": "https://www.voorbeeld.nl/",
  "mustContain": "Offerte aanvragen",
  "mustNotContain": ["Fatal error"],
  "slowMs": 4000
}
```

`mustContain` is nuttig om te bewaken dat een belangrijk element nog bestaat,
bijvoorbeeld je contactformulier of offerteknop. Laat weg wat je niet nodig hebt.

Nog een paar opties per site:

| Optie | Wat het doet |
|---|---|
| `"paused": true` | Site tijdelijk overslaan, bijvoorbeeld tijdens onderhoud of een verhuizing. Geen metingen, geen meldingen. |
| `"confirmRounds": 1` | Meteen melden bij de eerste mislukte ronde in plaats van na twee. Kan ook bovenin `monitors.json` voor alle sites tegelijk. |
| `"expectStatus": [200, 299]` | Welke HTTP-statuscodes als goed tellen (standaard 200 t/m 399). |
| `"timeoutMs": 20000` | Hoe lang op een antwoord wachten (standaard 15 seconden). |

Na het opzetten hoef je dit bestand niet meer met de hand aan te passen: gebruik
daarvoor de beheerpagina (zie hieronder).

**3. Statuspagina aanzetten**

Settings → Pages → Source: *Deploy from a branch*, branch `main`, map `/docs`.
Na een minuut staat je overzicht op `https://<gebruikersnaam>.github.io/uptime/`.

**Inloggen en privé gegevens.** De statuspagina en de beheerpagina vragen om
een GitHub-token. De gegevens (sitelijst, status, storingen) horen in een
aparte **privé** repository `UptimeData`, zodat niemand ze zonder login kan
inzien. Eenmalig instellen:

1. Maak op GitHub een lege, **private** repository `UptimeData` (zonder README).
2. Maak een fine-grained token met alleen toegang tot `UptimeData` en
   *Contents: Read and write*. Zet het in deze repository als secret
   `DATA_TOKEN`.
3. Geef je eigen inlogtoken toegang tot `UptimeData` én `UptimeMonitoring`.

Bij de eerste run daarna verhuizen de gegevens automatisch en verdwijnen ze uit
deze openbare repository. Zonder `DATA_TOKEN` blijft alles hier staan.

**Klanten en eigen sites.** Geef per site aan of het een klantsite of een eigen
site is (`"group": "klant"` of `"eigen"`) en bij klanten de naam (`"client"`).
Het dashboard groepeert daarop en kan filteren op klanten of eigen sites.

**Oorzaak van een storing.** Lukt een controle niet, dan zoekt de monitor uit
waar het misgaat: DNS, verbinding met de server, SSL-certificaat, een fout van
de server (5xx/4xx) of verkeerde inhoud. Dat staat als label en uitleg bij de
storing.

**Beheerpagina.** Op `https://<gebruikersnaam>.github.io/uptime/beheer.html`
voeg je sites toe, pas je ze aan, pauzeer je ze of haal je ze weg. Elke
wijziging wordt een commit op `monitors.json` en is binnen 5 minuten actief.

Inloggen gaat met een GitHub-token dat alleen in je eigen browser bewaard wordt:
Settings → Developer settings → Personal access tokens → *Fine-grained tokens*,
alleen deze repository, en onder Repository permissions *Contents: Read and
write*. Zonder zo'n token kan niemand iets aanpassen, ook al is de pagina
openbaar.

**4. Telegram-meldingen**

1. Zoek in Telegram op **@BotFather**, stuur `/newbot` en verzin een naam. Je
   krijgt een token terug (lange string met een dubbele punt erin).
2. Stuur je nieuwe bot zelf een berichtje (anders mag hij jou niets sturen).
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in je browser en zoek
   het getal achter `"chat":{"id":`. Dat is je chat-id.
4. In de repository: Settings → Secrets and variables → Actions → New repository
   secret. Voeg toe: `TELEGRAM_BOT_TOKEN` en `TELEGRAM_CHAT_ID`.

Wil je de meldingen ook bij een collega laten binnenkomen: maak een Telegram-groep,
zet de bot erin, en gebruik het groeps-id (begint met een min-teken).

**5. E-mailmeldingen**

Voeg deze secrets toe met de SMTP-gegevens van je eigen mailhosting:

| Secret | Voorbeeld |
|---|---|
| `MAIL_HOST` | `smtp.jouwhosting.nl` |
| `MAIL_PORT` | `465` |
| `MAIL_USER` | `monitor@bpcf.nl` |
| `MAIL_PASS` | wachtwoord van dat mailadres |
| `MAIL_TO` | `info@bpcf.nl` (meerdere adressen scheiden met een komma) |

Poort 465 gebruikt SSL, elke andere poort (meestal 587) STARTTLS. De mail gaat
rechtstreeks via `curl` de deur uit, er is geen extra action voor nodig.

Gebruik bij voorkeur een apart mailadres, geen adres waar je zelf op werkt.
Bij Gmail werkt dit alleen met een app-wachtwoord, niet met je gewone wachtwoord.

Wil je geen SMTP instellen: laat de mailstap staan zonder secrets (hij slaat
zichzelf dan over) en zet in plaats daarvan Watch → Custom → Actions aan op de
repository. GitHub mailt je dan bij een mislukte workflow. Minder precies, maar
nul configuratie.

**6. Proefdraaien**

Tabblad Actions → *Uptime check* → *Run workflow*. Laat "duur" op 0 voor één
controleronde. De eerste run maakt `docs/status.json` aan en vult de
statuspagina.

Loopt er al een geplande run, dan wacht je handmatige run tot die klaar is
(hooguit een paar uur). Wil je direct zien wat er gebeurt: open de lopende run
onder Actions, daar staat elke ronde in het log.

## Waar je rekening mee moet houden

**Hoe de 5 minuten gehaald worden.** GitHub start geplande workflows wanneer er
capaciteit is; bij deze repository kwam dat neer op één run per 2 tot 5 uur.
Daarom start de workflow nu elk uur en blijft elke run zelf 5,5 uur lang
doorlopen met een ronde per 5 minuten. Zodra een run klaar is, staat de
volgende al in de wachtrij, dus er zit hooguit een kort gat tussen. Op een
publieke repository kost dat niets. Heb je alarm binnen een minuut nodig, dan
is een betaalde dienst de juiste keuze.

**Geplande workflows vallen stil bij een slapende repository.** GitHub schakelt de
cron uit na 60 dagen zonder activiteit. Deze monitor commit elke run zijn
resultaten, wat als activiteit telt, maar GitHub stuurt je sowieso een mail
voordat hij iets uitzet — één klik en hij loopt weer.

**Elke ronde maakt een commit.** Bij 5 minuten zijn dat een paar duizend commits
per maand. Dat is normaal voor dit soort monitors en kost je niets, maar je
commitgeschiedenis wordt er wel onleesbaar van. Zet `INTERVAL_SECONDS` in
`.github/workflows/uptime.yml` op `900` als je liever elke 15 minuten meet.

**Het controleert bereikbaarheid, niet correctheid.** Een site die een verkeerd
telefoonnummer toont of waarvan het contactformulier geen mail verstuurt, ziet
deze monitor als gezond. Voor het formulier zelf blijft een testaanvraag per
maand de enige echte controle.
