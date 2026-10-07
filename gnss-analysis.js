(function(root){
  'use strict';

  function numeric(value){
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    if(typeof value === 'string' && !value.trim()) return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  function collectAttempts(messageRows){
    return messageRows.filter(row => String(row.port) === '2').map(row => {
      const data = row.dataObj || {};
      const success = numeric(data.success);
      // Flash-log timestamps describe the recorded attempt, even when a failed
      // fix has an absent, zero, or stale fix_timestamp in its payload.
      let timestampMs = Date.parse(row.timestamp_utc || '');
      if(!Number.isFinite(timestampMs) || timestampMs <= 0){
        const seconds = numeric(data.fix_timestamp ?? data.fix_time ?? data.timestamp);
        timestampMs = seconds != null && seconds > 0 ? seconds * 1000 : NaN;
      }
      return {
        timestampMs: Number.isFinite(timestampMs) && Number.isFinite(new Date(timestampMs).getTime()) ? timestampMs : null,
        outcome: success === 1 ? 'success' : success === 0 ? 'failed' : 'unknown',
        ttf: numeric(data.ttf),
        hotRetry: numeric(data.hot_retry),
        coldRetry: numeric(data.cold_retry),
        satellites: numeric(data.SIV),
        accuracy: numeric(data.h_acc_est)
      };
    });
  }

  function parseRangeBound(value, timezone, end=false){
    if(!value) return null;
    const time = Date.parse(timezone === 'utc' ? `${value}Z` : value);
    // datetime-local controls have second precision; include the entire end second.
    return Number.isFinite(time) ? time + (end ? 999 : 0) : NaN;
  }

  function filterAttempts(attempts, start, end){
    if(start == null && end == null) return attempts;
    return attempts.filter(row => row.timestampMs != null &&
      (start == null || row.timestampMs >= start) && (end == null || row.timestampMs <= end));
  }

  function summarizeAttempts(rows){
    const successful = rows.filter(row => row.outcome === 'success');
    const failed = rows.filter(row => row.outcome === 'failed').length;
    const known = successful.length + failed;
    const ttf = successful.map(row => row.ttf).filter(Number.isFinite).sort((a,b) => a - b);
    const mean = (items, field) => {
      const values = items.map(row => row[field]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return {
      attempts: rows.length,
      successful: successful.length,
      failed,
      unknown: rows.length - known,
      successRate: known ? successful.length / known * 100 : null,
      ttfSamples: ttf.length,
      meanTtf: mean(successful, 'ttf'),
      p90Ttf: ttf.length ? ttf[Math.ceil(ttf.length * 0.9) - 1] : null,
      meanHotRetry: mean(rows, 'hotRetry'),
      meanColdRetry: mean(rows, 'coldRetry'),
      meanSatellites: mean(successful, 'satellites'),
      meanAccuracy: mean(successful, 'accuracy')
    };
  }

  function aggregateHourly(attempts, timezone='utc'){
    const buckets = Array.from({ length:24 }, () => []);
    attempts.forEach(row => {
      if(row.timestampMs == null) return;
      const date = new Date(row.timestampMs);
      const hour = timezone === 'utc' ? date.getUTCHours() : date.getHours();
      buckets[hour].push(row);
    });
    return buckets.map((rows, hour) => ({ hour, ...summarizeAttempts(rows) }));
  }

  const state = { source:null, attempts:[], charts:[], table:null, hourly:[], fileName:'decoded', bound:false };
  const byId = id => document.getElementById(id);
  const format = (value, suffix='') => Number.isFinite(value)
    ? `${Number(value.toFixed(1)).toLocaleString()}${suffix}` : '—';

  function destroyViews(){
    state.charts.forEach(chart => chart.destroy());
    state.charts = [];
    if(state.table) state.table.destroy();
    state.table = null;
    state.hourly = [];
    byId('gnssCharts').replaceChildren();
    byId('gnssTable').replaceChildren();
    byId('gnssExportCsv').disabled = true;
    byId('gnssExportPng').disabled = true;
  }

  function reset(){
    destroyViews();
    state.source = null;
    state.attempts = [];
    byId('gnssStart').value = '';
    byId('gnssEnd').value = '';
    byId('gnssSummary').replaceChildren();
    byId('gnssCoverage').textContent = '';
    byId('gnssPanel').style.display = 'none';
    byId('gnssPlaceholder').style.display = '';
  }

  function renderSummary(rows){
    const summary = summarizeAttempts(rows);
    const tiles = [
      ['Reported attempts', summary.attempts, 'full u-blox records'],
      ['Successful fixes', summary.successful, 'success = 1'],
      ['Failed fixes', summary.failed, 'success = 0'],
      ['Fix success rate', format(summary.successRate, '%'), 'successful / known outcomes'],
      ['Unknown outcomes', summary.unknown, 'excluded from success rate'],
      ['Mean time to fix', format(summary.meanTtf, ' s'), `${summary.ttfSamples} successful fixes with TTF`],
      ['P90 time to fix', format(summary.p90Ttf, ' s'), 'successful fixes; nearest-rank percentile'],
      ['Mean hot / cold retries', `${format(summary.meanHotRetry)} / ${format(summary.meanColdRetry)}`, 'per record with a reported counter'],
      ['Mean satellites', format(summary.meanSatellites), 'successful fixes with SIV'],
      ['Mean accuracy estimate', format(summary.meanAccuracy, ' m'), 'successful fixes; horizontal estimate']
    ];
    const holder = byId('gnssSummary');
    holder.replaceChildren();
    tiles.forEach(([label, value, sub]) => {
      const tile = document.createElement('div');
      tile.className = 'metric-tile';
      [['metric-label', label], ['metric-value', value], ['metric-sub', sub]].forEach(([className, text]) => {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text;
        tile.appendChild(element);
      });
      holder.appendChild(tile);
    });
  }

  function makeChart(title, datasets, scales, timezone){
    const panel = document.createElement('div');
    panel.className = 'dashboard-panel';
    const wrapper = document.createElement('div');
    wrapper.className = 'dashboard-chart';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', title + '. Values are available in the hourly table below.');
    wrapper.appendChild(canvas);
    panel.appendChild(wrapper);
    byId('gnssCharts').appendChild(panel);
    const theme = getComputedStyle(document.documentElement);
    const color = theme.getPropertyValue('--text').trim() || '#16202c';
    const background = theme.getPropertyValue('--panel').trim() || '#ffffff';
    const chart = new Chart(canvas.getContext('2d'), {
      type:'bar',
      data:{ labels:state.hourly.map(row => row.hour), datasets },
      plugins:[{
        id:'gnssBackground',
        beforeLayout(chart){
          // Wrap long headings when the panel is resized down to a phone width.
          const ctx = chart.ctx;
          ctx.save();
          ctx.font = 'bold 16px Arial';
          const lines = [''];
          title.split(' ').forEach(word => {
            const last = lines.length - 1;
            const candidate = lines[last] ? `${lines[last]} ${word}` : word;
            if(lines[last] && ctx.measureText(candidate).width > chart.width - 32) lines.push(word);
            else lines[last] = candidate;
          });
          chart.options.plugins.title.text = lines;
          ctx.restore();
        },
        beforeDraw(chart){
          const ctx = chart.ctx;
          ctx.save();
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, chart.width, chart.height);
          ctx.restore();
        }
      }],
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        color,
        interaction:{ mode:'index', intersect:false },
        scales:{
          x:{ stacked:true, title:{ display:true, text:`Hour of day (${timezone})`, color }, ticks:{ color }, grid:{ display:false } },
          ...Object.fromEntries(Object.entries(scales).map(([key, scale]) => [key, {
            ...scale,
            title:{ ...scale.title, color },
            ticks:{ color, ...scale.ticks },
            grid:{ color:color + '20', ...scale.grid }
          }]))
        },
        plugins:{
          title:{ display:true, text:title, color, font:{ size:16 } },
          legend:{ position:'bottom', labels:{ color, boxWidth:14, sort:(a,b) => a.datasetIndex - b.datasetIndex } },
          tooltip:{ callbacks:{
            title:items => items.length ? `${String(items[0].label).padStart(2, '0')}:00–${String(items[0].label).padStart(2, '0')}:59 (${timezone})` : '',
            label:item => `${item.dataset.label}: ${format(item.parsed.y, item.dataset.unit || '')}`
          } }
        }
      }
    });
    state.charts.push(chart);
  }

  function renderCharts(timezone){
    const series = (field, label, color, extra={}) => ({
      label, data:state.hourly.map(row => row[field]), backgroundColor:color, borderColor:color,
      borderWidth:2, pointRadius:3, tension:0, spanGaps:false, ...extra
    });
    const axis = (text, extra={}) => ({ beginAtZero:true, title:{ display:true, text }, ...extra });
    const lineColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    const attempts = [
      series('successful', 'Successful fixes', '#2f8a5b', { stack:'attempts', order:2 }),
      series('failed', 'Failed fixes', '#ca6060', { stack:'attempts', order:2 })
    ];
    if(state.hourly.some(row => row.unknown)) attempts.push(series('unknown', 'Unknown outcomes', '#94a3b8', { stack:'attempts', order:2 }));
    attempts.push(series('successRate', 'Fix success rate', lineColor, { type:'line', yAxisID:'rate', order:1, unit:'%' }));
    makeChart('GNSS fix attempts and success rate by hour', attempts, {
      y:axis('Number of reported attempts', { stacked:true, ticks:{ precision:0 } }),
      rate:axis('Fix success rate', { position:'right', min:0, max:100, grid:{ drawOnChartArea:false }, ticks:{ callback:value => `${value}%` } })
    }, timezone);
    makeChart('Time to fix by hour — successful fixes', [
      series('meanTtf', 'Mean TTF', '#5aa7ff', { type:'line', unit:' s' }),
      series('p90Ttf', 'P90 TTF', '#e9a23b', { type:'line', unit:' s' })
    ], { y:axis('Time to fix (s)') }, timezone);
    makeChart('Reported retries by hour — all outcomes', [
      series('meanHotRetry', 'Mean hot retries', '#e9a23b', { stack:'hot' }),
      series('meanColdRetry', 'Mean cold retries', '#5aa7ff', { stack:'cold' })
    ], { y:axis('Mean retries per record') }, timezone);
    makeChart('Fix quality by hour — successful fixes', [
      series('meanSatellites', 'Mean satellites (SIV)', '#2f8a5b', { type:'line' }),
      series('meanAccuracy', 'Mean horizontal accuracy estimate', '#5aa7ff', { type:'line', yAxisID:'accuracy', unit:' m' })
    ], {
      y:axis('Satellites in view'),
      accuracy:axis('Horizontal accuracy estimate (m)', { position:'right', grid:{ drawOnChartArea:false } })
    }, timezone);
  }

  const columns = [
    ['Hour', 'hour'], ['Attempts', 'attempts'], ['Successful', 'successful'], ['Failed', 'failed'], ['Unknown', 'unknown'],
    ['Success rate (%)', 'successRate'], ['TTF samples', 'ttfSamples'], ['Mean TTF (s)', 'meanTtf'], ['P90 TTF (s)', 'p90Ttf'],
    ['Mean hot retries', 'meanHotRetry'], ['Mean cold retries', 'meanColdRetry'],
    ['Mean satellites', 'meanSatellites'], ['Mean accuracy (m)', 'meanAccuracy']
  ];

  function timezoneLabel(){
    return byId('gnssTimezone').value === 'utc' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  function renderView(){
    if(!state.source) return;
    destroyViews();
    const timezone = byId('gnssTimezone').value;
    const label = timezoneLabel();
    const start = parseRangeBound(byId('gnssStart').value, timezone);
    const end = parseRangeBound(byId('gnssEnd').value, timezone, true);
    const coverage = byId('gnssCoverage');
    if((start != null && !Number.isFinite(start)) || (end != null && !Number.isFinite(end)) || (start != null && end != null && start > end)){
      byId('gnssSummary').replaceChildren();
      coverage.textContent = 'Choose a valid date range with the start at or before the end.';
      return;
    }
    const rows = filterAttempts(state.attempts, start, end);
    renderSummary(rows);
    const timed = rows.filter(row => row.timestampMs != null);
    const missing = state.attempts.filter(row => row.timestampMs == null).length;
    if(!state.attempts.length){
      coverage.textContent = 'No full u-blox location records (port 2) found. Short locations and resend messages do not include the diagnostics needed for this analysis.';
      return;
    }
    const range = timed.reduce((result, row) => [Math.min(result[0], row.timestampMs), Math.max(result[1], row.timestampMs)], [Infinity, -Infinity]);
    const dateLabel = value => new Date(value).toLocaleString(undefined, timezone === 'utc' ? { timeZone:'UTC' } : {});
    coverage.textContent = `${rows.length} of ${state.attempts.length} records selected; ${timed.length} placed in hourly groups (${label}). ` +
      (timed.length ? `Recorded range: ${dateLabel(range[0])} – ${dateLabel(range[1])}. ` : '') +
      `${missing} records have no usable timestamp; ${start != null || end != null ? 'excluded by the date filter' : 'included in summary totals only'}. ` +
      'Hours combine all selected days. Rates use total successful / known outcomes, not an average of daily rates. Flash-log time is used when available; otherwise the reported fix time is used. Missing hourly rates and metrics are left blank.';
    if(!rows.length){
      coverage.textContent = 'No GNSS records in the selected date range. ' + coverage.textContent;
      return;
    }
    if(!timed.length) return;
    state.hourly = aggregateHourly(rows, timezone);
    renderCharts(label);
    state.table = new Tabulator('#gnssTable', {
      data:state.hourly,
      layout:'fitDataStretch',
      height:'360px',
      columns:columns.map(([title, field]) => ({
        title:field === 'hour' ? `Hour (${label})` : title, field, sorter:'number',
        formatter:cell => format(cell.getValue()), minWidth:90
      }))
    });
    byId('gnssExportCsv').disabled = false;
    byId('gnssExportPng').disabled = false;
  }

  function download(url, name){
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function exportHourlyCSV(hourly, timezone){
    const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [['Time zone', ...columns.map(([title]) => title)],
      ...hourly.map(row => [timezone, ...columns.map(([, field]) => row[field])])];
    return lines.map(row => row.map(escape).join(',')).join('\r\n');
  }

  function bindControls(){
    if(state.bound) return;
    state.bound = true;
    const update = () => root.RawLogsUI.runWithBusy('Updating GNSS performance', 'Grouping selected fix attempts...', renderView);
    ['gnssStart', 'gnssEnd'].forEach(id => byId(id).addEventListener('change', update));
    let previousTimezone = byId('gnssTimezone').value;
    byId('gnssTimezone').addEventListener('change', () => {
      const nextTimezone = byId('gnssTimezone').value;
      // Preserve the selected instants when changing the display time zone.
      ['gnssStart', 'gnssEnd'].forEach(id => {
        const input = byId(id);
        const time = parseRangeBound(input.value, previousTimezone);
        if(time == null || !Number.isFinite(time)) return;
        const date = new Date(time);
        const wallTime = nextTimezone === 'utc' ? time : time - date.getTimezoneOffset() * 60000;
        input.value = new Date(wallTime).toISOString().slice(0, 19);
      });
      previousTimezone = nextTimezone;
      update();
    });
    byId('gnssResetRange').addEventListener('click', () => {
      byId('gnssStart').value = '';
      byId('gnssEnd').value = '';
      update();
    });
    byId('gnssExportCsv').addEventListener('click', () => {
      if(!state.hourly.length) return;
      const url = URL.createObjectURL(new Blob([exportHourlyCSV(state.hourly, timezoneLabel())], { type:'text/csv;charset=utf-8' }));
      download(url, `${state.fileName}_gnss_hourly.csv`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    byId('gnssExportPng').addEventListener('click', () => {
      if(state.charts[0]) download(state.charts[0].toBase64Image(), `${state.fileName}_gnss_fixes_by_hour.png`);
    });
  }

  function render(messageRows, fileName){
    bindControls();
    byId('gnssPlaceholder').style.display = 'none';
    byId('gnssPanel').style.display = 'block';
    if(state.source === messageRows){
      state.charts.forEach(chart => chart.resize());
      if(state.table) state.table.redraw();
      return;
    }
    state.source = messageRows;
    state.attempts = collectAttempts(messageRows);
    state.fileName = fileName || 'decoded';
    renderView();
  }

  if(typeof module !== 'undefined' && module.exports){
    module.exports = { collectAttempts, parseRangeBound, filterAttempts, summarizeAttempts, aggregateHourly, exportHourlyCSV };
  } else {
    root.RawLogsGNSS = { render, reset };
  }
})(typeof window !== 'undefined' ? window : globalThis);
