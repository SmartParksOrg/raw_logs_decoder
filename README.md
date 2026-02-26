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
