require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const mm = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const BUCKET = 'WaveBox-music';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

const authCheck = (req, res, next) => {
  const pw = req.body.password || req.query.password;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── AUTH ──
app.post('/api/auth', (req, res) => res.json({ ok: req.body.password === ADMIN_PASSWORD }));

// ── HELPERS ──
function getPublicUrl(path) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function parseName(filename) {
  const rawName = filename.replace(/\.[^/.]+$/, '');
  let title = rawName, artist = 'Unknown Artist';
  if (rawName.includes(' - ')) {
    const parts = rawName.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }
  return { title, artist };
}

// ── GET TRACKS ──
app.get('/api/tracks/full', async (req, res) => {
  try {
    const [tracksRes, metaRes, artRes] = await Promise.all([
      supabase.storage.from(BUCKET).list('tracks', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } }),
      supabase.storage.from(BUCKET).list('meta', { limit: 2000 }),
      supabase.storage.from(BUCKET).list('track-art', { limit: 2000 }),
    ]);

    const audioFiles = (tracksRes.data || []).filter(f => f.name && !f.name.startsWith('.'));
    const metaFiles = new Set((metaRes.data || []).map(f => f.name));
    const artFiles = new Set((artRes.data || []).map(f => f.name.replace(/\.[^/.]+$/, '')));

    const tracks = await Promise.all(audioFiles.map(async f => {
      const fallback = parseName(f.name);
      let title = fallback.title, artist = fallback.artist, album = '', duration = 0;

      const metaKey = f.name + '.json';
      if (metaFiles.has(metaKey)) {
        try {
          const { data: mb } = await supabase.storage.from(BUCKET).download('meta/' + metaKey);
          const meta = JSON.parse(await mb.text());
          if (meta.title) title = meta.title;
          if (meta.artist) artist = meta.artist;
          if (meta.album) album = meta.album;
          if (meta.duration) duration = meta.duration;
        } catch(e) {}
      }

      // Check for track art
      const artKey = f.name.replace(/\.[^/.]+$/, '');
      let artUrl = null;
      if (artFiles.has(artKey)) {
        // find the actual file with extension
        const artFile = (artRes.data || []).find(a => a.name.startsWith(artKey + '.'));
        if (artFile) artUrl = getPublicUrl('track-art/' + artFile.name);
      }

      return {
        id: f.id || f.name,
        title, artist, album, duration,
        name: f.name,
        added: f.created_at,
        streamUrl: getPublicUrl('tracks/' + f.name),
        artUrl,
      };
    }));

    res.json(tracks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tracks' });
  }
});

// fallback
app.get('/api/tracks', async (req, res) => {
  try {
    const { data } = await supabase.storage.from(BUCKET).list('tracks', { limit: 1000 });
    const tracks = (data || []).filter(f => f.name && !f.name.startsWith('.')).map(f => {
      const { title, artist } = parseName(f.name);
      return { id: f.id || f.name, title, artist, album: '', duration: 0, name: f.name, added: f.created_at, streamUrl: getPublicUrl('tracks/' + f.name), artUrl: null };
    });
    res.json(tracks);
  } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

// ── UPLOAD TRACKS ──
app.post('/api/upload', upload.array('files'), authCheck, async (req, res) => {
  try {
    let uploaded = 0;
    for (const file of req.files) {
      if (!file.mimetype.startsWith('audio/')) continue;
      let { title, artist } = parseName(file.originalname);
      let album = '', duration = 0;
      try {
        const metadata = await mm.parseBuffer(file.buffer, { mimeType: file.mimetype });
        const tags = metadata.common;
        if (tags.title) title = tags.title;
        if (tags.artist) artist = tags.artist;
        if (tags.album) album = tags.album;
        if (metadata.format.duration) duration = Math.round(metadata.format.duration);

        // Extract embedded album art if present
        if (tags.picture && tags.picture.length > 0) {
          const pic = tags.picture[0];
          const artName = file.originalname.replace(/\.[^/.]+$/, '') + '.' + (pic.format.split('/')[1] || 'jpg');
          await supabase.storage.from(BUCKET).upload('track-art/' + artName, pic.data, { contentType: pic.format, upsert: true });
        }
      } catch(e) {}

      const { error } = await supabase.storage.from(BUCKET).upload('tracks/' + file.originalname, file.buffer, { contentType: file.mimetype, upsert: true });
      if (!error) {
        await supabase.storage.from(BUCKET).upload('meta/' + file.originalname + '.json', Buffer.from(JSON.stringify({ title, artist, album, duration })), { contentType: 'application/json', upsert: true });
        uploaded++;
      }
    }
    res.json({ ok: true, uploaded });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Upload failed' }); }
});

// ── UPLOAD TRACK ART (manual override) ──
app.post('/api/track-art', upload.single('image'), authCheck, async (req, res) => {
  const trackName = req.body.trackName;
  if (!trackName || !req.file) return res.status(400).json({ error: 'Missing data' });
  const ext = req.file.originalname.split('.').pop();
  const artName = trackName.replace(/\.[^/.]+$/, '') + '.' + ext;
  const { error } = await supabase.storage.from(BUCKET).upload('track-art/' + artName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ error: 'Failed' });
  res.json({ ok: true, url: getPublicUrl('track-art/' + artName) });
});

// ── UPLOAD ARTIST IMAGE ──
app.post('/api/artist-image', upload.single('image'), authCheck, async (req, res) => {
  const artistName = req.body.artist;
  if (!artistName || !req.file) return res.status(400).json({ error: 'Missing data' });
  const ext = req.file.originalname.split('.').pop();
  const filename = 'artist-images/' + artistName.replace(/[^a-zA-Z0-9]/g, '_') + '.' + ext;
  const { error } = await supabase.storage.from(BUCKET).upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (error) return res.status(500).json({ error: 'Failed' });
  res.json({ ok: true, url: getPublicUrl(filename) });
});

// ── GET ARTIST IMAGES ──
app.get('/api/artist-images', async (req, res) => {
  try {
    const { data } = await supabase.storage.from(BUCKET).list('artist-images', { limit: 500 });
    const images = {};
    (data || []).forEach(f => {
      const key = f.name.replace(/\.[^/.]+$/, '');
      images[key] = getPublicUrl('artist-images/' + f.name);
    });
    res.json(images);
  } catch(err) { res.json({}); }
});

// ── DELETE TRACK ──
app.delete('/api/tracks/:filename', authCheck, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const artBase = filename.replace(/\.[^/.]+$/, '');
    const { data: artFiles } = await supabase.storage.from(BUCKET).list('track-art');
    const artFile = (artFiles || []).find(f => f.name.startsWith(artBase + '.'));
    const toRemove = ['tracks/' + filename, 'meta/' + filename + '.json'];
    if (artFile) toRemove.push('track-art/' + artFile.name);
    await supabase.storage.from(BUCKET).remove(toRemove);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Delete failed' }); }
});

app.listen(PORT, () => console.log(`WaveBox running on port ${PORT}`));
