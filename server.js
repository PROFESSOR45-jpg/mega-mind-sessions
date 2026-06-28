/**
 * MEGA MIND SESSION SERVER
 * Standalone session generator (QR + Pairing Code) for MEGA MIND WhatsApp Bot.
 *
 * This app is intentionally separate from the bot. It only knows how to:
 *   1. Walk a user through linking WhatsApp (QR or pairing code)
 *   2. Produce a portable SESSION_ID (base64 creds) once linked
 *   3. Serve that SESSION_ID back to a bot instance over a simple REST API
 *
 * The bot (MEGA-MIND) talks to this service over HTTP using SESSION_SERVER_URL.
 * Nothing here imports or depends on the bot's code, and vice versa.
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const P = require('pino');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const RECORDS_DIR = path.join(__dirname, 'records'); // persisted metadata, survives restarts
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour — how long a finished session stays fetchable
const LINK_TIMEOUT_MS = 90 * 1000; // how long a QR/pairing attempt can stay unlinked before cleanup

fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(RECORDS_DIR);

// In-memory map of live Baileys sockets keyed by our own sessionId (not WA's).
// Lost on restart, which is fine — record files on disk are the source of truth
// for "is this session ready to hand to a bot", not the live socket.
const liveSockets = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function newSessionId() {
    return 'MM_' + crypto.randomBytes(12).toString('hex');
}

function recordPath(sessionId) {
    return path.join(RECORDS_DIR, `${sessionId}.json`);
}

async function writeRecord(sessionId, record) {
    await fs.writeJson(recordPath(sessionId), record, { spaces: 2 });
}

async function readRecord(sessionId) {
    try {
        return await fs.readJson(recordPath(sessionId));
    } catch {
        return null;
    }
}

async function deleteRecord(sessionId) {
    await fs.remove(recordPath(sessionId)).catch(() => {});
    await fs.remove(path.join(SESSIONS_DIR, sessionId)).catch(() => {});
}

async function cleanupExpired() {
    let files = [];
    try {
        files = await fs.readdir(RECORDS_DIR);
    } catch {
        return;
    }
    const now = Date.now();
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.replace(/\.json$/, '');
        const record = await readRecord(sessionId);
        if (!record) continue;
        const age = now - (record.connectedAt || record.createdAt || 0);
        if (age > SESSION_TTL_MS) {
            await endLiveSocket(sessionId);
            await deleteRecord(sessionId);
            console.log(`[cleanup] expired session removed: ${sessionId}`);
        }
    }
}

async function endLiveSocket(sessionId) {
    const sock = liveSockets.get(sessionId);
    if (sock) {
        try { sock.end?.(undefined); } catch {}
        liveSockets.delete(sessionId);
    }
}

/**
 * Build the portable SESSION_ID string the bot will use.
 * It's just the creds.json contents, base64-encoded, prefixed so the bot
 * can sanity-check the format before trying to parse it.
 */
async function buildPortableSessionId(sessionPath) {
    const credsPath = path.join(sessionPath, 'creds.json');
    const creds = await fs.readJson(credsPath);
    const encoded = Buffer.from(JSON.stringify(creds)).toString('base64');
    return `MEGA~${encoded}`;
}

// ---------- REST API (used by the bot) ----------

/**
 * GET /session/:id
 * The bot polls this after a user has linked via the web UI.
 * Returns { status: 'connected', session: '<portable id>' } once ready,
 * or { status: 'pending' | 'not_found' | 'expired' }.
 */
app.get('/session/:id', async (req, res) => {
    const { id } = req.params;
    const record = await readRecord(id);

    if (!record) {
        return res.status(404).json({ status: 'not_found' });
    }

    if (record.status !== 'connected') {
        return res.json({ status: record.status || 'pending' });
    }

    const age = Date.now() - (record.connectedAt || 0);
    if (age > SESSION_TTL_MS) {
        await deleteRecord(id);
        return res.status(410).json({ status: 'expired' });
    }

    return res.json({
        status: 'connected',
        sessionId: id,
        session: record.portableSessionId,
        user: record.user || null,
        connectedAt: record.connectedAt
    });
});

/**
 * GET /status/:id — lightweight status check, no session payload.
 */
app.get('/status/:id', async (req, res) => {
    const record = await readRecord(req.params.id);
    if (!record) return res.status(404).json({ status: 'not_found' });
    res.json({ status: record.status, connectedAt: record.connectedAt || null });
});

/**
 * DELETE /session/:id — let a bot (or the web UI) explicitly revoke a session
 * once it's been picked up, so it can't be reused if it ever leaked.
 */
app.delete('/session/:id', async (req, res) => {
    const { id } = req.params;
    await endLiveSocket(id);
    await deleteRecord(id);
    res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- Socket.IO (used by the browser pairing UI) ----------

io.on('connection', (socket) => {
    console.log('Web client connected:', socket.id);

    let currentSessionId = null;

    async function startLinking({ method, phoneNumber }) {
        const sessionId = newSessionId();
        currentSessionId = sessionId;
        const sessionPath = path.join(SESSIONS_DIR, sessionId);

        await fs.ensureDir(sessionPath);
        await writeRecord(sessionId, { status: 'pending', method, createdAt: Date.now() });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            printQRInTerminal: false,
            browser: method === 'pairing'
                ? ['Chrome (Linux)', 'Chrome', '1.0.0']
                : ['MEGA MIND', 'Chrome', '3.0.0'],
            syncFullHistory: false
        });

        liveSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        let pairingRequested = false;
        let linkTimer = setTimeout(async () => {
            const record = await readRecord(sessionId);
            if (record && record.status !== 'connected') {
                socket.emit('error', { message: 'Linking timed out. Please try again.' });
                await endLiveSocket(sessionId);
                await deleteRecord(sessionId);
            }
        }, LINK_TIMEOUT_MS);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && method === 'qr') {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    socket.emit('qr', { qr: qrDataUrl, sessionId });
                } catch (err) {
                    socket.emit('error', { message: 'Failed to render QR code' });
                }
            }

            if (method === 'pairing' && !pairingRequested && qr) {
                pairingRequested = true;
                try {
                    const clean = phoneNumber.replace(/\D/g, '');
                    await new Promise((r) => setTimeout(r, 1500)); // let the socket settle
                    const code = await sock.requestPairingCode(clean);
                    socket.emit('pairing-code', { code, sessionId });
                } catch (err) {
                    socket.emit('error', { message: 'Failed to get pairing code: ' + err.message });
                    pairingRequested = false;
                }
            }

            if (connection === 'open') {
                clearTimeout(linkTimer);
                await new Promise((r) => setTimeout(r, 2000)); // let creds.json fully settle

                try {
                    const portableSessionId = await buildPortableSessionId(sessionPath);
                    const record = {
                        status: 'connected',
                        method,
                        user: sock.user ? { id: sock.user.id, name: sock.user.name } : null,
                        connectedAt: Date.now(),
                        portableSessionId
                    };
                    await writeRecord(sessionId, record);

                    socket.emit('connected', {
                        sessionId,
                        user: record.user,
                        sessionString: portableSessionId
                    });
                } catch (err) {
                    socket.emit('error', { message: 'Failed to finalize session: ' + err.message });
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                if (loggedOut) {
                    clearTimeout(linkTimer);
                    socket.emit('error', { message: 'Session ended. Please try again.' });
                    await endLiveSocket(sessionId);
                    await deleteRecord(sessionId);
                }
                // Non-logout closes during linking are usually transient
                // (e.g. reconnect after QR scan); Baileys/the socket handles retry
                // internally up to the point of 'open' or a real logout.
            }
        });
    }

    socket.on('start-session', (data) => {
        startLinking(data).catch((err) => {
            socket.emit('error', { message: 'Internal error: ' + err.message });
        });
    });

    socket.on('disconnect', () => {
        console.log('Web client disconnected:', socket.id);
        // Intentionally do NOT kill the WA socket here — the user may have
        // already scanned/paired and just closed the tab. The link should
        // still complete and become fetchable via the REST API.
    });
});

// ---------- background cleanup ----------

setInterval(() => {
    cleanupExpired().catch((err) => console.error('cleanup error:', err.message));
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║  MEGA MIND SESSION SERVER                          ║
║  Port: ${PORT}
║  REST: GET /session/:id  |  GET /status/:id        ║
╚═══════════════════════════════════════════════════╝
    `);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down session server...');
    for (const [id, sock] of liveSockets) {
        try { sock.end?.(undefined); } catch {}
    }
    httpServer.close(() => process.exit(0));
});
