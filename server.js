require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GOOGLE AUTH ──
function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ── MULTER (memory storage) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Audio files only'));
  }
});

// ── AUTH CHECK ──
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// ── GET TRACKS ──
app.get('/api/tracks', async (req, res) => {
  try {
    const drive = getDrive();
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType contains 'audio/' and trashed = false`,
      fields: 'files(id, name, size, createdTime, mimeType)',
      orderBy: 'createdTime desc',
      pageSize: 1000,
    });

    const files = response.data.files.map(f => {
      const rawName = f.name.replace(/\.[^/.]+$/, '');
      let title = rawName, artist = 'Unknown Artist';
      if (rawName.includes(' - ')) {
        const parts = rawName.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
      return {
        id: f.id,
        title,
        artist,
        name: f.name,
        size: f.size,
        added: f.createdTime,
        streamUrl: `/api/stream/${f.id}`,
      };
    });

    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tracks' });
  }
});

// ── STREAM TRACK ──
app.get('/api/stream/:fileId', async (req, res) => {
  try {
    const drive = getDrive();
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType, size, name' });
    const mimeType = meta.data.mimeType || 'audio/mpeg';
    const fileSize = parseInt(meta.data.size);

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]);
      const end = parts[1] ? parseInt(parts[1]) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });

      const streamRes = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      streamRes.data.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });
      const streamRes = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      streamRes.data.pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// ── UPLOAD TRACK ──
app.post('/api/upload', upload.array('files'), async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const drive = getDrive();
    const results = [];

    for (const file of req.files) {
      const stream = Readable.from(file.buffer);
      const response = await drive.files.create({
        requestBody: {
          name: file.originalname,
          parents: [FOLDER_ID],
        },
        media: {
          mimeType: file.mimetype,
          body: stream,
        },
        fields: 'id, name',
      });
      results.push(response.data);
    }

    res.json({ ok: true, uploaded: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── DELETE TRACK ──
app.delete('/api/tracks/:fileId', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const drive = getDrive();
    await drive.files.delete({ fileId: req.params.fileId });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.listen(PORT, () => console.log(`WaveBox running on port ${PORT}`));
