# WaveBox 🌊

Personal music player. Upload from PC, stream anywhere.

## Setup Guide

### 1. Google Cloud Setup (Service Account)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (call it "WaveBox")
3. Go to **APIs & Services → Enable APIs** → enable **Google Drive API**
4. Go to **APIs & Services → Credentials → Create Credentials → Service Account**
5. Name it "wavebox", click through, then click the account you just made
6. Go to **Keys → Add Key → JSON** — download the file
7. Open the JSON file. You need:
   - `client_email` → this is your `GOOGLE_SERVICE_EMAIL`
   - `private_key` → this is your `GOOGLE_PRIVATE_KEY`

### 2. Google Drive Folder

1. Go to Google Drive
2. Create a folder called "WaveBox Music"
3. Right-click → Share → paste your `client_email` from above → give it **Editor** access
4. Click the folder, look at the URL: `drive.google.com/drive/folders/XXXXXXXX`
5. Copy that `XXXXXXXX` — that's your `GOOGLE_DRIVE_FOLDER_ID`

### 3. Deploy to Render

1. Go to [render.com](https://render.com) → sign up with GitHub
2. New → Web Service → connect your WaveBox repo
3. Settings:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add Environment Variables:
   - `ADMIN_PASSWORD` = whatever password you want
   - `GOOGLE_SERVICE_EMAIL` = from the JSON file
   - `GOOGLE_PRIVATE_KEY` = from the JSON file (include the full key with \n)
   - `GOOGLE_DRIVE_FOLDER_ID` = from step 2
5. Hit Deploy

### Usage

- **PC:** Go to your Render URL → enter password → upload music
- **Phone:** Go to same URL → skip login or just don't enter password → play everything
- Files named `Artist - Title.mp3` will auto-parse correctly
