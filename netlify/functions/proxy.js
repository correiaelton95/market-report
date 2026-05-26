exports.handler = async function(event) {
  const ticker = event.queryStringParameters?.ticker;
  if(!ticker) return { statusCode:400, body: JSON.stringify({error:"Missing ticker"}) };
  const safe = ticker.replace(/[^a-zA-Z0-9.\-^]/g,'');
  if(!safe) return { statusCode:400, body: JSON.stringify({error:"Invalid ticker"}) };
  const url = `https://stooq.com/q/d/l/?s=${safe}&i=d`;
  try {
    const res = await fetch(url);
    if(!res.ok) return { statusCode:res.status, body: JSON.stringify({error:`Stooq ${res.status}`}) };
    const text = await res.text();
    return {
      statusCode:200,
      headers:{
        "Content-Type":"text/plain",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"public, max-age=3600"
      },
      body:text
    };
  } catch(e) {
    return { statusCode:500, body: JSON.stringify({error:e.message}) };
  }
};
