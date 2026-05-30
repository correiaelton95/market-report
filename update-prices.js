// GitHub Action script — runs server-side every Sunday
// Fetches Yahoo Finance + FRED data and writes prices.json to repo root

const https = require('https');
const fs = require('fs');

const TICKERS = [
  'XLK','XLV','XLF','XLE','XLY','XLP','XLI','XLB','XLRE','XLU','XLC',
  'SPY','QQQ','DIA','IWM',
  'VEU','EEM','VGK','VPL',
  'GLD','SLV','USO','COPA','DJP',
  '%5EVIX'
];

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
