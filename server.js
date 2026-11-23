const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
    limits: { fileSize: 15 * 1024 * 1024 }
});

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
let REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

let serviceAccountAuth = null;
let useServiceAccount = false;
const rawServiceAccount = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
if (rawServiceAccount) {
    try {
        const jsonText = rawServiceAccount.startsWith('{')
            ? rawServiceAccount
            : Buffer.from(rawServiceAccount, 'base64').toString('utf8');
        const credentials = JSON.parse(jsonText);
        serviceAccountAuth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive']
        });
        useServiceAccount = true;
    } catch (err) {
        console.error('[Auth] Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
    }
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
if (REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

function getHasAuth() {
    return useServiceAccount || Boolean(REFRESH_TOKEN);
}

const drive = google.drive({
    version: 'v3',
    auth: useServiceAccount ? serviceAccountAuth : oauth2Client
});

const FILE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const LIST_TTL_MS = 60 * 1000;
const LIST_STALE_MS = 300 * 1000;
const MAX_DOWNLOAD_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_CACHEABLE_FILE_BYTES = 4 * 1024 * 1024;

let authHealthy = getHasAuth();
let lastAuthError = authHealthy ? null : 'Brak konfiguracji autoryzacji Google Drive.';

const listCache = {
    macros: null,
    byId: new Map(),
    jsonBuf: null,
    gzipBuf: null,
    etag: null,
    updatedAt: 0
};
let listRefreshPromise = null;

const downloadCache = new Map();
let downloadCacheBytes = 0;

function markAuthOk() {
    authHealthy = true;
    lastAuthError = null;
}

function isAuthError(err) {
    if (!err) return false;
    const status = err.code || err.status || err.response?.status;
    if (status === 401) return true;
    const text = [
        err.message,
        err.response?.data?.error,
        err.response?.data?.error_description
    ]
        .filter(Boolean)
        .join(' ');
    return /invalid_grant|invalid_client|unauthorized_client|Token has been expired or revoked|No access, refresh token/i.test(text);
}

function handleDriveError(res, err, label) {
    console.error(`[Error ${label}]`, err.message);
    if (isAuthError(err)) {
        authHealthy = false;
        lastAuthError = err.message || 'invalid_grant';
        return res.status(503).json({
            error: 'Token Google Drive wygasl - otworz /auth na serwerze lub skonfiguruj Service Account.',
            code: 'TOKEN_EXPIRED',
            detail: err.message
        });
    }
    return res.status(500).json({ error: `${label}: ${err.message}` });
}

function updateListCache(macros) {
    const byId = new Map();
    for (const m of macros) {
        byId.set(m.id, m);
    }
    const jsonBuf = Buffer.from(JSON.stringify({ success: true, macros }));
    const gzipBuf = zlib.gzipSync(jsonBuf, { level: 6 });
    const etag = '"' + crypto.createHash('sha1').update(jsonBuf).digest('hex').slice(0, 16) + '"';
    listCache.macros = macros;
    listCache.byId = byId;
    listCache.jsonBuf = jsonBuf;
    listCache.gzipBuf = gzipBuf;
    listCache.etag = etag;
    listCache.updatedAt = Date.now();
}

async function refreshListCache(force) {
    if (!force && listCache.macros && Date.now() - listCache.updatedAt < LIST_TTL_MS) {
        return listCache.macros;
    }
    if (listRefreshPromise) return listRefreshPromise;

    listRefreshPromise = (async () => {
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

        markAuthOk();
        updateListCache(files);
        return files;
    })();

    try {
        return await listRefreshPromise;
    } finally {
        listRefreshPromise = null;
    }
}

function acceptsGzip(req) {
    return (req.headers['accept-encoding'] || '').toLowerCase().includes('gzip');
}

function sendListResponse(req, res) {
    if (req.headers['if-none-match'] === listCache.etag) {
        res.setHeader('ETag', listCache.etag);
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
        return res.status(304).end();
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('ETag', listCache.etag);
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.setHeader('Vary', 'Accept-Encoding');

    if (acceptsGzip(req)) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', listCache.gzipBuf.length);
        return res.end(listCache.gzipBuf);
    }
    res.setHeader('Content-Length', listCache.jsonBuf.length);
    return res.end(listCache.jsonBuf);
}

function getDownloadCache(id) {
    const entry = downloadCache.get(id);
    if (!entry) return null;
    downloadCache.delete(id);
    downloadCache.set(id, entry);
    return entry;
}

function deleteDownloadCache(id) {
    const entry = downloadCache.get(id);
    if (!entry) return;
    downloadCacheBytes -= entry.bytes;
    downloadCache.delete(id);
}

function putDownloadCache(id, name, buf) {
    if (!Buffer.isBuffer(buf) || buf.length > MAX_CACHEABLE_FILE_BYTES) return null;
    deleteDownloadCache(id);
    const gzipBuf = zlib.gzipSync(buf, { level: 6 });
    const entryBytes = buf.length + gzipBuf.length;
    while (downloadCache.size > 0 && downloadCacheBytes + entryBytes > MAX_DOWNLOAD_CACHE_BYTES) {
        const oldestKey = downloadCache.keys().next().value;
        deleteDownloadCache(oldestKey);
    }
    const entry = { name, buf, gzipBuf, bytes: entryBytes };
    if (downloadCacheBytes + entryBytes <= MAX_DOWNLOAD_CACHE_BYTES) {
        downloadCache.set(id, entry);
        downloadCacheBytes += entryBytes;
    }
    return entry;
}

function sendBinaryCached(req, res, entry) {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Vary', 'Accept-Encoding');

    if (acceptsGzip(req) && entry.gzipBuf && entry.gzipBuf.length < entry.buf.length) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', entry.gzipBuf.length);
        return res.end(entry.gzipBuf);
    }
    res.setHeader('Content-Length', entry.buf.length);
    return res.end(entry.buf);
}

app.get('/api/health', (req, res) => {
    const hasAuth = getHasAuth();
    res.json({
        status: 'online',
        authenticated: Boolean(hasAuth && authHealthy),
        authMode: useServiceAccount ? 'service_account' : 'oauth2',
        authError: lastAuthError,
        folderId: FOLDER_ID,
        cachedMacros: listCache.macros ? listCache.macros.length : 0,
        cacheAgeMs: listCache.updatedAt ? Date.now() - listCache.updatedAt : null,
        service: 'Ivy Macro Cloud'
    });
});

app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/drive.file']
    });
    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send('Brak kodu autoryzacji.');

        const { tokens } = await oauth2Client.getToken(code);
        if (tokens.refresh_token) {
            REFRESH_TOKEN = tokens.refresh_token;
        }
        oauth2Client.setCredentials(tokens);

        try {
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath) && REFRESH_TOKEN) {
                let env = fs.readFileSync(envPath, 'utf8');
                if (env.includes('GOOGLE_REFRESH_TOKEN=')) {
                    env = env.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${REFRESH_TOKEN}`);
                } else {
                    env += `\nGOOGLE_REFRESH_TOKEN=${REFRESH_TOKEN}\n`;
                }
                fs.writeFileSync(envPath, env, 'utf8');
            }
        } catch (_) {}

        markAuthOk();
        refreshListCache(true).catch(() => {});

        res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 60px;">
                <h1 style="color: #2e7d32;">Autoryzacja udana!</h1>
                <p>Twoj Dysk Google zostal pomyslnie podlaczony do serwera makr.</p>
                <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; display: inline-block; margin-top: 20px;">
                    <b>Twoj Refresh Token:</b><br/>
                    <code style="word-break: break-all; color: #d32f2f;">${REFRESH_TOKEN || '(zachowano poprzedni)'}</code>
                </div>
                <p style="margin-top: 20px; color: #666;">Mozesz zamknac te karte.</p>
            </div>
        `);
        console.log('[Auth] Zalogowano pomyslnie! Refresh Token zapisany.');
    } catch (err) {
        res.status(500).send('Blad podczas pobierania tokena: ' + err.message);
    }
});

app.get('/api/macros', async (req, res) => {
    if (!getHasAuth()) {
        return res.status(503).json({
            error: 'Serwer nie jest jeszcze zautoryzowany z Dyskiem Google.',
            code: 'TOKEN_EXPIRED'
        });
    }

    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const age = Date.now() - listCache.updatedAt;

    if (!force && listCache.macros) {
        if (age < LIST_TTL_MS) {
            return sendListResponse(req, res);
        }
        if (age < LIST_STALE_MS) {
            refreshListCache(false).catch(() => {});
            return sendListResponse(req, res);
        }
    }

    try {
        await refreshListCache(true);
        return sendListResponse(req, res);
    } catch (err) {
        if (listCache.macros && !isAuthError(err)) {
            console.warn('[Warn /api/macros] Serving stale cache after error:', err.message);
            return sendListResponse(req, res);
        }
        return handleDriveError(res, err, 'Blad pobierania makr');
    }
});

app.post('/api/macros/upload', upload.single('macro_file'), async (req, res) => {
    try {
        if (!getHasAuth()) {
            return res.status(503).json({
                error: 'Serwer nie jest zautoryzowany z Dyskiem Google.',
                code: 'TOKEN_EXPIRED'
            });
        }
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
            fields: 'id, name, size, createdTime',
            supportsAllDrives: true
        });

        markAuthOk();

        const createdId = response.data.id;
        const newMacro = {
            id: createdId,
            name: safeName.replace(/\.ivy3$/i, ''),
            filename: safeName,
            size: req.file.buffer.length,
            createdTime: response.data.createdTime || new Date().toISOString(),
            tps: tps,
            author: author
        };

        if (listCache.macros) {
            updateListCache([newMacro, ...listCache.macros.filter(m => m.id !== createdId)]);
        }
        putDownloadCache(createdId, safeName, req.file.buffer);

        console.log(`[Upload] Zapisano! ID: ${createdId}`);

        res.json({
            success: true,
            id: createdId,
            name: safeName,
            deleteToken: deleteToken
        });
    } catch (err) {
        return handleDriveError(res, err, 'Blad zapisu na Dysku Google');
    }
});

app.post('/api/macros/delete/:id', async (req, res) => {
    try {
        if (!getHasAuth()) {
            return res.status(503).json({
                error: 'Serwer nie jest zautoryzowany z Dyskiem Google.',
                code: 'TOKEN_EXPIRED'
            });
        }

        const fileId = req.params.id;
        if (!FILE_ID_RE.test(fileId)) {
            return res.status(400).json({ error: 'Nieprawidlowe ID pliku.' });
        }
        const deleteToken = req.body.deleteToken;

        const file = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, appProperties',
            supportsAllDrives: true
        });

        const storedToken = file.data.appProperties?.deleteToken;
        if (storedToken && storedToken !== deleteToken) {
            return res.status(403).json({ error: 'Brak uprawnien do usuniecia tego makra.' });
        }

        await drive.files.delete({
            fileId: fileId,
            supportsAllDrives: true
        });

        markAuthOk();
        if (listCache.macros) {
            updateListCache(listCache.macros.filter(m => m.id !== fileId));
        }
        deleteDownloadCache(fileId);

        console.log(`[Delete] Usunieto makro ID: ${fileId} (${file.data.name})`);
        res.json({ success: true, id: fileId });
    } catch (err) {
        return handleDriveError(res, err, 'Blad usuwania makra');
    }
});

app.get('/api/macros/download/:id', async (req, res) => {
    try {
        if (!getHasAuth()) {
            return res.status(503).json({
                error: 'Serwer nie jest zautoryzowany z Dyskiem Google.',
                code: 'TOKEN_EXPIRED'
            });
        }

        const fileId = req.params.id;
        if (!FILE_ID_RE.test(fileId)) {
            return res.status(400).json({ error: 'Nieprawidlowe ID pliku.' });
        }

        const cached = getDownloadCache(fileId);
        if (cached) {
            return sendBinaryCached(req, res, cached);
        }

        const cachedMeta = listCache.byId.get(fileId);
        let fileName = cachedMeta ? (cachedMeta.filename || `${cachedMeta.name}.ivy3`) : null;
        let knownSize = cachedMeta ? (cachedMeta.size || 0) : 0;

        if (!fileName) {
            const meta = await drive.files.get({
                fileId: fileId,
                fields: 'id, name, size',
                supportsAllDrives: true
            });
            fileName = meta.data.name || 'macro.ivy3';
            knownSize = parseInt(meta.data.size || '0', 10);
        }

        if (knownSize > MAX_CACHEABLE_FILE_BYTES) {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=3600');

            const fileStream = await drive.files.get(
                { fileId: fileId, alt: 'media', supportsAllDrives: true },
                { responseType: 'stream' }
            );

            markAuthOk();
            fileStream.data.on('error', err => {
                console.error('[Stream Error /api/macros/download]', err.message);
                if (!res.headersSent) {
                    return handleDriveError(res, err, 'Blad pobierania pliku');
                }
                res.destroy(err);
            });
            return fileStream.data.pipe(res);
        }

        const resp = await drive.files.get(
            { fileId: fileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'arraybuffer' }
        );
        const buf = Buffer.from(resp.data);
        markAuthOk();

        const cachedEntry = putDownloadCache(fileId, fileName, buf);
        if (cachedEntry) {
            return sendBinaryCached(req, res, cachedEntry);
        }

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', buf.length);
        return res.end(buf);
    } catch (err) {
        return handleDriveError(res, err, 'Blad pobierania pliku');
    }
});

app.listen(PORT, () => {
    console.log(`Ivy Macro Server dziala na porcie ${PORT}`);
    if (getHasAuth()) {
        refreshListCache(true).catch(err => console.warn('[Warmup]', err.message));
    }
});
