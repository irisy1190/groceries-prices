name: Update prices

on:
  schedule:
    - cron: "47 7 * * *"   # every day around 09:47–10:47 Israel time (Victory publishes after ~9:00)
  workflow_dispatch:         # lets you run it by hand from the Actions tab

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: prices
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install the price downloader
        run: |
          python -m pip install --upgrade pip
          python -m pip install il-supermarket-scraper lxml
          python -m playwright install --with-deps chromium || true

      - name: Download today's prices
        env:
          PAGES_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/
        run: python prices/update_prices.py

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: site

      - id: deployment
        uses: actions/deploy-pages@v4
