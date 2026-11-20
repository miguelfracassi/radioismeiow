const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), multer = require('multer');
const { WebSocketServer } = require('ws');
const PASS = process.env.CONTROL_PASSWORD || '2015', PORT = process.env.PORT || 3000;
const app = express(), server = http.createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
fs.mkdirSync('uploads', { recursive: true });

let db = { playlist: [], index: 0, playing: false, startedAt: 0 };
try { db = { ...db, ...JSON.parse(fs.readFileSync('data.json')) }; } catch {}
const save = () => fs.writeFileSync('data.json', JSON.stringify(db));
const rid = () => Math.random().toString(36).slice(2, 10);
const upl = multer({ storage: multer.diskStorage({ destination: 'uploads', filename: (q, f, cb) => cb(null, rid() + path.extname(f.originalname)) }) });

const listeners = () => [...wss.clients].filter(c => c.role === 'listener').length;
const state = () => ({
  playing: db.playing && !!db.playlist[db.index], track: db.playlist[db.index] || null,
  startedAt: db.startedAt, pos: Math.max(0, (Date.now() - db.startedAt) / 1000),
  listeners: listeners(), playlist: db.playlist, index: db.index
});
const push = () => { const s = JSON.stringify(state()); wss.clients.forEach(c => c.readyState === 1 && c.send(s)); };
const go = i => {
  const n = db.playlist.length;
  if (!n) { db.playing = false; return; }
  db.index = ((i % n) + n) % n; db.startedAt = Date.now(); db.playing = true;
};

wss.on('connection', ws => {
  ws.on('message', m => {
    try {
      const d = JSON.parse(m);
      if (d.t === 'hello') { ws.role = d.role; push(); }
      if (d.t === 'ended' && db.playing && db.playlist[db.index]?.id === d.id && Date.now() - db.startedAt > 3000) { go(db.index + 1); save(); push(); }
    } catch {}
  });
  ws.on('close', push);
  ws.send(JSON.stringify(state()));
});

async function oembed(u) { try { return await (await fetch(u)).json(); } catch { return {}; } }
async function meta(url = '') {
  let m;
  if ((m = url.match(/(?:youtu\.be\/|[?&]v=|shorts\/)([\w-]{11})/))) {
    const id = m[1], link = 'https://www.youtube.com/watch?v=' + id;
    const o = await oembed('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(link));
    return { kind: 'youtube', ref: id, link, title: o.title, artist: o.author_name, cover: o.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }
  if ((m = url.match(/open\.spotify\.com\/(?:intl-\w+\/)?(track|episode)\/(\w+)/))) {
    const link = `https://open.spotify.com/${m[1]}/${m[2]}`;
    const o = await oembed('https://open.spotify.com/oembed?url=' + encodeURIComponent(link));
    return { kind: 'spotify', ref: `spotify:${m[1]}:${m[2]}`, link, title: o.title, cover: o.thumbnail_url };
  }
  if (/^https?:\/\/.+\.(mp3|ogg|wav|m4a|aac)(\?|$)/i.test(url)) return { kind: 'file', src: url, link: url, title: url.split('/').pop().split('?')[0] };
  throw new Error('Link não reconhecido. Use música do YouTube, do Spotify ou link direto de áudio.');
}

const auth = (q, r, n) => q.headers['x-password'] === PASS ? n() : r.status(401).json({ error: 'Senha incorreta' });
app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));
app.get('/controlroom', (q, r) => r.sendFile(path.join(__dirname, 'public/controlroom.html')));

app.post('/api/cmd', auth, upl.single('file'), async (q, r) => {
  try {
    const b = q.body, P = db.playlist;
    switch (b.cmd) {
      case 'add': {
        const t = q.file
          ? { kind: 'file', src: '/uploads/' + q.file.filename, title: q.file.originalname.replace(/\.\w+$/, '') }
          : await meta(b.url);
        P.push({ id: rid(), ...t, title: b.title || t.title || 'Sem título', artist: b.artist || t.artist || '' });
        break;
      }
      case 'remove': {
        const i = P.findIndex(x => x.id === b.id); if (i < 0) break;
        const wasCur = i === db.index; P.splice(i, 1);
        if (i < db.index) db.index--;
        if (wasCur && db.playing) go(db.index);
        break;
      }
      case 'move': {
        const i = P.findIndex(x => x.id === b.id), j = i + Number(b.dir);
        if (i < 0 || j < 0 || j >= P.length) break;
        const cur = P[db.index]?.id; [P[i], P[j]] = [P[j], P[i]];
        db.index = Math.max(0, P.findIndex(x => x.id === cur));
        break;
      }
      case 'play': go(Number(b.index)); break;
      case 'start': go(db.index); break;
      case 'stop': db.playing = false; break;
      case 'next': go(db.index + 1); break;
      case 'prev': go(db.index - 1); break;
    }
    save(); push(); r.json({ ok: 1 });
  } catch (e) { r.status(400).json({ error: e.message }); }
});

server.listen(PORT, () => console.log(`Rádio do Clube em http://localhost:${PORT}  |  painel: /controlroom`));
