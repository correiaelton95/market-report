// GitHub Action script — runs server-side every Sunday
// Fetches Yahoo Finance + FRED data and writes prices.json to repo root

const https = require('https');
const fs = require('fs');

const SECTOR_STOCKS = {
  "XLK": ["AAPL","MSFT","NVDA","AVGO","ORCL"],
  "XLV": ["LLY","UNH","JNJ","ABBV","MRK"],
  "XLF": ["BRK-B","JPM","V","MA","BAC"],
  "XLE": ["XOM","CVX","COP","EOG","SLB"],
  "XLY": ["AMZN","TSLA","HD","MCD","NKE"],
  "XLP": ["WMT","PG","COST","KO","PEP"],
  "XLI": ["GE","CAT","UNP","RTX","HON"],
  "XLB": ["LIN","APD","SHW","FCX","NEM"],
  "XLRE": ["PLD","AMT","EQIX","SPG","O"],
  "XLU": ["NEE","SO","DUK","AEP","EXC"],
  "XLC": ["META","GOOGL","NFLX","DIS","CMCSA"],
};

const ALL_STOCKS = Object.values(SECTOR_STOCKS).flat();

const TICKERS = [
  'XLK','XLV','XLF','XLE','XLY','XLP','XLI','XLB','XLRE','XLU','XLC',
  'SPY','QQQ','DIA','IWM',
  'VEU','EEM','VGK','VPL',
  'GLD','SLV','USO','COPA','DJP',
  '%5EVIX',
  ...ALL_STOCKS
];

function fetchUrl(url, timeout=30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; market-report-updater/1.0)',
        'Accept': 'application/json,text/plain,*/*'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`Timeout after ${timeout/1000}s`)); });
  });
}

async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=20y`;
  const res = await fetchUrl(url);
  if(res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const j = JSON.parse(res.body);
  const result = j?.chart?.result?.[0];
  if(!result) throw new Error('No result');
  const timestamps = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  if(!timestamps || !closes) throw new Error('Missing data');
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    close: closes[i]
  })).filter(p => p.close !== null && p.close !== undefined);
}

async function fetchFRED(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
  const res = await fetchUrl(url);
  const lines = res.body.trim().split('\n').slice(1);
  const dates = [], values = [];
  lines.forEach(line => {
    const [date, val] = line.split(',');
    if(date && val && val.trim() !== '.') {
      dates.push(date.trim());
      values.push(parseFloat(val.trim()));
    }
  });
  return { dates, values };
}

async function main() {
  console.log(`\nMarket Report Price Updater — ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const rawPrices = {};
  let masterDates = null;

  // Fetch all equity tickers from Yahoo Finance
  for(const ticker of TICKERS) {
    const key = ticker === '%5EVIX' ? 'VIX' : ticker;
    try {
      process.stdout.write(`  Fetching ${key}... `);
      const pairs = await fetchYahoo(ticker);
      rawPrices[key] = { dates: pairs.map(p => p.date), prices: pairs.map(p => p.close) };
      if(key === 'SPY' || !masterDates || pairs.length > masterDates.length) {
        masterDates = pairs.map(p => p.date);
      }
      console.log(`✓ ${pairs.length} days (latest: ${pairs[pairs.length-1].date})`);
      await new Promise(r => setTimeout(r, 600));
    } catch(e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // Fetch UMCSENT from FRED
  try {
    process.stdout.write('  Fetching UMCSENT (FRED)... ');
    const fred = await fetchFRED('UMCSENT');
    rawPrices['UMCSENT'] = { dates: fred.dates, prices: fred.values, monthly: true };
    console.log(`✓ ${fred.dates.length} months`);
  } catch(e) {
    console.log(`✗ ${e.message}`);
  }

  if(!masterDates) {
    console.error('\nERROR: Could not establish master date range (SPY fetch failed)');
    process.exit(1);
  }

  console.log(`\nAligning ${Object.keys(rawPrices).length} series to ${masterDates.length} master dates...`);

  // Align all series to master dates
  const aligned = {
    _dates: masterDates,
    _updated: new Date().toISOString(),
    _tickers: Object.keys(rawPrices)
  };

  for(const [key, { dates, prices, monthly }] of Object.entries(rawPrices)) {
    const dateMap = {};
    dates.forEach((d, i) => { dateMap[d] = prices[i]; });

    if(monthly) {
      // Forward-fill monthly FRED data to daily
      let lastVal = null;
      aligned[key] = masterDates.map(d => {
        if(dateMap[d] !== undefined) lastVal = dateMap[d];
        return lastVal;
      });
    } else {
      aligned[key] = masterDates.map(d => dateMap[d] ?? null);
    }
  }

  // Fetch FRED macro data server-side (no CORS issues here)
  const macroData = await fetchMacroData();
  aligned._macro = macroData;
  aligned._sectorStocks = SECTOR_STOCKS;

  // Write prices.json
  const json = JSON.stringify(aligned);
  fs.writeFileSync('prices.json', json, 'utf8');

  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  const lastDate = masterDates[masterDates.length - 1];
  console.log(`\n✓ prices.json written — ${sizeMB}MB, ${masterDates.length} dates, latest: ${lastDate}`);
  console.log(`  Tickers: ${aligned._tickers.join(', ')}`);
}

main().catch(e => {
  console.error('\nFatal error:', e.message);
  process.exit(1);
});

// ── Fetch FRED macro data (runs server-side, no CORS issues) ─────────────────
async function fetchFREDSeries(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
  // Retry up to 3 times with increasing timeout
  for(let attempt = 0; attempt < 3; attempt++) {
    try {
      const timeout = (attempt + 1) * 60000; // 60s, 120s, 180s
      const res = await fetchUrl(url, timeout);
      if(res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const lines = res.body.trim().split('\n').slice(1);
      const dates = [], values = [];
      lines.forEach(line => {
        const [date, val] = line.split(',');
        if(date && val && val.trim() !== '.') {
          dates.push(date.trim());
          values.push(parseFloat(val.trim()));
        }
      });
      if(dates.length === 0) throw new Error('Empty response');
      return { dates, values };
    } catch(e) {
      console.log(`  ✗ ${seriesId} attempt ${attempt+1}: ${e.message}`);
      if(attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error(`Failed after 3 attempts`);
}

async function fetchMacroData() {
  console.log('\nFetching FRED macro data...');
  const macro = {};
  try {
    const cpi = await fetchFREDSeries('CPIAUCSL');
    if(cpi.values.length >= 13) {
      const latest = cpi.values[cpi.values.length-1];
      const yearAgo = cpi.values[cpi.values.length-13];
      const yoy = ((latest-yearAgo)/yearAgo*100).toFixed(1);
      const prev = cpi.values[cpi.values.length-2];
      const prevYearAgo = cpi.values[cpi.values.length-14];
      const prevYoy = ((prev-prevYearAgo)/prevYearAgo*100).toFixed(1);
      macro.cpi = `${yoy}% YoY`;
      macro.cpiDate = cpi.dates[cpi.dates.length-1];
      macro.cpiTrend = parseFloat(yoy) < parseFloat(prevYoy) ? '↓ cooling' : '↑ rising';
      macro.cpiPrev = `${prevYoy}%`;
      console.log(`  ✓ CPI: ${macro.cpi} (${macro.cpiTrend})`);
    }
  } catch(e) { console.log(`  ✗ CPI: ${e.message}`); }

  try {
    const fed = await fetchFREDSeries('FEDFUNDS');
    if(fed.values.length > 0) {
      macro.fedRate = `${fed.values[fed.values.length-1].toFixed(2)}%`;
      macro.fedDate = fed.dates[fed.dates.length-1];
      console.log(`  ✓ Fed Rate: ${macro.fedRate}`);
    }
  } catch(e) { console.log(`  ✗ Fed Rate: ${e.message}`); }

  try {
    const gdp = await fetchFREDSeries('A191RL1Q225SBEA');
    if(gdp.values.length > 0) {
      macro.gdp = `${gdp.values[gdp.values.length-1].toFixed(1)}% (annualized)`;
      macro.gdpDate = gdp.dates[gdp.dates.length-1];
      macro.gdpPrev = gdp.values[gdp.values.length-2].toFixed(1);
      console.log(`  ✓ GDP: ${macro.gdp}`);
    }
  } catch(e) { console.log(`  ✗ GDP: ${e.message}`); }

  return macro;
}
