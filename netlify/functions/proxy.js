exports.handler = async function(event) {
  const ticker = event.queryStringParameters?.ticker;
  if(!ticker) return { statusCode:400, body: JSON.stringify({error:"Missing ticker"}) };

  const safe = ticker.replace(/[^a-zA-Z0-9.\-^%]/g,'').toUpperCase();
  if(!safe) return { statusCode:400, body: JSON.stringify({error:"Invalid ticker"}) };

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${safe}?interval=1d&range=20y`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; market-report/1.0)",
        "Accept": "application/json"
      }
    });
    if(!res.ok) return { statusCode:res.status, body: JSON.stringify({error:`Yahoo ${res.status}`}) };
    const j = await res.json();
    const result = j?.chart?.result?.[0];
    if(!result) return { statusCode:404, body: JSON.stringify({error:"No data for "+safe}) };

    const timestamps = result.timestamp;
    const closes = result.indicators?.quote?.[0]?.close;
    if(!timestamps||!closes) return { statusCode:404, body: JSON.stringify({error:"Missing price data"}) };

    const lines = ["date,close"];
    timestamps.forEach((ts,i) => {
      const close = closes[i];
      if(close===null||close===undefined) return;
      const date = new Date(ts*1000).toISOString().split("T")[0];
      lines.push(`${date},${close}`);
    });

    return {
      statusCode:200,
      headers:{
        "Content-Type":"text/plain",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"public, max-age=3600"
      },
      body: lines.join("\n")
    };
  } catch(e) {
    return { statusCode:500, body: JSON.stringify({error:e.message}) };
  }
};
