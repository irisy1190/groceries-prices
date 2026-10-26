#!/bin/bash
# Groceries – one-time Mac setup for Victory and Super-Pharm prices.
# Run it in Terminal with:
#   bash <(curl -fsSL https://raw.githubusercontent.com/irisy1190/groceries-prices/main/prices/setup-mac-prices.sh)
# It only creates the folder ~/GroceriesPrices and one daily schedule (com.groceries.prices).

set -e
REPO="irisy1190/groceries-prices"
RAW="https://raw.githubusercontent.com/$REPO/main/prices"
DIR="$HOME/GroceriesPrices"
FILES="update_prices.py upload_to_github.py mac-stores.json setup-mac-prices.sh"

echo ""
echo "== Groceries prices – Mac setup =="
echo ""

mkdir -p "$DIR/prices" "$DIR/logs"
cd "$DIR"

echo "1/5  Downloading the price scripts from your GitHub project…"
for f in $FILES; do
  curl -fsSL "$RAW/$f" -o "prices/$f"
done

echo "2/5  Setting up Python and the price tool (can take a few minutes)…"
if ! /usr/bin/python3 -c 'import sys; assert sys.version_info >= (3, 9)' 2>/dev/null; then
  echo "     Python 3 isn't ready on this Mac. Run:  xcode-select --install   then run this setup again."
  exit 1
fi
[ -d venv ] || /usr/bin/python3 -m venv venv
./venv/bin/python -m pip install --quiet --upgrade pip
./venv/bin/python -m pip install --quiet il-supermarket-scraper lxml
./venv/bin/python -m playwright install chromium >/dev/null 2>&1 || echo "     (browser part skipped – usually not needed)"

echo "3/5  Saving your GitHub key in the Mac's Keychain…"
if security find-generic-password -s groceries-github -w >/dev/null 2>&1 && [ "$1" != "--new-key" ]; then
  echo "     A key is already saved. (To replace it, run this setup again with:  --new-key)"
else
  printf "     Paste your GitHub key and press Enter (nothing shows while you paste): "
  read -r -s TOKEN
  echo ""
  security add-generic-password -a "$USER" -s groceries-github -w "$TOKEN" -U
  unset TOKEN
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $(security find-generic-password -s groceries-github -w)" \
  "https://api.github.com/repos/$REPO")
if [ "$CODE" != "200" ]; then
  echo "     GitHub didn't accept the key (code $CODE). Check it, then run:  bash ~/GroceriesPrices/prices/setup-mac-prices.sh --new-key"
  exit 1
fi
echo "     Key works."

echo "4/5  Creating the daily run (every morning at 10:15, or when the Mac wakes up after that)…"
cat > run-prices.sh <<'RUN'
#!/bin/bash
DIR="$HOME/GroceriesPrices"
cd "$DIR" || exit 1
RAW="https://raw.githubusercontent.com/irisy1190/groceries-prices/main/prices"
{
  echo ""
  echo "===== $(date) ====="
  # Get the latest version of the scripts (keeps the old one if there's no internet).
  for f in update_prices.py upload_to_github.py mac-stores.json; do
    curl -fsSL "$RAW/$f" -o "prices/$f.new" && mv "prices/$f.new" "prices/$f"
  done
  rm -rf "$DIR/dumps" "$DIR/site"
  export GH_TOKEN="$(security find-generic-password -s groceries-github -w 2>/dev/null)"
  STORES_FILE="$DIR/prices/mac-stores.json" ./venv/bin/python prices/update_prices.py
  ./venv/bin/python prices/upload_to_github.py
} >> "$DIR/logs/run.log" 2>&1
tail -n 3000 "$DIR/logs/run.log" > "$DIR/logs/run.tmp" && mv "$DIR/logs/run.tmp" "$DIR/logs/run.log"
RUN
chmod +x run-prices.sh

PLIST="$HOME/Library/LaunchAgents/com.groceries.prices.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.groceries.prices</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/run-prices.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$DIR/logs/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/logs/launchd.log</string>
</dict>
</plist>
PLIST_END
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "     Scheduled."

echo "5/5  Running it once now as a test (a few minutes)…"
./run-prices.sh || true
echo ""
grep -E "^=====|products|branch:|FAILED|Upload|Started|Nothing new|key" logs/run.log | tail -n 12 || true
echo ""
echo "Done. Full details are in:  ~/GroceriesPrices/logs/run.log"
echo "To stop the daily run later:  launchctl bootout gui/\$(id -u) ~/Library/LaunchAgents/com.groceries.prices.plist"
echo ""
