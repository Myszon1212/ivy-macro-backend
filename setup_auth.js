const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');
require('dotenv').config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[Error] Brak GOOGLE_CLIENT_ID lub GOOGLE_CLIENT_SECRET w pliku .env!');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
    'https://www.googleapis.com/auth/drive.file'
];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
});

console.log('====================================================');
console.log('=== Ivy Macro Cloud - Jednorazowa Autoryzacja OAuth ===');
console.log('====================================================');
console.log('\nOtwieram przegladarke w celu zalogowania...\n');
console.log('Jesli okno nie otworzy sie samo, otworz ten link:\n' + authUrl + '\n');

// Start temporary HTTP server to catch OAuth callback
const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = url.parse(req.url, true);
        if (reqUrl.pathname === '/oauth2callback') {
            const code = reqUrl.query.code;
            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>Blad: Brak kodu autoryzacji w odpowiedzi Google.</h2>');
                return;
            }

            console.log('[Auth] Otrzymano kod, generowanie Refresh Tokena...');
            const { tokens } = await oauth2Client.getToken(code);
            const refreshToken = tokens.refresh_token;

            if (!refreshToken) {
                console.warn('[Ostrzezenie] Google nie zwrocilo refresh_tokena (prawdopodobnie konto bylo juz wczesniej autoryzowane). Uzyj parametru prompt=consent.');
            } else {
                console.log('[Auth] Sukces! Refresh Token otrzymany.');
                // Update .env file
                const envPath = path.join(__dirname, '.env');
                let envContent = fs.readFileSync(envPath, 'utf8');
                if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
                    envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN=${refreshToken}`);
                } else {
                    envContent += `\nGOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
                }
                fs.writeFileSync(envPath, envContent, 'utf8');
                console.log('[Auth] Plik .env zostal zaktualizowany o GOOGLE_REFRESH_TOKEN!');
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1 style="color: #2e7d32;">Autoryzacja udana! 🎉</h1>
                    <p>Polaczono z Twoim Dyskiem Google (5 TB).</p>
                    <p>Mozesz zamknac te karte przegladarki i wrocic do konsoli.</p>
                </div>
            `);

            setTimeout(() => {
                server.close(() => {
                    console.log('\n[Gotowe] Autoryzacja zakonczona pomyslnie. Uruchom serwer za pomoca: npm start\n');
                    process.exit(0);
                });
            }, 1000);
        }
    } catch (err) {
        console.error('[Error]', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>Wystapil blad: ${err.message}</h2>`);
    }
});

server.listen(3000, () => {
    // Open system browser
    exec(`start "" "${authUrl}"`);
});
