#!/usr/bin/env bash
# Draait de controle in rondes van INTERVAL_SECONDS, net zo lang als
# DURATION_MINUTES aangeeft. Na elke ronde: resultaten committen en zo nodig
# een mail versturen. Zo hangt de meetfrequentie niet meer af van hoe vaak
# GitHub de geplande workflow wil starten.
set -uo pipefail

INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"
DURATION_MINUTES="${DURATION_MINUTES:-0}"
deadline=$(( $(date +%s) + DURATION_MINUTES * 60 ))

git config --global user.name "uptime-bot"
git config --global user.email "uptime-bot@users.noreply.github.com"

# --- waar staan de gegevens? ------------------------------------------------
# Met DATA_TOKEN staan sitelijst, status en storingen in een privé repository
# (DATA_REPO), zodat niemand ze kan inzien zonder in te loggen. Zonder
# DATA_TOKEN blijft alles in deze (openbare) repository, zoals voorheen.
DATA_DIR="."
if [ -n "${DATA_TOKEN:-}" ]; then
  DATA_REPO="${DATA_REPO:-${GITHUB_REPOSITORY_OWNER:-Derkvg158}/UptimeData}"
  rm -rf data
  DATA_URL="${DATA_URL:-https://x-access-token:${DATA_TOKEN}@github.com/${DATA_REPO}.git}"
  if ! git clone -q --depth 1 "$DATA_URL" data 2>/dev/null; then
    echo "::error::Kan ${DATA_REPO} niet ophalen. Bestaat de repository en mag DATA_TOKEN erin schrijven?"
    exit 1
  fi
  DATA_DIR="data"

  # Eerste keer: bestaande gegevens verhuizen naar de privé repository en
  # daarna uit de openbare repository halen.
  if [ ! -f data/monitors.json ]; then
    echo "Gegevens verhuizen naar ${DATA_REPO}"
    mkdir -p data/docs
    cp monitors.json data/
    [ -f docs/status.json ] && cp docs/status.json data/docs/
    [ -d docs/history ] && cp -r docs/history data/docs/
    git -C data add -A
    git -C data commit -q -m "Gegevens overgezet uit de openbare repository"
    git -C data push -q origin HEAD:main || { echo "::error::Push naar ${DATA_REPO} mislukt"; exit 1; }
    git rm -q -r --ignore-unmatch monitors.json docs/status.json docs/history
    git commit -q -m "Gegevens verhuisd naar privé repository" || true
    git pull -q --rebase origin main && git push -q origin HEAD:main || echo "::warning::Opruimen openbare repository mislukt"
  fi
fi
export DATA_DIR

commit_results() {
  local dir="$DATA_DIR"
  git -C "$dir" add docs/
  if git -C "$dir" diff --quiet --staged; then
    # Niets te committen, maar wel wijzigingen van de beheerpagina ophalen.
    git -C "$dir" pull -q --rebase origin main || true
    return 0
  fi
  git -C "$dir" commit -q -m "status $(date -u +'%Y-%m-%d %H:%M')"
  for attempt in 1 2 3; do
    git -C "$dir" pull -q --rebase -X theirs origin main && git -C "$dir" push -q origin HEAD:main && return 0
    sleep $(( attempt * 5 ))
  done
  echo "::warning::Resultaten konden niet gepusht worden"
}

# GitHub zet geplande workflows uit na 60 dagen zonder activiteit in de
# repository. Staan de gegevens elders, dan houden we hem met een wekelijkse
# hartslag-commit wakker.
heartbeat() {
  [ "$DATA_DIR" = "." ] && return 0
  local last
  last=$(cat docs/heartbeat.txt 2>/dev/null || echo 0)
  [ $(( $(date +%s) - last )) -lt 604800 ] && return 0
  date +%s > docs/heartbeat.txt
  git add docs/heartbeat.txt
  git commit -q -m "hartslag" && { git pull -q --rebase origin main && git push -q origin HEAD:main || true; }
}

send_mail() {
  [ -f alert.txt ] || return 0
  if [ -z "${MAIL_HOST:-}" ] || [ -z "${MAIL_TO:-}" ]; then
    rm -f alert.txt
    return 0
  fi
  local port="${MAIL_PORT:-465}" scheme="smtps" extra=()
  if [ "$port" != "465" ]; then scheme="smtp"; extra=(--ssl-reqd); fi
  local subject
  subject="=?UTF-8?B?$(head -n 1 alert.txt | base64 -w0)?="
  {
    echo "From: Uptime monitor <${MAIL_USER}>"
    echo "To: ${MAIL_TO}"
    echo "Subject: ${subject}"
    echo "Date: $(date -R)"
    echo "MIME-Version: 1.0"
    echo "Content-Type: text/plain; charset=UTF-8"
    echo "Content-Transfer-Encoding: 8bit"
    echo
    tail -n +3 alert.txt
  } > mail.eml
  # MAIL_TO mag meerdere adressen bevatten, gescheiden door komma's.
  local rcpts=()
  IFS=',' read -ra addrs <<< "$MAIL_TO"
  for a in "${addrs[@]}"; do rcpts+=(--mail-rcpt "$(echo "$a" | xargs)"); done
  curl -sS --max-time 30 "${extra[@]}" \
    --url "${scheme}://${MAIL_HOST}:${port}" \
    --user "${MAIL_USER}:${MAIL_PASS}" \
    --mail-from "${MAIL_USER}" "${rcpts[@]}" \
    --upload-file mail.eml \
    || echo "::warning::E-mail versturen mislukt"
  rm -f alert.txt mail.eml
}

while true; do
  started=$(date +%s)
  node scripts/check.mjs || echo "::warning::Controle-script faalde"
  commit_results
  send_mail
  heartbeat

  next=$(( started + INTERVAL_SECONDS ))
  [ "$next" -ge "$deadline" ] && break
  sleep $(( next - $(date +%s) > 0 ? next - $(date +%s) : 0 ))
done
