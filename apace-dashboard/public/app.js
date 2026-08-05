const $ = (id) => document.getElementById(id);

let state = null;
let countdownTimer = null;
let autoRefresh = false;
let autoTimer = null;
const openRows = new Set();
const pendingConfirm = new Map();

/* --- formatting ----------------------------------------------------------- */
const money = (v) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) : '—';
const compactMoney = (v) =>
  Number.isFinite(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
const pct = (v, digits = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
const fixed = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const clockTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/* --- small charts --------------------------------------------------------- */
function sparkline(points, direction) {
  if (!points || points.length < 2) return '<span class="label">no bars</span>';

  const width = 92;
  const height = 26;
  const values = points.map((p) => p.c);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const x = (i) => (i / (points.length - 1)) * width;
  const y = (v) => height - 2 - ((v - min) / span) * (height - 4);

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const stroke = direction >= 0 ? 'var(--good)' : 'var(--bad)';
  const lastX = x(points.length - 1);
  const lastY = y(values[values.length - 1]);

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Session price path, ${direction >= 0 ? 'up' : 'down'} on the day">
      <path d="${area}" fill="${stroke}" opacity="0.12" />
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${stroke}"
              stroke="var(--surface)" stroke-width="1.5" />
    </svg>`;
}

function factorBar(factor) {
  const strength = Math.max(-1, Math.min(1, factor.strength));
  const widthPct = Math.abs(strength) * 50;

  let bar;
  if (Math.abs(strength) < 0.02) {
    bar = '<span class="factor__bar factor__bar--flat"></span>';
  } else if (strength > 0) {
    bar = `<span class="factor__bar factor__bar--pos" style="width:${widthPct.toFixed(1)}%"></span>`;
  } else {
    bar = `<span class="factor__bar factor__bar--neg" style="width:${widthPct.toFixed(1)}%"></span>`;
  }

  return `
    <div class="factor">
      <div class="factor__name">${escapeHtml(factor.label)}
        <span class="factor__weight num">${factor.weight}</span>
      </div>
      <div class="factor__track" role="img"
           aria-label="${escapeHtml(factor.label)}: ${strength > 0 ? 'supports' : strength < 0 ? 'argues against' : 'neutral for'} the trade">
        <span class="factor__zero"></span>${bar}
      </div>
      <div class="factor__detail">${escapeHtml(factor.detail)}</div>
    </div>`;
}

/* --- row rendering -------------------------------------------------------- */
function actionPill(candidate) {
  const map = {
    TRADEABLE: ['pill--good', '▲', 'Tradeable'],
    WATCH: ['pill--warn', '●', 'Watch'],
    AVOID: ['pill--bad', '▼', 'Avoid'],
    HELD: ['pill--accent', '◆', 'Held'],
    'NO DATA': ['pill--neutral', '○', 'No data'],
  };
  const [cls, glyph, text] = map[candidate.action] || map['NO DATA'];
  return `<span class="pill ${cls}">${glyph} ${text}</span>`;
}

function scoreClass(score, threshold) {
  if (score >= threshold) return 'score__fill--good';
  if (score >= threshold - 15) return 'score__fill--warn';
  return 'score__fill--bad';
}

function planBlock(candidate) {
  const plan = candidate.plan;
  if (!plan?.viable) {
    return `<p class="empty">No position could be sized: ${escapeHtml(plan?.reason || 'unknown reason')}.</p>`;
  }

  const riskShare = 1 / (1 + plan.rMultiple);
  return `
    <div class="plan">
      <div class="plan__grid">
        <div class="plan__cell"><span class="label">Shares</span><span class="plan__v">${plan.qty}</span></div>
        <div class="plan__cell"><span class="label">Entry</span><span class="plan__v">${fixed(plan.entryPrice)}</span></div>
        <div class="plan__cell"><span class="label">Stop</span><span class="plan__v">${fixed(plan.stopPrice)}</span></div>
        <div class="plan__cell"><span class="label">Target</span><span class="plan__v">${fixed(plan.takeProfitPrice)}</span></div>
        <div class="plan__cell"><span class="label">Notional</span><span class="plan__v">${money(plan.notional)}</span></div>
        <div class="plan__cell"><span class="label">At risk</span><span class="plan__v">${money(plan.riskDollars)}</span></div>
      </div>
      <div>
        <div class="plan__ladder" role="img" aria-label="Risk to reward, 1 to ${plan.rMultiple}">
          <span class="plan__risk" style="width:${(riskShare * 100).toFixed(0)}%"></span>
          <span class="plan__reward" style="width:${((1 - riskShare) * 100).toFixed(0)}%"></span>
        </div>
        <span class="label">stop ${fixed(plan.stopDistancePct)}% away · target ${plan.rMultiple}R</span>
      </div>
    </div>`;
}

function reasonsBlock(candidate) {
  const news = candidate.news;
  if (!news) {
    const why = state?.analysis?.newsRead?.available === false
      ? escapeHtml(state.analysis.newsRead.reason || 'model unavailable')
      : 'not shortlisted for a news read';
    return `<p class="empty">No written reasoning — ${why}. The score above is pure price and volume.</p>`;
  }

  const list = (items, fallback) =>
    items?.length
      ? items.map((r) => `<li>${escapeHtml(r)}</li>`).join('')
      : `<li class="empty">${fallback}</li>`;

  return `
    <div class="reasons">
      <div>
        <div class="reasons__head reasons__head--for">▲ Case for</div>
        <ul>${list(news.reasonsFor, 'Nothing compelling.')}</ul>
      </div>
      <div>
        <div class="reasons__head reasons__head--against">▼ Case against</div>
        <ul>${list(news.reasonsAgainst, 'Nothing flagged.')}</ul>
      </div>
    </div>`;
}

function headlinesBlock(candidate) {
  if (!candidate.newsArticles?.length) {
    return '<p class="empty">No headlines in the last 36 hours.</p>';
  }
  return `<div class="headlines">${candidate.newsArticles
    .map((article) => {
      const url = safeUrl(article.url);
      const title = escapeHtml(article.headline);
      const link = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
      return `<div class="headline">${link}
        <span class="headline__meta">${escapeHtml(article.source || 'unknown')} · ${clockTime(article.createdAt)}</span>
      </div>`;
    })
    .join('')}</div>`;
}

function renderRow(candidate, limits) {
  const isOpen = openRows.has(candidate.symbol);
  const rowClass = ['row'];
  if (candidate.action === 'TRADEABLE') rowClass.push('row--tradeable');
  if (candidate.action === 'HELD') rowClass.push('row--held');

  if (!candidate.factors?.length) {
    return `
      <details class="row" data-symbol="${candidate.symbol}" ${isOpen ? 'open' : ''}>
        <summary class="row__head">
          <div><div class="row__symbol">${candidate.symbol}</div></div>
          <div></div>
          <div class="row__metrics"><span class="empty">${escapeHtml(candidate.note || 'No data')}</span></div>
          <div></div>
          <div>${actionPill(candidate)}</div>
          <span class="chev">›</span>
        </summary>
        <div class="detail"><p class="empty">Nothing to show — the data feed returned no bars for this symbol today.</p></div>
      </details>`;
  }

  const metrics = [
    ['vwap', candidate.vwapDistPct == null ? '—' : pct(candidate.vwapDistPct)],
    ['rvol', candidate.rvol == null ? '—' : `${fixed(candidate.rvol)}x`],
    ['spread', candidate.spreadBps == null ? '—' : `${fixed(candidate.spreadBps, 1)}bp`],
    ['orb', candidate.orb ? candidate.orb.state : '—'],
    ['atr', fixed(candidate.atr)],
  ];

  const newsNote = candidate.newsAdjustment
    ? `<span class="pill ${candidate.newsAdjustment > 0 ? 'pill--good' : 'pill--bad'}">news ${candidate.newsAdjustment > 0 ? '+' : ''}${candidate.newsAdjustment}</span>`
    : '';
  const vetoNote = candidate.vetoed
    ? `<span class="pill pill--bad">▼ vetoed</span>`
    : '';

  return `
    <details class="${rowClass.join(' ')}" data-symbol="${candidate.symbol}" ${isOpen ? 'open' : ''}>
      <summary class="row__head">
        <div>
          <div class="row__symbol">${candidate.symbol}</div>
          <div class="row__price">${fixed(candidate.last)} <span class="${candidate.changePct >= 0 ? 'pl--up' : 'pl--down'}">${pct(candidate.changePct)}</span></div>
        </div>

        <div class="score">
          <span class="score__value">${candidate.score}</span>
          <span class="score__track">
            <span class="score__fill ${scoreClass(candidate.score, limits.minScoreToTrade)}" style="width:${candidate.score}%"></span>
          </span>
        </div>

        <div class="row__metrics">
          ${metrics.map(([k, v]) => `<span class="metric"><span class="metric__k">${k}</span><span class="metric__v">${escapeHtml(v)}</span></span>`).join('')}
        </div>

        <div class="row__spark">${sparkline(candidate.sparkline, candidate.changePct)}</div>

        <div>${actionPill(candidate)}</div>
        <span class="chev">›</span>
      </summary>

      <div class="detail">
        <div>
          <div class="panel">
            <div class="panel__title">Score breakdown · ${candidate.technicalScore} technical ${newsNote} ${vetoNote}</div>
            ${candidate.factors.map(factorBar).join('')}
          </div>

          <div class="panel">
            <div class="panel__title">Why / why not</div>
            ${reasonsBlock(candidate)}
            ${candidate.news?.catalyst ? `<p class="factor__detail"><strong>Catalyst:</strong> ${escapeHtml(candidate.news.catalyst)}</p>` : ''}
            ${candidate.news?.veto ? `<p class="factor__detail" style="color:var(--bad)"><strong>Veto:</strong> ${escapeHtml(candidate.news.vetoReason || 'flagged')}</p>` : ''}
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="panel__title">Proposed trade</div>
            ${planBlock(candidate)}
            <div class="execute">
              <button class="btn btn--primary" data-execute="${candidate.symbol}"
                ${candidate.action === 'HELD' ? 'disabled' : ''}>
                ${candidate.action === 'HELD' ? 'Already held' : 'Check &amp; execute'}
              </button>
              <span class="execute__note" data-execute-note="${candidate.symbol}">
                Runs the risk check again server-side before anything is sent.
              </span>
            </div>
            <ul class="blockers" data-blockers="${candidate.symbol}"></ul>
          </div>

          <div class="panel">
            <div class="panel__title">Headlines</div>
            ${headlinesBlock(candidate)}
          </div>
        </div>
      </div>
    </details>`;
}

/* --- top-level render ----------------------------------------------------- */
function renderBanners(data, meta) {
  const banners = [];

  if (data.mode === 'live') {
    banners.push(['bad', '<strong>Live account.</strong> Orders placed here move real money.']);
  }
  if (!data.session.isCurrent) {
    banners.push(['warn', `<strong>Market closed.</strong> Showing the ${escapeHtml(data.session.date)} session. Execution is disabled.`]);
  } else if (data.session.minutesToClose < data.limits.minMinutesToClose) {
    banners.push(['warn', `<strong>Late in the session.</strong> Inside the ${data.limits.minMinutesToClose}-minute no-new-entries window — close out rather than open up.`]);
  }
  if (meta.stale) {
    banners.push(['warn', `<strong>Analysis is stale</strong> (${meta.ageSeconds}s old, limit ${data.limits.maxAnalysisAgeSeconds}s). Refresh before trading.`]);
  }
  if (data.account.pdtRestricted && data.account.dayTradeCount >= 3) {
    banners.push(['bad', `<strong>PDT limit reached.</strong> ${data.account.dayTradeCount} day trades in five sessions with equity under $25k.`]);
  }
  if (data.newsRead.available === false) {
    banners.push(['info', `<strong>No news reasoning.</strong> ${escapeHtml(data.newsRead.reason || 'model unavailable')} — scores are price and volume only.`]);
  }
  if (data.dataFeed === 'iex') {
    banners.push(['info', '<strong>IEX feed.</strong> Volume covers only IEX, so relative volume and VWAP are approximations. A SIP subscription makes both meaningfully sharper.']);
  }

  $('banners').innerHTML = banners
    .map(([kind, html]) => `<div class="banner banner--${kind}">${html}</div>`)
    .join('');
}

function renderRail(data, meta) {
  $('modeBadge').textContent = data.mode;
  $('modeBadge').className = `mode-badge mode-badge--${data.mode === 'paper' ? 'paper' : 'live'}`;
  $('sessionState').textContent = data.session.isCurrent ? 'Open' : 'Closed';
  $('equity').textContent = compactMoney(data.account.equity);
  $('buyingPower').textContent = compactMoney(data.account.buyingPower);
  $('dayTrades').textContent = data.account.pdtRestricted
    ? `${data.account.dayTradeCount} / 3`
    : String(data.account.dayTradeCount);
  $('analysedAt').textContent = `${clockTime(data.generatedAt)} · ${meta.ageSeconds}s`;
}

function renderPositions(positions) {
  const el = $('positions');
  if (!positions.length) {
    el.innerHTML = '<p class="empty">Flat. Nothing open.</p>';
    return;
  }
  el.innerHTML = positions
    .map(
      (p) => `
      <div class="position">
        <div>
          <div class="position__sym">${escapeHtml(p.symbol)}</div>
          <div class="label">${p.qty} @ ${fixed(p.avgEntry)}</div>
        </div>
        <div>
          <div class="position__pl ${p.unrealizedPl >= 0 ? 'pl--up' : 'pl--down'}">${money(p.unrealizedPl)}</div>
          <div class="label" style="text-align:right">${pct(p.unrealizedPlPct)}</div>
        </div>
        <button class="btn btn--sm" data-close="${escapeHtml(p.symbol)}">Close</button>
      </div>`,
    )
    .join('');
}

function renderLog(trades) {
  const el = $('tradeLog');
  if (!trades.length) {
    el.innerHTML = '<p class="empty">No orders yet.</p>';
    return;
  }
  el.innerHTML = trades
    .map((t) => {
      const detail =
        t.status === 'submitted'
          ? `${t.qty} sh · stop ${fixed(t.stopPrice)}`
          : t.status === 'blocked'
            ? escapeHtml((t.blockers || [])[0] || 'blocked')
            : escapeHtml(t.status);
      return `<div class="log__row">
        <div><span class="log__sym">${escapeHtml(t.symbol)}</span> <span class="label">${escapeHtml(t.status)}</span>
          <div class="label" style="text-transform:none">${detail}</div></div>
        <span class="log__time">${clockTime(t.loggedAt)}</span>
      </div>`;
    })
    .join('');
}

function renderLimits(limits) {
  const rows = [
    ['Min score to trade', limits.minScoreToTrade],
    ['Risk per trade', `${limits.riskPctPerTrade}% of equity`],
    ['Max per order', money(limits.maxNotionalPerOrder)],
    ['Max open positions', limits.maxOpenPositions],
    ['Max spread', `${limits.maxSpreadBps} bps`],
    ['No entries within', `${limits.minMinutesToClose} min of close`],
    ['Target', `${limits.targetRMultiple}R`],
  ];
  $('limits').innerHTML = rows
    .map(([k, v]) => `<div class="log__row"><span>${escapeHtml(k)}</span><span class="num">${escapeHtml(String(v))}</span></div>`)
    .join('');
}

function render() {
  if (!state?.analysis) return;
  const data = state.analysis;
  const meta = { ageSeconds: state.ageSeconds, stale: state.stale };

  renderRail(data, meta);
  renderBanners(data, meta);
  renderPositions(data.positions);
  renderLog(state.trades || []);
  renderLimits(data.limits);

  const tradeable = data.candidates.filter((c) => c.action === 'TRADEABLE').length;
  $('candidateSummary').textContent = `${tradeable} tradeable · ${data.candidates.length} scanned · ${data.tookMs}ms`;

  $('rows').innerHTML = data.candidates.map((c) => renderRow(c, data.limits)).join('');
  $('footnote').textContent =
    `Scores are computed from ${data.dataFeed.toUpperCase()} price and volume; the written reasoning comes from a language model reading headlines and cannot move the score by more than 12 points. Nothing here is advice, and a backtest was never run — treat every number as a prompt to look closer, not a verdict.`;

  startCountdown(data.session);
}

/* --- countdown ------------------------------------------------------------ */
function startCountdown(session) {
  clearInterval(countdownTimer);
  const close = new Date(session.close).getTime();

  const tick = () => {
    const remaining = close - Date.now();
    if (!session.isCurrent || remaining <= 0) {
      $('countdown').textContent = 'closed';
      clearInterval(countdownTimer);
      return;
    }
    const totalMinutes = Math.floor(remaining / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const seconds = Math.floor((remaining % 60000) / 1000);
    $('countdown').textContent = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

/* --- network -------------------------------------------------------------- */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function rememberOpenRows() {
  openRows.clear();
  document.querySelectorAll('details.row[open]').forEach((el) => openRows.add(el.dataset.symbol));
}

async function loadState({ reanalyze = false } = {}) {
  const button = $('refreshBtn');
  rememberOpenRows();
  button.disabled = true;
  button.textContent = reanalyze ? 'Analysing…' : 'Loading…';

  try {
    state = reanalyze ? await api('/api/analyze', { method: 'POST' }) : await api('/api/state');
    render();
    announce(reanalyze ? 'Analysis refreshed.' : 'Loaded.');
  } catch (error) {
    $('banners').innerHTML = `<div class="banner banner--bad"><strong>Could not load.</strong> ${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh analysis';
  }
}

const announce = (message) => { $('liveRegion').textContent = message; };

function showBlockers(symbol, blockers, warnings) {
  const el = document.querySelector(`[data-blockers="${symbol}"]`);
  if (!el) return;
  el.innerHTML = [
    ...blockers.map((b) => `<li>✕ ${escapeHtml(b)}</li>`),
    ...warnings.map((w) => `<li class="is-warning">! ${escapeHtml(w)}</li>`),
  ].join('');
}

async function handleExecute(symbol, button) {
  const note = document.querySelector(`[data-execute-note="${symbol}"]`);
  button.disabled = true;

  try {
    if (!pendingConfirm.get(symbol)) {
      button.innerHTML = '<span class="spinner"></span> Checking…';
      const preview = await api('/api/preview', { method: 'POST', body: JSON.stringify({ symbol }) });
      showBlockers(symbol, preview.blockers, preview.warnings);

      if (!preview.allowed) {
        button.textContent = 'Blocked';
        note.textContent = 'The risk guard refused this trade for the reasons above.';
        setTimeout(() => {
          button.textContent = 'Check & execute';
          button.disabled = false;
        }, 2500);
        return;
      }

      pendingConfirm.set(symbol, preview.plan);
      button.textContent = `Confirm — buy ${preview.plan.qty} ${symbol} @ market`;
      note.textContent = `Bracket order: stop ${preview.plan.stopPrice}, target ${preview.plan.takeProfitPrice}, ${money(preview.plan.riskDollars)} at risk. Click again to send.`;
      button.disabled = false;

      // The confirmation expires so a stale plan cannot be fired later.
      setTimeout(() => {
        if (pendingConfirm.delete(symbol)) {
          button.textContent = 'Check & execute';
          note.textContent = 'Confirmation expired — check again.';
        }
      }, 20000);
      return;
    }

    button.innerHTML = '<span class="spinner"></span> Sending…';
    const result = await api('/api/trade', { method: 'POST', body: JSON.stringify({ symbol, confirm: true }) });
    pendingConfirm.delete(symbol);

    button.textContent = `Sent · order ${String(result.order.id).slice(0, 8)}`;
    note.textContent = `${result.plan.qty} shares submitted with a bracket.`;
    announce(`Order submitted for ${symbol}.`);
    showBlockers(symbol, [], result.warnings || []);
    setTimeout(() => loadState(), 1500);
  } catch (error) {
    pendingConfirm.delete(symbol);
    const payload = error.payload || {};
    showBlockers(symbol, payload.blockers || [error.message], payload.warnings || []);
    button.textContent = 'Check & execute';
    button.disabled = false;
    note.textContent = 'Nothing was sent.';
  }
}

/* --- events --------------------------------------------------------------- */
document.addEventListener('click', async (event) => {
  const executeBtn = event.target.closest('[data-execute]');
  if (executeBtn) {
    event.preventDefault();
    await handleExecute(executeBtn.dataset.execute, executeBtn);
    return;
  }

  const closeBtn = event.target.closest('[data-close]');
  if (closeBtn) {
    const symbol = closeBtn.dataset.close;
    if (!confirm(`Close the entire ${symbol} position at market?`)) return;
    closeBtn.disabled = true;
    try {
      await api(`/api/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' });
      announce(`${symbol} close submitted.`);
      await loadState();
    } catch (error) {
      alert(`Could not close ${symbol}: ${error.message}`);
      closeBtn.disabled = false;
    }
  }
});

$('refreshBtn').addEventListener('click', () => loadState({ reanalyze: true }));

$('flattenBtn').addEventListener('click', async () => {
  if (!confirm('Close every open position at market?')) return;
  try {
    await api('/api/flatten', { method: 'POST' });
    announce('Flatten submitted.');
    await loadState();
  } catch (error) {
    alert(`Flatten failed: ${error.message}`);
  }
});

$('autoToggle').addEventListener('click', (event) => {
  autoRefresh = !autoRefresh;
  const button = event.currentTarget;
  button.textContent = autoRefresh ? 'Auto on' : 'Auto off';
  button.setAttribute('aria-pressed', String(autoRefresh));

  clearInterval(autoTimer);
  if (autoRefresh) {
    autoTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && state?.analysis?.session?.isCurrent) {
        loadState({ reanalyze: true });
      }
    }, 180000);
  }
});

// Storage throws outright in some embedded contexts, so never let a theme
// preference take the rest of the script down with it.
const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* preference is not persisted */ }
  },
};

$('themeToggle').addEventListener('click', () => {
  const current =
    document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  storage.set('apace-theme', next);
});

document.addEventListener('toggle', (event) => {
  const row = event.target.closest('details.row');
  if (!row) return;
  if (row.open) openRows.add(row.dataset.symbol);
  else openRows.delete(row.dataset.symbol);
}, true);

const savedTheme = storage.get('apace-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

loadState();
setInterval(() => {
  if (state && document.visibilityState === 'visible') {
    state.ageSeconds += 5;
    state.stale = state.ageSeconds > (state.analysis?.limits?.maxAnalysisAgeSeconds ?? 600);
    $('analysedAt').textContent = `${clockTime(state.analysis.generatedAt)} · ${state.ageSeconds}s`;
  }
}, 5000);
