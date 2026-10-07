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

After decoding a log, open **GNSS Performance (u-blox)** to view hourly fix attempts and success rates, time to fix, retries, and fix quality. Choose UTC or browser local time and use the dual-handle time slider to select a range. Like the other sections, releasing a handle zooms the time scale to the selected records; **Scale** restores the full scale while keeping the selection, and **Range** restores all records. Export the hourly table as CSV or the fix chart as PNG.

The analysis counts full port-2 u-blox records, including those inside port-29 flash logs. It uses the reported success flag (1 = success, 0 = failure); other outcomes remain unknown. Short location and resend messages are excluded. Failed attempts with zero coordinates are retained. Flash-log timestamps take priority over payload fix timestamps. Untimed records contribute to unfiltered summary totals but cannot be grouped by hour or included in a date range.

Hours combine the selected days, with success rates calculated from total successful and failed records. Time-to-fix and quality metrics use successful fixes with the corresponding field present; retry averages use all records with that counter present.

### Short failed attempts / likely early stops

Set the **Hot fix timeout**, **Cold fix timeout**, and **Short failed attempt** limit to match the period being analyzed. The initial hot/cold values of 65/200 seconds come from the [public firmware defaults](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/blob/main/app/src/settings/generated_settings/settings_def.c); they are not recovered from your log. The initial short-failure threshold is an analysis assumption of 35 seconds (the default 30-second satellite check plus a 5-second allowance). Clear an unknown timeout to avoid relying on a default.

A likely early stop is a failed record with a positive TTF no greater than the short-failure limit and at least 5 seconds below its reference timeout. Mode is inferred from failed retry counters: a positive cold counter takes priority, otherwise a positive hot counter indicates hot acquisition. When mode is unknown, the duration must be below both supplied timeouts. Short failures without the required timeout are shown as unconfirmed. Successful records, missing/zero TTF, and active-tracking records are never flagged as early stops. Numeric, boolean, and text TRUE/FALSE success flags are supported.

These are inferred early exits, not confirmed satellite-check aborts. The [acquisition code](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/blob/main/app/src/gps_ublox/gps.c) checks a separate detected-satellite count and reports zero TTF during active tracking. The [GNSS driver](https://github.com/SmartParksOrg/smartparks-opencollar-edge-fw-public/blob/main/app/src/gps_ublox/gps_ublox.cpp) returns the number of satellites used in the fix as SIV, so SIV=0 is supporting context rather than proof of too few detected satellites.

Likely early stops appear as an orange subset of failed attempts in the hourly chart without changing the overall success rate. The **Failed attempt analysis** table shows duration, SIV, inferred mode, reference timeout, retry counters, and the reason for each assessment. Filter this table by assessment and export its visible rows. Both hourly and failure CSVs include the analysis settings. All results follow the existing time slider.

Run the GNSS calculation and decoder integration tests with Node.js:

```bash
node --test tests/gnss-analysis.test.js
```
