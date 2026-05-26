// GitHub Action script — runs server-side, no CORS issues
// Fetches Yahoo Finance data for all tickers and bakes into index.html

const https = require('https');
const fs = require('fs');

const TICKERS = [
  'XLK','XLV','XLF','XLE','XLY','XLP','XLI','XLB','XLRE','XLU','XLC',
  'SPY','QQQ','DIA','IWM',
  'VEU','EEM','VGK','VPL',
  'GLD','SLV','USO','COPA','DJP',
  '%5EVIX'  // VIX
];

// FRED tickers for UMCSENT
const FRED_SERIES = ['UMCSENT'];

function fetchUrl(url) {
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=20y`;
  const res = await fetchUrl(url);
  if(res.status !== 200) throw new Error(`HTTP ${res.status} for ${ticker}`);
  const j = JSON.parse(res.body);
  const result = j?.chart?.result?.[0];
  if(!result) throw new Error(`No data for ${ticker}`);
  const timestamps = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  if(!timestamps || !closes) throw new Error(`Missing prices for ${ticker}`);
  const pairs = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    close: closes[i]
  })).filter(p => p.close !== null && p.close !== undefined);
  return pairs;
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
  console.log(`Starting price update: ${new Date().toISOString()}`);

  // Read current index.html
  const html = fs.readFileSync('index.html', 'utf8');

  // Find the BAKED_PRICES_START marker
  const startMarker = '// BAKED_PRICES_START';
  const endMarker = '// BAKED_PRICES_END';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);

  if(startIdx === -1 || endIdx === -1) {
    console.error('ERROR: Could not find BAKED_PRICES_START/END markers in index.html');
    console.error('Run the Chart tab fetch manually first to bake initial data');
    process.exit(1);
  }

  // Extract existing baked data to get master dates
  const existingSection = html.slice(startIdx, endIdx);
  let existingData = null;
  try {
    const match = existingSection.match(/return\s+({[\s\S]+?});\s*$/m);
    if(match) existingData = JSON.parse(match[1]);
  } catch(e) {
    console.log('No existing baked data found, will create fresh');
  }

  const priceData = {};
  let masterDates = existingData?._dates || null;

  // Fetch all tickers
  for(const ticker of TICKERS) {
    const displayTicker = ticker.replace('%5E', '^');
    try {
      console.log(`Fetching ${displayTicker}...`);
      const pairs = await fetchYahoo(ticker);
      const key = displayTicker === '^VIX' ? 'VIX' : ticker;
      const dates = pairs.map(p => p.date);
      const prices = pairs.map(p => p.close);

      // Use SPY dates as master
      if(ticker === 'SPY' || !masterDates || dates.length > masterDates.length) {
        masterDates = dates;
      }

      priceData[key] = { dates, prices };
      console.log(`  ✓ ${displayTicker}: ${pairs.length} days`);

      // Small delay to be polite
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.warn(`  ✗ ${displayTicker}: ${e.message}`);
    }
  }

  // Fetch UMCSENT from FRED
  try {
    console.log('Fetching UMCSENT from FRED...');
    const fred = await fetchFRED('UMCSENT');
    priceData['UMCSENT'] = { dates: fred.dates, prices: fred.values };
    console.log(`  ✓ UMCSENT: ${fred.dates.length} months`);
  } catch(e) {
    console.warn(`  ✗ UMCSENT: ${e.message}`);
  }

  if(!masterDates) {
    console.error('ERROR: No master dates available');
    process.exit(1);
  }

  // Align all series to master dates
  const aligned = { _dates: masterDates };
  for(const [key, { dates, prices }] of Object.entries(priceData)) {
    const dateMap = {};
    dates.forEach((d, i) => { dateMap[d] = prices[i]; });

    if(key === 'UMCSENT') {
      // Forward-fill monthly data to daily
      let lastVal = null;
      aligned[key] = masterDates.map(d => {
        if(dateMap[d] !== undefined) lastVal = dateMap[d];
        return lastVal;
      });
    } else {
      aligned[key] = masterDates.map(d => dateMap[d] ?? null);
    }
  }

  // Bake into index.html
  const priceJson = JSON.stringify(aligned);
  const newSection = `${startMarker}\n    return ${priceJson};\n    ${endMarker}`;
  const newHtml = html.slice(0, startIdx) + newSection + html.slice(endIdx + endMarker.length);

  fs.writeFileSync('index.html', newHtml, 'utf8');

  const tickers = Object.keys(aligned).filter(k => !k.startsWith('_'));
  const lastDate = masterDates[masterDates.length - 1];
  console.log(`\n✓ Done! Baked ${tickers.length} tickers, ${masterDates.length} dates, latest: ${lastDate}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
