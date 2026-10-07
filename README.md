# raw_logs_decoder

A simple web application to decode, export, and analyze raw logs from OpenCollar Edge devices.

## Run locally

### Requirements
- A modern web browser (Chrome, Edge, Firefox, or Safari).
- Python 3 (used only to serve static files locally).
- Internet access (the app loads some libraries from CDN and uses OpenStreetMap tiles for map view).

### Start the app (WSL / Linux / macOS)
From this repository directory:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

### Start the app (Windows PowerShell, optional)
If Python is installed on Windows:

```powershell
py -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Notes
- Use a local HTTP server instead of opening `index.html` directly. The app fetches local files like `version.txt` and `field-meta.json`, which should be served over HTTP.
- To stop the local server, press `Ctrl+C` in the terminal.

## GNSS performance

After decoding a log, open **GNSS Performance (u-blox)** to view hourly fix attempts and success rates, time to fix, retries, and fix quality. Choose UTC or browser local time, optionally restrict the date range, and export the hourly table as CSV or the fix chart as PNG.

The analysis counts full port-2 u-blox records, including those inside port-29 flash logs. It uses the reported success flag (1 = success, 0 = failure); other outcomes remain unknown. Short location and resend messages are excluded. Failed attempts with zero coordinates are retained. Flash-log timestamps take priority over payload fix timestamps. Untimed records contribute to unfiltered summary totals but cannot be grouped by hour or included in a date range.

Hours combine the selected days, with success rates calculated from total successful and failed records. Time-to-fix and quality metrics use successful fixes with the corresponding field present; retry averages use all records with that counter present.

Run the GNSS calculation and decoder integration tests with Node.js:

```bash
node --test tests/gnss-analysis.test.js
```
