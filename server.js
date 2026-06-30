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
    pingTimeout: 60000,
    pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;
// Branding shown on the link page — defaults match the bot's own set.js
// (BOT_TITLE / BOT_TAGLINE) so this page and the bot look like the same
// product. Override with env vars if you rebrand the bot later.
const BOT_TITLE = process.env.BOT_TITLE || 'PROFESSOR TECH';
const BOT_TAGLINE = process.env.BOT_TAGLINE || 'MEGA-MIND BOT';
const OWNER_NAME = process.env.OWNER_NAME || 'Professor';
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const RECORDS_DIR = path.join(__dirname, 'records');
const SESSION_TTL_MS = 60 * 60 * 1000;
const LINK_TIMEOUT_MS = 120 * 1000; // 2 min to account for slow Render cold starts

fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(RECORDS_DIR);

const liveSockets = new Map();

app.use(express.json());

// Serve the link page with branding placeholders filled in, so the page
// shows the bot's actual identity (e.g. "PROFESSOR TECH") instead of a
// generic name. Static middleware below still serves /assets/* normally.
app.get('/', async (_req, res) => {
    try {
        let html = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
        html = html
            .replace(/\{\{BOT_TITLE\}\}/g, BOT_TITLE)
            .replace(/\{\{BOT_TAGLINE\}\}/g, BOT_TAGLINE)
            .replace(/\{\{OWNER_NAME\}\}/g, OWNER_NAME);
        res.set('Cache-Control', 'no-store'); // never serve a stale cached page after a redeploy
        res.send(html);
    } catch (err) {
        res.status(500).send('Failed to load page: ' + err.message);
    }
});

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
    try { return await fs.readJson(recordPath(sessionId)); }
    catch { return null; }
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
            await killSocket(sessionId);
            await deleteRecord(sessionId);
            console.log(`[cleanup] expired: ${sessionId}`);
        }
    }
}

async function killSocket(sessionId) {
    const sock = liveSockets.get(sessionId);
    if (sock) {
        try { sock.end?.(undefined); } catch {}
        liveSockets.delete(sessionId);
    }
}

async function buildPortableSession(sessionPath) {
    // Wait up to 5s for creds.json to appear (creds.update can lag behind connection open)
    const credsPath = path.join(sessionPath, 'creds.json');
    for (let i = 0; i < 10; i++) {
        if (await fs.pathExists(credsPath)) break;
        await new Promise(r => setTimeout(r, 500));
    }
    const creds = await fs.readJson(credsPath);
    return 'MEGA~' + Buffer.from(JSON.stringify(creds)).toString('base64');
}

// ---------- REST API ----------

app.get('/session/:id', async (req, res) => {
    const record = await readRecord(req.params.id);
    if (!record) return res.status(404).json({ status: 'not_found' });
    if (record.status !== 'connected') return res.json({ status: record.status || 'pending' });
    if (Date.now() - (record.connectedAt || 0) > SESSION_TTL_MS) {
        await deleteRecord(req.params.id);
        return res.status(410).json({ status: 'expired' });
    }
    return res.json({
        status: 'connected',
        sessionId: req.params.id,
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
    await killSocket(req.params.id);
    await deleteRecord(req.params.id);
    res.json({ success: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- Socket.IO ----------

io.on('connection', (socket) => {
    console.log('client connected:', socket.id);

    let currentSessionId = null;
    let cancelled = false;

    async function startLinking({ method, phoneNumber }) {
        cancelled = false;

        // Clean up previous attempt from this socket
        if (currentSessionId) {
            await killSocket(currentSessionId);
            await deleteRecord(currentSessionId);
        }

        const sessionId = newSessionId();
        currentSessionId = sessionId;
        const sessionPath = path.join(SESSIONS_DIR, sessionId);

        await fs.ensureDir(sessionPath);
        await writeRecord(sessionId, { status: 'pending', method, createdAt: Date.now() });

        let pairingRequested = false;
        let qrCount = 0;
        let retryCount = 0;
        const MAX_RETRIES = 3;
        let linked = false;

        const linkTimer = setTimeout(async () => {
            if (linked || cancelled) return;
            const record = await readRecord(sessionId);
            if (record && record.status !== 'connected') {
                socket.emit('error', { message: 'Timed out waiting for WhatsApp. Please try again.' });
                await killSocket(sessionId);
                await deleteRecord(sessionId);
            }
        }, LINK_TIMEOUT_MS);

        async function spawnSocket() {
            if (cancelled) return;

            // Always re-read state from disk (creds may have been partially saved)
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                // Must match the browser fingerprint the bot itself uses to
                // reconnect (MEGA-MIND-main/index.js). A mismatch here is
                // what causes WhatsApp to log the session back out shortly
                // after linking — it looks like a different device.
                browser: ['MEGA MIND', 'Chrome', '120.0.0'],
                syncFullHistory: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            });

            liveSockets.set(sessionId, sock);
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                if (cancelled) return;
                const { connection, lastDisconnect, qr } = update;

                // ── QR method ──
                if (qr && method === 'qr') {
                    qrCount++;
                    try {
                        const dataUrl = await QRCode.toDataURL(qr);
                        socket.emit('qr', { qr: dataUrl, sessionId, attempt: qrCount });
                    } catch {
                        socket.emit('error', { message: 'Failed to render QR code.' });
                    }
                }

                // ── Pairing method ──
                // Request code on the first QR event — this confirms the WA connection
                // is live and ready to accept requestPairingCode()
                if (method === 'pairing' && qr && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        const clean = (phoneNumber || '').replace(/\D/g, '');
                        if (!clean || clean.length < 7) {
                            socket.emit('error', { message: 'Invalid phone number. Use country code + digits only, e.g. 254712345678' });
                            return;
                        }
                        // 3s delay — Baileys must finish key exchange before pairing code request
                        await new Promise(r => setTimeout(r, 3000));
                        if (cancelled) return;
                        const code = await sock.requestPairingCode(clean);
                        // Format as XXXX-XXXX if 8 chars
                        const formatted = code.length === 8
                            ? code.slice(0, 4) + '-' + code.slice(4)
                            : code;
                        socket.emit('pairing-code', { code: formatted, sessionId });
                    } catch (err) {
                        pairingRequested = false; // allow retry on next QR event
                        console.error('[pairing] requestPairingCode failed:', err.message);
                        socket.emit('error', { message: 'Could not get pairing code: ' + err.message });
                    }
                }

                // ── Connected ──
                if (connection === 'open') {
                    linked = true;
                    clearTimeout(linkTimer);

                    try {
                        // Wait for creds.json to be fully written
                        const portableSessionId = await buildPortableSession(sessionPath);
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
                        console.log(`[session ${sessionId}] linked as ${record.user?.id}`);

                        // Send SESSION_ID to self-chat (saved messages) on the linked number
                        try {
                            const selfJid = sock.user.id;
                            const msg = `*🤖 MEGA MIND — Session Ready*\n\n` +
                                `Copy the SESSION_ID below and set it as \`SESSION_ID\` in your bot's environment variables.\n\n` +
                                `${portableSessionId}\n\n` +
                                `⚠️ Keep this private — it grants full access to this WhatsApp account.`;
                            await sock.sendMessage(selfJid, { text: msg });
                            console.log(`[session ${sessionId}] SESSION_ID sent to self-chat`);
                        } catch (err) {
                            // Non-fatal — user still has it on the web page
                            console.error('[session] self-message failed:', err.message);
                        }

                        // IMPORTANT: close this socket once the session has been
                        // captured and handed off. Leaving it alive (it used to
                        // sit in liveSockets until the 1hr cleanup) meant TWO
                        // active WhatsApp connections shared the same session —
                        // this server's, and the bot's own once it reconnects
                        // with the SESSION_ID. WhatsApp treats that as a device
                        // conflict and force-logs-out one of them, which is what
                        // was causing the repeated logouts after QR linking.
                        setTimeout(async () => {
                            await killSocket(sessionId);
                            console.log(`[session ${sessionId}] generator socket closed — handed off to bot`);
                        }, 4000);
                    } catch (err) {
                        console.error('[session] finalize error:', err.message);
                        socket.emit('error', { message: 'Linked but failed to save session: ' + err.message });
                    }
                }

                // ── Closed ──
                if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    const loggedOut = code === DisconnectReason.loggedOut;

                    if (loggedOut) {
                        clearTimeout(linkTimer);
                        socket.emit('error', { message: 'WhatsApp logged out the session. Please try again.' });
                        await killSocket(sessionId);
                        await deleteRecord(sessionId);
                        return;
                    }

                    if (linked) return; // transient close after success — ignore

                    // Connection dropped before linking — retry
                    retryCount++;
                    console.log(`[session ${sessionId}] closed (code ${code}), retry ${retryCount}/${MAX_RETRIES}`);

                    if (retryCount > MAX_RETRIES) {
                        clearTimeout(linkTimer);
                        socket.emit('error', { message: `Failed to connect after ${MAX_RETRIES} attempts. Please try again.` });
                        await killSocket(sessionId);
                        await deleteRecord(sessionId);
                        return;
                    }

                    socket.emit('status', { message: `Connection dropped — retrying (${retryCount}/${MAX_RETRIES})…` });
                    pairingRequested = false;

                    await new Promise(r => setTimeout(r, retryCount * 2000));
                    if (cancelled) return;

                    await killSocket(sessionId);
                    spawnSocket().catch(err => {
                        socket.emit('error', { message: 'Reconnect failed: ' + err.message });
                    });
                }
            });
        }

        await spawnSocket();
    }

    socket.on('start-session', (data) => {
        startLinking(data).catch(err => {
            socket.emit('error', { message: 'Internal error: ' + err.message });
        });
    });

    socket.on('cancel-session', async () => {
        cancelled = true;
        if (currentSessionId) {
            await killSocket(currentSessionId);
            await deleteRecord(currentSessionId);
            currentSessionId = null;
        }
        socket.emit('cancelled');
    });

    socket.on('disconnect', () => {
        console.log('client disconnected:', socket.id);
    });
});

// ---------- cleanup ----------

setInterval(() => {
    cleanupExpired().catch(err => console.error('cleanup error:', err.message));
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => {
    console.log(`MEGA MIND SESSION SERVER running on port ${PORT}`);
});

process.on('SIGINT', async () => {
    for (const [, sock] of liveSockets) {
        try { sock.end?.(undefined); } catch {}
    }
    httpServer.close(() => process.exit(0));
});
