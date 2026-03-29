require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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
      .filter(f => f.name && !f.name.startsWith('.'))
      .map(f => {
        const rawName = f.name.replace(/\.[^/.]+$/, '');
        let title = rawName, artist = 'Unknown Artist';
        if (rawName.includes(' - ')) {
          const parts = rawName.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }
        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(f.name);
        return {
          id: f.id || f.name,
          title,
          artist,
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

// ── UPLOAD ──
app.post('/api/upload', upload.array('files'), async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let uploaded = 0;
    for (const file of req.files) {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(file.originalname, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });
      if (!error) uploaded++;
    }
    res.json({ ok: true, uploaded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── DELETE ──
app.delete('/api/tracks/:filename', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const filename = decodeURIComponent(req.params.filename);
    const { error } = await supabase.storage.from(BUCKET).remove([filename]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.listen(PORT, () => console.log(`WaveBox running on port ${PORT}`));
