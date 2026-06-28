/**
 * MEGA MIND SESSION SERVER
 * Standalone session generator (QR + Pairing Code) for MEGA MIND WhatsApp Bot.
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
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // FIX: increase ping timeout so Render's free tier sleep doesn't drop sockets immediately
    pingTimeout: 60000,
    pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const RECORDS_DIR = path.join(__dirname, 'records');
const SESSION_TTL_MS = 60 * 60 * 1000;
const LINK_TIMEOUT_MS = 90 * 1000;

fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(RECORDS_DIR);

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
    try { files = await fs.readdir(RECORDS_DIR); } catch { return; }
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

async function buildPortableSessionId(sessionPath) {
    const credsPath = path.join(sessionPath, 'creds.json');
    const creds = await fs.readJson(credsPath);
    const encoded = Buffer.from(JSON.stringify(creds)).toString('base64');
    return `MEGA~${encoded}`;
}

// ---------- REST API ----------

app.get('/session/:id', async (req, res) => {
    const { id } = req.params;
    const record = await readRecord(id);
    if (!record) return res.status(404).json({ status: 'not_found' });
    if (record.status !== 'connected') return res.json({ status: record.status || 'pending' });
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

app.get('/status/:id', async (req, res) => {
    const record = await readRecord(req.params.id);
    if (!record) return res.status(404).json({ status: 'not_found' });
    res.json({ status: record.status, connectedAt: record.connectedAt || null });
});

app.delete('/session/:id', async (req, res) => {
    const { id } = req.params;
    await endLiveSocket(id);
    await deleteRecord(id);
    res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- Socket.IO ----------

io.on('connection', (socket) => {
    console.log('Web client connected:', socket.id);

    let currentSessionId = null;

    async function startLinking({ method, phoneNumber }) {
        // Clean up any previous attempt from this socket
        if (currentSessionId) {
            await endLiveSocket(currentSessionId);
            await deleteRecord(currentSessionId);
        }

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
            // FIX: use consistent browser string for both methods
            browser: ['MEGA MIND', 'Chrome', '3.0.0'],
            syncFullHistory: false,
            // FIX: these help with connection stability
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        liveSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        let pairingRequested = false;
        let qrCount = 0;
        let retryCount = 0;
        const MAX_RETRIES = 3;
        let linked = false;

        const linkTimer = setTimeout(async () => {
            const record = await readRecord(sessionId);
            if (record && record.status !== 'connected') {
                socket.emit('error', { message: 'Linking timed out after 90 seconds. Please try again.' });
                await endLiveSocket(sessionId);
                await deleteRecord(sessionId);
            }
        }, LINK_TIMEOUT_MS);

        async function spawnSocket() {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['MEGA MIND', 'Chrome', '3.0.0'],
                syncFullHistory: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            });

            liveSockets.set(sessionId, sock);
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // QR method: render each new QR (WhatsApp rotates them every ~20s)
                if (qr && method === 'qr') {
                    qrCount++;
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        socket.emit('qr', { qr: qrDataUrl, sessionId, attempt: qrCount });
                    } catch (err) {
                        socket.emit('error', { message: 'Failed to render QR code' });
                    }
                }

                // Pairing: request code on first QR event (means WA connection is ready)
                if (method === 'pairing' && qr && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        const clean = phoneNumber.replace(/\D/g, '');
                        if (!clean || clean.length < 7) {
                            socket.emit('error', { message: 'Invalid phone number. Include your country code, digits only.' });
                            return;
                        }
                        await new Promise((r) => setTimeout(r, 3000));
                        const code = await sock.requestPairingCode(clean);
                        socket.emit('pairing-code', { code, sessionId });
                    } catch (err) {
                        pairingRequested = false; // allow retry on next QR event
                        socket.emit('error', { message: 'Failed to get pairing code: ' + err.message });
                    }
                }

                if (connection === 'open') {
                    linked = true;
                    clearTimeout(linkTimer);
                    await new Promise((r) => setTimeout(r, 2000));

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
                        socket.emit('error', { message: 'Logged out by WhatsApp. Please try again.' });
                        await endLiveSocket(sessionId);
                        await deleteRecord(sessionId);
                        return;
                    }

                    // Already fully linked — ignore transient close
                    if (linked) return;

                    // Not linked yet — auto retry
                    retryCount++;
                    console.log(`[session ${sessionId}] connection closed (code ${statusCode}), retry ${retryCount}/${MAX_RETRIES}`);

                    if (retryCount > MAX_RETRIES) {
                        clearTimeout(linkTimer);
                        socket.emit('error', { message: `Connection failed after ${MAX_RETRIES} retries. Please try again.` });
                        await endLiveSocket(sessionId);
                        await deleteRecord(sessionId);
                        return;
                    }

                    socket.emit('status', { message: `Connection dropped — retrying (${retryCount}/${MAX_RETRIES})…` });
                    pairingRequested = false; // allow pairing code to be re-requested on reconnect

                    // Back off before retrying
                    await new Promise((r) => setTimeout(r, retryCount * 2000));

                    try {
                        await endLiveSocket(sessionId);
                        await spawnSocket();
                    } catch (err) {
                        socket.emit('error', { message: 'Reconnect failed: ' + err.message });
                    }
                }
            });
        }

        await spawnSocket();
    }

    socket.on('start-session', (data) => {
        startLinking(data).catch((err) => {
            socket.emit('error', { message: 'Internal error: ' + err.message });
        });
    });

    // FIX: allow client to explicitly cancel/retry
    socket.on('cancel-session', async () => {
        if (currentSessionId) {
            await endLiveSocket(currentSessionId);
            await deleteRecord(currentSessionId);
            currentSessionId = null;
        }
        socket.emit('cancelled');
    });

    socket.on('disconnect', () => {
        console.log('Web client disconnected:', socket.id);
    });
});

// ---------- background cleanup ----------

setInterval(() => {
    cleanupExpired().catch((err) => console.error('cleanup error:', err.message));
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════════════════╗
║  MEGA MIND SESSION SERVER                          ║
║  Port: ${PORT}
║  REST: GET /session/:id  |  GET /status/:id        ║
╚═══════════════════════════════════════════════════╝\n`);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const [, sock] of liveSockets) {
        try { sock.end?.(undefined); } catch {}
    }
    httpServer.close(() => process.exit(0));
});
