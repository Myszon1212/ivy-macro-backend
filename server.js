const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
    limits: { fileSize: 15 * 1024 * 1024 } // limit 15 MB
});

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
let REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
if (REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// 1. Health check & status
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        authenticated: Boolean(REFRESH_TOKEN),
        folderId: FOLDER_ID,
        service: 'Ivy Macro Cloud'
    });
});

// 2. Interaktywna autoryzacja przez przegladarke (/auth)
app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/drive.file']
    });
    res.redirect(authUrl);
});

// 3. Callback autoryzacji Google (/oauth2callback)
app.get('/oauth2callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send('Brak kodu autoryzacji.');

        const { tokens } = await oauth2Client.getToken(code);
        REFRESH_TOKEN = tokens.refresh_token;
        oauth2Client.setCredentials(tokens);

        try {
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
                let env = fs.readFileSync(envPath, 'utf8');
                if (env.includes('GOOGLE_REFRESH_TOKEN=')) {
                    env = env.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${REFRESH_TOKEN}`);
                } else {
                    env += `\nGOOGLE_REFRESH_TOKEN=${REFRESH_TOKEN}\n`;
                }
                fs.writeFileSync(envPath, env, 'utf8');
            }
        } catch (_) {}

        res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 60px;">
                <h1 style="color: #2e7d32;">Autoryzacja udana! 🎉</h1>
                <p>Twój Dysk Google (5 TB) został pomyślnie podłączony do serwera makr.</p>
                <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; display: inline-block; margin-top: 20px;">
                    <b>Twój Refresh Token:</b><br/>
                    <code style="word-break: break-all; color: #d32f2f;">${REFRESH_TOKEN}</code>
                </div>
                <p style="margin-top: 20px; color: #666;">Możesz zamknąć tę kartę.</p>
            </div>
        `);
        console.log('[Auth] Zalogowano pomyślnie! Refresh Token zapisany.');
    } catch (err) {
        res.status(500).send('Błąd podczas pobierania tokena: ' + err.message);
    }
});

// 4. Lista makr
app.get('/api/macros', async (req, res) => {
    try {
        if (!REFRESH_TOKEN) {
            return res.status(500).json({ error: 'Serwer nie jest jeszcze zautoryzowany z Dyskiem Google.' });
        }

        const query = `'${FOLDER_ID}' in parents and trashed = false`;
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, size, createdTime, description, appProperties)',
            orderBy: 'createdTime desc',
            pageSize: 100,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        const files = (response.data.files || []).map(f => {
            const props = f.appProperties || {};
            return {
                id: f.id,
                name: f.name.replace(/\.ivy3$/i, ''),
                filename: f.name,
                size: parseInt(f.size || '0', 10),
                createdTime: f.createdTime,
                tps: props.tps || '240',
                author: props.author || 'Anonim'
            };
        });

        res.json({ success: true, macros: files });
    } catch (err) {
        console.error('[Error /api/macros]', err.message);
        res.status(500).json({ error: 'Błąd pobierania makr: ' + err.message });
    }
});

// 5. Wrzucanie makra z moda
app.post('/api/macros/upload', upload.single('macro_file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Brak pliku makra.' });
        }

        const rawName = (req.body.name || req.file.originalname || 'macro').trim();
        const safeName = rawName.endsWith('.ivy3') ? rawName : `${rawName}.ivy3`;
        const tps = (req.body.tps || '240').trim();
        const author = (req.body.author || 'Anonim').trim();
        const deleteToken = crypto.randomBytes(16).toString('hex');

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        console.log(`[Upload] Wrzucanie "${safeName}" (TPS: ${tps}, Autor: ${author})...`);

        const response = await drive.files.create({
            requestBody: {
                name: safeName,
                parents: [FOLDER_ID],
                description: `Ivy Macro | TPS: ${tps} | Author: ${author}`,
                appProperties: {
                    tps: tps,
                    author: author,
                    deleteToken: deleteToken
                }
            },
            media: {
                mimeType: 'application/octet-stream',
                body: bufferStream
            },
            fields: 'id, name',
            supportsAllDrives: true
        });

        console.log(`[Upload] Zapisano! ID: ${response.data.id}`);

        res.json({
            success: true,
            id: response.data.id,
            name: safeName,
            deleteToken: deleteToken
        });
    } catch (err) {
        console.error('[Error /api/macros/upload]', err.message);
        res.status(500).json({ error: 'Błąd zapisu na Dysku Google: ' + err.message });
    }
});

// 6. Usuwanie makra (tylko przez autora posiadajacego token)
app.post('/api/macros/delete/:id', async (req, res) => {
    try {
        const fileId = req.params.id;
        const deleteToken = req.body.deleteToken;

        const file = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, appProperties',
            supportsAllDrives: true
        });

        const storedToken = file.data.appProperties?.deleteToken;
        if (storedToken && storedToken !== deleteToken) {
            return res.status(403).json({ error: 'Brak uprawnień do usunięcia tego makra.' });
        }

        await drive.files.delete({
            fileId: fileId,
            supportsAllDrives: true
        });

        console.log(`[Delete] Usunięto makro ID: ${fileId} (${file.data.name})`);
        res.json({ success: true, id: fileId });
    } catch (err) {
        console.error('[Error /api/macros/delete]', err.message);
        res.status(500).json({ error: 'Błąd usuwania makra: ' + err.message });
    }
});

// 7. Pobieranie pliku makra
app.get('/api/macros/download/:id', async (req, res) => {
    try {
        const fileId = req.params.id;

        const meta = await drive.files.get({
            fileId: fileId,
            fields: 'id, name',
            supportsAllDrives: true
        });

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.data.name)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        const fileStream = await drive.files.get(
            { fileId: fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream' }
        );

        fileStream.data.pipe(res);
    } catch (err) {
        console.error('[Error /api/macros/download]', err.message);
        res.status(500).json({ error: 'Błąd pobierania pliku: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Ivy Macro Server dziala na porcie ${PORT}`);
});
