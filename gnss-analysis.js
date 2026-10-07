(function(root){
  'use strict';

  const DEFAULT_FAILURE_SETTINGS = { hotTimeout:65, coldTimeout:200, shortLimit:35 };
  const FAILURE_LABELS = {
    early:'Likely early stop', short:'Short failure — timeout unknown',
    other:'Other failure', unassessed:'Not assessed'
  };

  function numeric(value){
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    if(typeof value === 'string' && !value.trim()) return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  function collectAttempts(messageRows){
    return messageRows.filter(row => String(row.port) === '2').map((row, index) => {
      const data = row.dataObj || {};
      const flag = typeof data.success === 'string' ? data.success.trim().toLowerCase() : data.success;
      const success = flag === true || flag === 'true' ? 1 : flag === false || flag === 'false' ? 0 : numeric(flag);
      // Flash-log timestamps describe the recorded attempt, even when a failed
      // fix has an absent, zero, or stale fix_timestamp in its payload.
      let timestampMs = Date.parse(row.timestamp_utc || '');
      if(!Number.isFinite(timestampMs) || timestampMs <= 0){
        const seconds = numeric(data.fix_timestamp ?? data.fix_time ?? data.timestamp);
        timestampMs = seconds != null && seconds > 0 ? seconds * 1000 : NaN;
      }
      return {
        record:index + 1,
        timestampMs: Number.isFinite(timestampMs) && Number.isFinite(new Date(timestampMs).getTime()) ? timestampMs : null,
        outcome: success === 1 ? 'success' : success === 0 ? 'failed' : 'unknown',
        ttf: numeric(data.ttf),
        hotRetry: numeric(data.hot_retry),
        coldRetry: numeric(data.cold_retry),
        activeTracking: String(data.active_t).trim().toLowerCase() === 'true' || numeric(data.active_t) > 0,
        satellites: numeric(data.SIV),
        accuracy: numeric(data.h_acc_est)
      };
    });
  }

  function classifyFailure(row, settings=DEFAULT_FAILURE_SETTINGS){
    if(row.outcome !== 'failed') return null;
    // A failed cold acquisition increments cold_retry; an exhausted hot retry
    // count may still be present during cold acquisition, so cold takes priority.
    const mode = row.coldRetry > 0 ? 'cold' : row.hotRetry > 0 ? 'hot' : 'unknown';
    const hot = numeric(settings.hotTimeout);
    const cold = numeric(settings.coldTimeout);
    const timeout = mode === 'hot' ? hot : mode === 'cold' ? cold :
      hot > 0 && cold > 0 ? Math.min(hot, cold) : null;
    const referenceTimeout = timeout > 0 ? timeout : null;
    const result = { mode, referenceTimeout, zeroSiv:row.satellites === 0 };
    if(row.activeTracking || !Number.isFinite(row.ttf) || row.ttf <= 0){
      return { ...result, category:'unassessed', reason:row.activeTracking
        ? 'Active tracking: reported TTF is not an acquisition duration.'
        : 'Missing or zero TTF; a short acquisition cannot be established.' };
    }
    const limit = numeric(settings.shortLimit);
    if(!(limit > 0)) return { ...result, category:'unassessed', reason:'Enter a positive short-failure limit.' };
    if(row.ttf > limit) return { ...result, category:'other', reason:'Reported TTF exceeds the short-failure limit.' };
    if(referenceTimeout == null){
      return { ...result, category:'short', reason:mode === 'unknown'
        ? 'Mode is unknown; both hot and cold timeouts are needed.'
        : `Enter the ${mode} timeout to compare this short failure.` };
    }
    if(referenceTimeout - row.ttf < 5){
      return { ...result, category:'other', reason:'Not at least 5 s below the reference timeout.' };
    }
    return { ...result, category:'early', reason:mode === 'unknown'
      ? 'Short failed TTF, at least 5 s below both timeouts; stop cause is inferred.'
      : `Short failed TTF, at least 5 s below the inferred ${mode} timeout; stop cause is inferred.` };
  }

  function filterAttempts(attempts, start, end){
    if(start == null && end == null) return attempts;
    return attempts.filter(row => row.timestampMs != null &&
      (start == null || row.timestampMs >= start) && (end == null || row.timestampMs <= end));
  }

  function summarizeAttempts(rows, settings=DEFAULT_FAILURE_SETTINGS){
    const successful = rows.filter(row => row.outcome === 'success');
    const failures = rows.filter(row => row.outcome === 'failed');
    const failed = failures.length;
    const classifications = failures.map(row => classifyFailure(row, settings));
    const earlyStops = classifications.filter(item => item.category === 'early').length;
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
      earlyStops,
      otherFailed:failed - earlyStops,
      earlyZeroSiv:classifications.filter(item => item.category === 'early' && item.zeroSiv).length,
      shortUnconfirmed:classifications.filter(item => item.category === 'short').length,
      unassessedFailures:classifications.filter(item => item.category === 'unassessed').length,
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

  function aggregateHourly(attempts, timezone='utc', settings=DEFAULT_FAILURE_SETTINGS){
    const buckets = Array.from({ length:24 }, () => []);
    attempts.forEach(row => {
      if(row.timestampMs == null) return;
      const date = new Date(row.timestampMs);
      const hour = timezone === 'utc' ? date.getUTCHours() : date.getHours();
      buckets[hour].push(row);
    });
    return buckets.map((rows, hour) => ({ hour, ...summarizeAttempts(rows, settings) }));
  }

  const state = { source:null, attempts:[], timed:[], range:null, charts:[], table:null, failureTable:null, failures:[], hourly:[], settings:DEFAULT_FAILURE_SETTINGS, fileName:'decoded', bound:false };
  const byId = id => document.getElementById(id);
  const format = (value, suffix='') => Number.isFinite(value)
    ? `${Number(value.toFixed(1)).toLocaleString()}${suffix}` : '—';

  function destroyViews(){
    state.charts.forEach(chart => chart.destroy());
    state.charts = [];
    if(state.table) state.table.destroy();
    state.table = null;
    if(state.failureTable) state.failureTable.destroy();
    state.failureTable = null;
    state.failures = [];
    byId('gnssFailuresTable').replaceChildren();
    byId('gnssFailuresPanel').style.display = 'none';
    byId('gnssExportFailures').disabled = true;
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
    state.timed = [];
    state.range = null;
    byId('gnssTimeSliderWrapper').style.display = 'none';
    byId('gnssSummary').replaceChildren();
    byId('gnssCoverage').textContent = '';
    byId('gnssPanel').style.display = 'none';
    byId('gnssPlaceholder').style.display = '';
  }

  function renderSummary(rows){
    const summary = summarizeAttempts(rows, state.settings);
    const tiles = [
      ['Reported attempts', summary.attempts, 'full u-blox records'],
      ['Successful fixes', summary.successful, 'success = 1 / TRUE'],
      ['Failed fixes', summary.failed, 'success = 0 / FALSE'],
      ['Likely early stops', summary.earlyStops, 'subset of failed attempts; inferred'],
      ['Fix success rate', format(summary.successRate, '%'), 'successful / known outcomes'],
      ['Unknown outcomes', summary.unknown, 'excluded from success rate'],
      ['Mean time to fix', format(summary.meanTtf, ' s'), `${summary.ttfSamples} successful fixes with TTF`],
      ['P90 time to fix', format(summary.p90Ttf, ' s'), 'successful fixes; nearest-rank percentile'],
      ['Mean hot / cold retries', `${format(summary.meanHotRetry)} / ${format(summary.meanColdRetry)}`, 'per record with a reported counter'],
      ['Mean satellites used', format(summary.meanSatellites), 'successful fixes with SIV'],
      ['Mean accuracy estimate', format(summary.meanAccuracy, ' m'), 'successful fixes; horizontal estimate']
    ];
    renderMetricTiles(byId('gnssSummary'), tiles);
  }

  function renderMetricTiles(holder, tiles){
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
    const hasEarlyStops = state.hourly.some(row => row.earlyStops > 0);
    const attempts = [
      series('successful', 'Successful fixes', '#2f8a5b', { stack:'attempts', order:2 }),
      series(hasEarlyStops ? 'otherFailed' : 'failed', hasEarlyStops ? 'Other failed fixes' : 'Failed fixes', '#ca6060', { stack:'attempts', order:2 })
    ];
    if(hasEarlyStops) attempts.push(series('earlyStops', 'Likely early stops (failed)', '#e9a23b', { stack:'attempts', order:2 }));
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
      y:axis('Satellites used in fix (SIV)'),
      accuracy:axis('Horizontal accuracy estimate (m)', { position:'right', grid:{ drawOnChartArea:false } })
    }, timezone);
  }

  const columns = [
    ['Hour', 'hour'], ['Attempts', 'attempts'], ['Successful', 'successful'], ['Failed', 'failed'], ['Unknown', 'unknown'],
    ['Success rate (%)', 'successRate'], ['TTF samples', 'ttfSamples'], ['Mean TTF (s)', 'meanTtf'], ['P90 TTF (s)', 'p90Ttf'],
    ['Mean hot retries', 'meanHotRetry'], ['Mean cold retries', 'meanColdRetry'],
    ['Mean satellites', 'meanSatellites'], ['Mean accuracy (m)', 'meanAccuracy'],
    ['Likely early stops', 'earlyStops'], ['Early stops with SIV=0', 'earlyZeroSiv'],
    ['Short failures: timeout unknown', 'shortUnconfirmed'], ['Failures not assessed', 'unassessedFailures']
  ];

  const failureColumns = [
    ['Record', 'record'], ['Timestamp (UTC)', 'timestamp_utc'], ['Assessment', 'assessment'],
    ['Mode (inferred)', 'mode'], ['Reported TTF (s)', 'ttf'], ['SIV', 'satellites'],
    ['Reference timeout (s)', 'referenceTimeout'], ['Hot retries', 'hotRetry'], ['Cold retries', 'coldRetry'],
    ['Reason', 'reason']
  ];

  function renderFailures(rows){
    state.failures = rows.filter(row => row.outcome === 'failed').map(row => {
      const result = classifyFailure(row, state.settings);
      return { ...row, ...result, assessment:FAILURE_LABELS[result.category],
        timestamp_utc:row.timestampMs == null ? '' : new Date(row.timestampMs).toISOString() };
    });
    if(!state.failures.length) return;
    byId('gnssFailuresPanel').style.display = 'block';
    byId('gnssFailureNote').textContent = `Likely early stops are failed attempts with 0 < TTF ≤ ${format(state.settings.shortLimit)} s, at least 5 s below the reference timeout. ` +
      `Analysis timeouts: hot ${format(state.settings.hotTimeout, ' s')}, cold ${format(state.settings.coldTimeout, ' s')}. ` +
      'Hot/cold mode is inferred from retry counters (cold takes priority); unknown mode uses the shorter of both timeouts. ' +
      'SIV=0 is shown as context, not proof: SIV counts satellites used in the fix, while the firmware checks a separate detected-satellite count. ' +
      'Missing/zero TTF and active-tracking records cannot establish an early stop. A short duration suggests an early exit but does not prove its cause.';
    const summary = summarizeAttempts(rows, state.settings);
    renderMetricTiles(byId('gnssFailureSummary'), [
      ['Likely early stops', summary.earlyStops, `${format(summary.earlyStops / summary.failed * 100, '%')} of failed attempts`],
      ['Of these, SIV = 0', summary.earlyZeroSiv, 'supporting context; not a required condition'],
      ['Short, timeout unknown', summary.shortUnconfirmed, 'enter the applicable timeout(s)'],
      ['Not assessed', summary.unassessedFailures, 'duration unavailable, active tracking, or missing limit']
    ]);
    const numericFields = new Set(['record', 'ttf', 'satellites', 'referenceTimeout', 'hotRetry', 'coldRetry']);
    state.failureTable = new Tabulator('#gnssFailuresTable', {
      data:state.failures, layout:'fitDataStretch', height:'340px', pagination:'local', paginationSize:100,
      columns:failureColumns.map(([title, field]) => ({
        title, field, minWidth:90,
        sorter:numericFields.has(field) ? 'number' : 'string',
        formatter:numericFields.has(field) ? cell => format(cell.getValue()) : 'plaintext',
        ...(field === 'assessment' ? { headerFilter:'list', headerFilterParams:{ valuesLookup:true, clearable:true } } : {})
      }))
    });
    byId('gnssExportFailures').disabled = false;
  }

  function readFailureSettings(){
    const positive = id => { const value = numeric(byId(id).value); return value > 0 ? value : null; };
    return { hotTimeout:positive('gnssHotTimeout'), coldTimeout:positive('gnssColdTimeout'), shortLimit:positive('gnssShortFailureLimit') };
  }

  function timezoneLabel(){
    return byId('gnssTimezone').value === 'utc' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  function isFullTimeSelection(){
    const range = state.range;
    return !range || (range.start <= range.fullMin && range.end >= range.fullMax);
  }

  function selectedAttempts(){
    // Untimed attempts retain their place in full-range summary totals only.
    return isFullTimeSelection() ? state.attempts : filterAttempts(state.attempts, state.range.start, state.range.end);
  }

  function drawTimeMarkers(){
    if(!state.range) return;
    const canvas = byId('gnssTimeMarkers');
    const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
    const height = 28;
    const dpr = root.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { scaleMin, scaleMax, start, end } = state.range;
    state.timed.forEach(row => {
      const time = row.timestampMs;
      if(time < scaleMin || time > scaleMax) return;
      const ratio = scaleMax > scaleMin ? (time - scaleMin) / (scaleMax - scaleMin) : 0.5;
      ctx.beginPath();
      ctx.arc(ratio * width, height - 4, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = time >= start && time <= end ? 'rgba(249,115,22,.78)' : 'rgba(37,99,235,.28)';
      ctx.fill();
    });
  }

  function updateTimeSlider(){
    const range = state.range;
    byId('gnssTimeSliderWrapper').style.display = range ? 'block' : 'none';
    if(!range) return;
    const startSlider = byId('gnssTimeStartSlider');
    const endSlider = byId('gnssTimeEndSlider');
    [startSlider, endSlider].forEach(slider => {
      slider.min = String(range.scaleMin);
      slider.max = String(range.scaleMax);
      slider.disabled = range.fullMin === range.fullMax;
    });
    startSlider.value = String(range.start);
    endSlider.value = String(range.end);
    const span = range.scaleMax - range.scaleMin;
    const track = byId('gnssTimeRangeSlider');
    track.style.setProperty('--range-start', `${span > 0 ? (range.start - range.scaleMin) / span * 100 : 0}%`);
    track.style.setProperty('--range-end', `${span > 0 ? (range.end - range.scaleMin) / span * 100 : 100}%`);
    const rows = selectedAttempts();
    const timed = state.timed.filter(row => row.timestampMs >= range.start && row.timestampMs <= range.end);
    const options = byId('gnssTimezone').value === 'utc' ? { timeZone:'UTC' } : {};
    const dateLabel = time => root.formatTimeRangeLabel(time, options);
    byId('gnssTimeRangeLabel').textContent = `GNSS time range (${timezoneLabel()})`;
    byId('gnssTimeStartLabel').textContent = dateLabel(timed[0]?.timestampMs);
    byId('gnssTimeEndLabel').textContent = dateLabel(timed[timed.length - 1]?.timestampMs);
    root.updateTimeSliderSummary(byId('gnssTimeCurrentLabel'), `${rows.length}/${state.attempts.length} records`);
    const fullScale = range.scaleMin === range.fullMin && range.scaleMax === range.fullMax;
    byId('gnssTimeScaleLabel').textContent = root.formatTimeSliderScaleLabel(fullScale, dateLabel(range.scaleMin), dateLabel(range.scaleMax));
    root.setTimeSliderResetState(byId('gnssTimeResetScaleBtn'), !fullScale);
    root.setTimeSelectionResetState(byId('gnssTimeResetSelectionBtn'), startSlider, endSlider, range.fullMin, range.fullMax);
    drawTimeMarkers();
  }

  function commitTimeSelection(){
    const range = state.range;
    if(!range) return;
    const timed = state.timed.filter(row => row.timestampMs >= range.start && row.timestampMs <= range.end);
    const first = timed[0]?.timestampMs;
    const last = timed[timed.length - 1]?.timestampMs;
    if(last > first){
      range.scaleMin = range.start = first;
      range.scaleMax = range.end = last;
    }
    renderView();
  }

  function renderView(){
    if(!state.source) return;
    destroyViews();
    const timezone = byId('gnssTimezone').value;
    const label = timezoneLabel();
    const coverage = byId('gnssCoverage');
    updateTimeSlider();
    const rows = selectedAttempts();
    state.settings = readFailureSettings();
    renderSummary(rows);
    renderFailures(rows);
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
      `${missing} records have no usable timestamp; ${isFullTimeSelection() ? 'included in summary totals only' : 'excluded by the time filter'}. ` +
      'Hours combine all selected days. Rates use total successful / known outcomes, not an average of daily rates. Flash-log time is used when available; otherwise the reported fix time is used. Missing hourly rates and metrics are left blank.';
    if(!rows.length){
      coverage.textContent = 'No GNSS records in the selected time range. ' + coverage.textContent;
      return;
    }
    if(!timed.length) return;
    state.hourly = aggregateHourly(rows, timezone, state.settings);
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

  function exportCSV(headers, rows){
    const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
  }

  function exportHourlyCSV(hourly, timezone, settings=DEFAULT_FAILURE_SETTINGS){
    return exportCSV(['Time zone', ...columns.map(([title]) => title), 'Hot timeout (s)', 'Cold timeout (s)', 'Short failure limit (s)'],
      hourly.map(row => [timezone, ...columns.map(([, field]) => row[field]), settings.hotTimeout, settings.coldTimeout, settings.shortLimit]));
  }

  function exportFailuresCSV(failures, settings=DEFAULT_FAILURE_SETTINGS){
    return exportCSV([...failureColumns.map(([title]) => title), 'Hot timeout (s)', 'Cold timeout (s)', 'Short failure limit (s)'],
      failures.map(row => [...failureColumns.map(([, field]) => row[field]), settings.hotTimeout, settings.coldTimeout, settings.shortLimit]));
  }

  function bindControls(){
    if(state.bound) return;
    state.bound = true;
    const update = () => root.RawLogsUI.runWithBusy('Updating GNSS performance', 'Grouping selected fix attempts...', renderView);
    ['start', 'end'].forEach(handle => {
      const slider = byId(handle === 'start' ? 'gnssTimeStartSlider' : 'gnssTimeEndSlider');
      slider.addEventListener('input', () => {
        const range = state.range;
        if(!range) return;
        range[handle] = Number(slider.value);
        if(range.start > range.end){
          if(handle === 'start') range.end = range.start;
          else range.start = range.end;
        }
        updateTimeSlider();
      });
      slider.addEventListener('change', () => root.RawLogsUI.runWithBusy('Updating GNSS performance', 'Grouping selected fix attempts...', commitTimeSelection));
    });
    byId('gnssTimezone').addEventListener('change', update);
    ['gnssHotTimeout', 'gnssColdTimeout', 'gnssShortFailureLimit'].forEach(id => byId(id).addEventListener('change', update));
    ['gnssTimeResetScaleBtn', 'gnssTimeResetSelectionBtn'].forEach(id => {
      byId(id).addEventListener('click', () => {
        const range = state.range;
        if(!range) return;
        range.scaleMin = range.fullMin;
        range.scaleMax = range.fullMax;
        if(id === 'gnssTimeResetSelectionBtn'){
          range.start = range.fullMin;
          range.end = range.fullMax;
        }
        update();
      });
    });
    new ResizeObserver(() => {
      if(byId('gnssCard').open) updateTimeSlider();
    }).observe(byId('gnssTimeRangeSlider'));
    byId('gnssExportCsv').addEventListener('click', () => {
      if(!state.hourly.length) return;
      const url = URL.createObjectURL(new Blob([exportHourlyCSV(state.hourly, timezoneLabel(), state.settings)], { type:'text/csv;charset=utf-8' }));
      download(url, `${state.fileName}_gnss_hourly.csv`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    byId('gnssExportFailures').addEventListener('click', () => {
      if(!state.failures.length) return;
      const rows = state.failureTable ? state.failureTable.getData('active') : state.failures;
      const url = URL.createObjectURL(new Blob([exportFailuresCSV(rows, state.settings)], { type:'text/csv;charset=utf-8' }));
      download(url, `${state.fileName}_gnss_failed_attempts.csv`);
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
      updateTimeSlider();
      state.charts.forEach(chart => chart.resize());
      if(state.table) state.table.redraw();
      if(state.failureTable) state.failureTable.redraw();
      return;
    }
    state.source = messageRows;
    state.attempts = collectAttempts(messageRows);
    state.timed = state.attempts.filter(row => row.timestampMs != null).sort((a,b) => a.timestampMs - b.timestampMs);
    const first = state.timed[0]?.timestampMs;
    const last = state.timed[state.timed.length - 1]?.timestampMs;
    state.range = state.timed.length ? { fullMin:first, fullMax:last, scaleMin:first, scaleMax:last, start:first, end:last } : null;
    state.fileName = fileName || 'decoded';
    renderView();
  }

  if(typeof module !== 'undefined' && module.exports){
    module.exports = { collectAttempts, classifyFailure, filterAttempts, summarizeAttempts, aggregateHourly, exportHourlyCSV, exportFailuresCSV };
  } else {
    root.RawLogsGNSS = { render, reset };
  }
})(typeof window !== 'undefined' ? window : globalThis);
