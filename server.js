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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Audio files only'));
  }
});

// ── AUTH ──
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  res.json({ ok: password === ADMIN_PASSWORD });
});

// ── GET TRACKS ──
app.get('/api/tracks', async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('', {
      limit: 1000,
      sortBy: { column: 'created_at', order: 'desc' }
    });

    if (error) throw error;

    const tracks = data
      .filter(f => f.name && !f.name.startsWith('.') && !f.name.endsWith('.json'))
      .map(f => {
        // Try to get metadata from sidecar JSON
        let meta = null;
        try {
          // metadata stored as filename.json in bucket metadata
        } catch(e) {}

        const rawName = f.name.replace(/\.[^/.]+$/, '');
        let title = rawName, artist = 'Unknown Artist', album = '', duration = 0;

        // Parse filename as fallback: "Artist - Title"
        if (rawName.includes(' - ')) {
          const parts = rawName.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }

        // Use stored metadata if available
        if (f.metadata) {
          if (f.metadata.title) title = f.metadata.title;
          if (f.metadata.artist) artist = f.metadata.artist;
          if (f.metadata.album) album = f.metadata.album;
          if (f.metadata.duration) duration = f.metadata.duration;
        }

        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(f.name);
        return {
          id: f.id || f.name,
          title,
          artist,
          album,
          duration,
          name: f.name,
          added: f.created_at,
          streamUrl: urlData.publicUrl
        };
      });

    res.json(tracks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tracks' });
  }
});

// ── UPLOAD (reads ID3 tags) ──
app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let uploaded = 0;
    const results = [];

    for (const file of req.files) {
      // Parse ID3 tags from buffer
      let title = file.originalname.replace(/\.[^/.]+$/, '');
      let artist = 'Unknown Artist';
      let album = '';
      let duration = 0;

      try {
        const metadata = await mm.parseBuffer(file.buffer, { mimeType: file.mimetype });
        const tags = metadata.common;
        const format = metadata.format;
        if (tags.title) title = tags.title;
        if (tags.artist) artist = tags.artist;
        if (tags.album) album = tags.album;
        if (format.duration) duration = Math.round(format.duration);
      } catch (e) {
        // fallback: parse filename
        const rawName = file.originalname.replace(/\.[^/.]+$/, '');
        if (rawName.includes(' - ')) {
          const parts = rawName.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }
      }

      // Upload audio file
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(file.originalname, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });

      if (!uploadError) {
        // Store metadata as a sidecar JSON file
        const metaJson = JSON.stringify({ title, artist, album, duration });
        await supabase.storage
          .from(BUCKET)
          .upload(file.originalname + '.meta.json', Buffer.from(metaJson), {
            contentType: 'application/json',
            upsert: true
          });
        uploaded++;
        results.push({ title, artist, album, duration });
      }
    }

    res.json({ ok: true, uploaded, tracks: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── GET METADATA for a file ──
app.get('/api/meta/:filename', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filename + '.meta.json');
    if (error) return res.json({});
    const text = await data.text();
    res.json(JSON.parse(text));
  } catch (err) {
    res.json({});
  }
});

// ── GET ALL TRACKS WITH METADATA ──
app.get('/api/tracks/full', async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('', {
      limit: 1000,
      sortBy: { column: 'created_at', order: 'desc' }
    });

    if (error) throw error;

    const audioFiles = data.filter(f => f.name && !f.name.startsWith('.') && !f.name.includes('.meta.json'));
    const metaFiles = data.filter(f => f.name && f.name.endsWith('.meta.json'));

    const tracks = await Promise.all(audioFiles.map(async f => {
      const rawName = f.name.replace(/\.[^/.]+$/, '');
      let title = rawName, artist = 'Unknown Artist', album = '', duration = 0;

      if (rawName.includes(' - ')) {
        const parts = rawName.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      // Check for sidecar metadata
      const metaFile = metaFiles.find(m => m.name === f.name + '.meta.json');
      if (metaFile) {
        try {
          const { data: metaData } = await supabase.storage.from(BUCKET).download(f.name + '.meta.json');
          const text = await metaData.text();
          const meta = JSON.parse(text);
          if (meta.title) title = meta.title;
          if (meta.artist) artist = meta.artist;
          if (meta.album) album = meta.album;
          if (meta.duration) duration = meta.duration;
        } catch(e) {}
      }

      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(f.name);
      return {
        id: f.id || f.name,
        title,
        artist,
        album,
        duration,
        name: f.name,
        added: f.created_at,
        streamUrl: urlData.publicUrl
      };
    }));

    res.json(tracks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tracks' });
  }
});

// ── DELETE ──
app.delete('/api/tracks/:filename', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const filename = decodeURIComponent(req.params.filename);
    await supabase.storage.from(BUCKET).remove([filename, filename + '.meta.json']);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.listen(PORT, () => console.log(`WaveBox running on port ${PORT}`));
