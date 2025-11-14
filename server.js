const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUIRED_TOKEN = process.env.PROXY_TOKEN || '';

app.use(morgan('tiny'));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function checkToken(req, res) {
  if (!REQUIRED_TOKEN) return true;
  const token = req.query.token || req.headers['x-proxy-token'] || req.headers['authorization'];
  if (!token || token !== REQUIRED_TOKEN) {
    res.status(403).send('Forbidden: invalid or missing token');
    return false;
  }
  return true;
}

function safeDecodeUrl(u) {
  try { return decodeURIComponent(u); }
  catch (e) {
    try { return Buffer.from(u, 'base64').toString('utf8'); }
    catch (e2) { return null; }
  }
}

app.get('/proxy', async (req, res) => {
  if (!checkToken(req, res)) return;
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing url param');
  const target = safeDecodeUrl(raw);
  if (!target) return res.status(400).send('Invalid url');
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('Only http/https supported');

  const lower = target.split('?')[0].toLowerCase();
  const isM3U8 = lower.endsWith('.m3u8') || lower.endsWith('.m3u');

  try {
    if (isM3U8) {
      const resp = await axios.get(target, { responseType: 'text', timeout: 15000 });
      const playlist = resp.data.toString();

      let baseUrl;
      try {
        const u = new URL(target);
        u.pathname = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
        baseUrl = u.toString();
      } catch (e) { baseUrl = target; }

      const lines = playlist.split(/\r?\n/);
      const rewritten = lines.map((line) => {
        if (!line || line.startsWith('#')) return line;

        let absolute;
        try { absolute = new URL(line, baseUrl).toString(); }
        catch (e) { absolute = line; }

        const encoded = encodeURIComponent(absolute);
        const tokenPart = REQUIRED_TOKEN ? `&token=${REQUIRED_TOKEN}` : '';

        return `${req.protocol}://${req.get('host')}/proxy?url=${encoded}${tokenPart}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.status(200).send(rewritten);
    }

    else {
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;

      const resp = await axios({
        method: 'get',
        url: target,
        responseType: 'stream',
        headers,
        timeout: 20000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      if (resp.headers['content-type'])
        res.setHeader('Content-Type', resp.headers['content-type']);

      if (resp.headers['content-length'])
        res.setHeader('Content-Length', resp.headers['content-length']);

      if (resp.headers['accept-ranges'])
        res.setHeader('Accept-Ranges', resp.headers['accept-ranges']);

      res.status(resp.status);
      resp.data.pipe(res);
      resp.data.on('error', () => { try { res.end(); } catch(e){} });
    }

  } catch (err) {
    console.error('Proxy error', err?.message);
    return res.status(502).send('Bad gateway: ' + (err?.message || 'unknown error'));
  }
});

app.get('/', (req, res) => {
  res.send('Stream proxy running. Use /proxy?url=<encoded_url>');
});

app.listen(PORT, () => {
  console.log(`Proxy server running on ${PORT}`);
});
