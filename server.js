/**
 * MEGA MIND SESSION SERVER
 * Standalone session generator (QR + Pairing Code) for the MEGA MIND WhatsApp bot.
 *
 * Fixes vs. the previous version (see README "What changed"):
 *  - QR linking never completed: the old code waited for `creds.registered`,
 *    which Baileys 7 only ever sets on the pairing-code path. A finished link is
 *    now detected via `creds.account` (set by Baileys when pair-success arrives).
 *  - Baileys 7 is ESM-only; it is now loaded with dynamic import() so the server
 *    also starts on Node 18/20 (plain require() only works on very new Node).
 *  - The post-pair "restart required" (515) close is handled as the expected step
 *    it is, instead of being counted as a failed connection.
 *  - Retries before pairing finished reused half-registered credentials, which
 *    makes WhatsApp reject the next attempt; they now restart from clean keys.
 *  - Abandoned attempts (browser closed / tab refreshed) no longer leak sockets.
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
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
const BOT_TITLE = process.env.BOT_TITLE || 'PROFESSOR TECH';
const BOT_TAGLINE = process.env.BOT_TAGLINE || 'MEGA-MIND BOT';
const OWNER_NAME = process.env.OWNER_NAME || 'Professor';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const RECORDS_DIR = path.join(DATA_DIR, 'records');
const SESSION_TTL_MS = 60 * 60 * 1000;
const LINK_TIMEOUT_MS = 180 * 1000;            // whole attempt: QR/code shown -> linked
const PAIRING_READY_TIMEOUT_MS = 60 * 1000;    // wait for the WhatsApp handshake before asking for a code
const OPEN_CONFIRM_TIMEOUT_MS = 10 * 1000;     // after `open`, wait this long for creds to finish saving
const MAX_RETRIES = 3;
const DM_SETTLE_MS = Number(process.env.DM_SETTLE_MS ?? 3000); // pause after `open` before DMing the session
const MAX_LIVE_SOCKETS = Number(process.env.MAX_LIVE_SOCKETS || 25);
const MAX_STARTS_PER_MINUTE = 8;               // per IP
// Baileys' browser tuple is [OS, browser, version]. The first slot must be a
// real platform: WhatsApp rejects pairing-code registration from an unknown
// one ("Couldn't link device") even though QR linking still works. Must match
// the tuple the bot reconnects with, or the session gets revoked after linking.
const BROWSER = ['Ubuntu', 'Chrome', '22.04.4'];

fs.ensureDirSync(SESSIONS_DIR);
fs.ensureDirSync(RECORDS_DIR);

const liveSockets = new Map(); // sessionId -> baileys socket

// ---------- Baileys (ESM) loader ----------
let B = null;
async function loadBaileys() {
    if (!B) {
        const m = await import('@whiskeysockets/baileys');
        B = {
            makeWASocket: m.makeWASocket || m.default,
            useMultiFileAuthState: m.useMultiFileAuthState,
            DisconnectReason: m.DisconnectReason,
            fetchLatestBaileysVersion: m.fetchLatestBaileysVersion,
            jidNormalizedUser: m.jidNormalizedUser,
            generateWAMessageFromContent: m.generateWAMessageFromContent,
            proto: m.proto,
            BufferJSON: m.BufferJSON,
        };
    }
    return B;
}

let versionCache = null;
async function getWaVersion() {
    if (versionCache && Date.now() - versionCache.at < 10 * 60 * 1000) return versionCache.version;
    try {
        const { version } = await withTimeout(B.fetchLatestBaileysVersion(), 6000, 'WA version lookup');
        if (Array.isArray(version)) {
            versionCache = { version, at: Date.now() };
            return version;
        }
    } catch (err) {
        console.log('[version] lookup failed, using Baileys built-in default:', err.message);
    }
    return undefined; // undefined => let Baileys use its bundled default
}

// ---------- HTTP ----------
app.disable('x-powered-by');
app.use(express.json());

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.get('/', async (_req, res) => {
    try {
        let html = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
        html = html
            .replace(/\{\{BOT_TITLE\}\}/g, escapeHtml(BOT_TITLE))
            .replace(/\{\{BOT_TAGLINE\}\}/g, escapeHtml(BOT_TAGLINE))
            .replace(/\{\{OWNER_NAME\}\}/g, escapeHtml(OWNER_NAME));
        res.set('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        res.status(500).send('Failed to load page: ' + err.message);
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} (timed out after ${Math.round(ms / 1000)}s)`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newSessionId() {
    return 'MM_' + crypto.randomBytes(12).toString('hex');
}

// Ids are always 'MM_' + 24 hex chars; anything else is rejected before it can
// touch the filesystem (path traversal via the unauthenticated DELETE route).
const SESSION_ID_RE = /^MM_[a-f0-9]{24}$/;
function isValidSessionId(id) {
    return typeof id === 'string' && SESSION_ID_RE.test(id);
}
function recordPath(sessionId) {
    if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
    return path.join(RECORDS_DIR, `${sessionId}.json`);
}
async function writeRecord(sessionId, record) {
    await fs.writeJson(recordPath(sessionId), record, { spaces: 2 });
}
async function readRecord(sessionId) {
    if (!isValidSessionId(sessionId)) return null;
    try { return await fs.readJson(recordPath(sessionId)); } catch { return null; }
}
async function deleteRecord(sessionId) {
    if (!isValidSessionId(sessionId)) return;
    await fs.remove(recordPath(sessionId)).catch(() => {});
    await fs.remove(path.join(SESSIONS_DIR, sessionId)).catch(() => {});
}

async function killSocket(sessionId) {
    const sock = liveSockets.get(sessionId);
    if (sock) {
        sock.__retired = true;
        try { sock.end?.(undefined); } catch {}
        liveSockets.delete(sessionId);
    }
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

// A link is only complete once WhatsApp has sent pair-success. Baileys stores
// that as `creds.account` (+ the assigned `me` jid). NOTE: `creds.registered`
// is NOT a reliable signal in Baileys 7 — it is only ever set on the
// pairing-code path (and before pair-success there), and never for QR linking.
function isPaired(creds) {
    return !!(creds && creds.account && creds.me && creds.me.id);
}

// Builds the portable MEGA~ session string from the live in-memory creds
// (never from creds.json, which is written asynchronously and can be stale or
// half-written). `registered` is forced true for bots that check it.
function buildPortableSession(creds) {
    if (!creds) throw new Error('socket has no auth state');
    if (!isPaired(creds)) throw new Error('device is not fully paired yet');
    if (!creds.noiseKey) throw new Error('creds are missing noiseKey — not a usable login');
    const exported = { ...creds, registered: true };
    return 'MEGA~' + Buffer.from(JSON.stringify(exported, B.BufferJSON.replacer)).toString('base64');
}

// Sends the session to self-chat as a tappable "copy" button with the full
// string also in plain text as a guaranteed fallback.
async function sendSessionCopyCard(sock, jid, sessionString) {
    const { proto, generateWAMessageFromContent } = B;
    const preview = sessionString.slice(0, 18) + '…' + sessionString.slice(-6);
    const bodyText =
        `*🤖 MEGA MIND — Session Ready*\n\n` +
        `Tap "Copy session" below, or copy it manually:\n\n` +
        '```' + sessionString + '```\n\n' +
        `⚠️ Keep this private — it grants full access to this WhatsApp account.`;
    try {
        const content = {
            interactiveMessage: proto.Message.InteractiveMessage.create({
                body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
                footer: proto.Message.InteractiveMessage.Footer.create({ text: `Session: ${preview}` }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: [
                        proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                            name: 'cta_copy',
                            buttonParamsJson: JSON.stringify({
                                display_text: 'Copy session',
                                id: 'copy_session_id',
                                copy_code: sessionString
                            })
                        })
                    ]
                })
            })
        };
        const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    } catch (err) {
        console.log(`[session] interactive copy button failed (${err.message}) — sending plain text instead.`);
        await sock.sendMessage(jid, { text: bodyText });
    }
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
    if (!isValidSessionId(req.params.id)) return res.status(400).json({ success: false, status: 'invalid_id' });
    await killSocket(req.params.id);
    await deleteRecord(req.params.id);
    res.json({ success: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), live: liveSockets.size }));

// ---------- per-IP start throttle ----------
const startLog = new Map(); // ip -> [timestamps]
function allowStart(ip) {
    const now = Date.now();
    const recent = (startLog.get(ip) || []).filter((t) => now - t < 60 * 1000);
    if (recent.length >= MAX_STARTS_PER_MINUTE) { startLog.set(ip, recent); return false; }
    recent.push(now);
    startLog.set(ip, recent);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, list] of startLog) {
        const recent = list.filter((t) => now - t < 60 * 1000);
        if (recent.length) startLog.set(ip, recent); else startLog.delete(ip);
    }
}, 5 * 60 * 1000).unref();

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    const ip = (fwd ? String(fwd).split(',')[0].trim() : socket.handshake.address) || 'unknown';
    console.log('client connected:', socket.id);

    let current = null;        // the in-flight attempt for this browser connection
    let queue = Promise.resolve();

    // Fully stops an attempt. Safe to call repeatedly. Deletes the pending
    // record/keys unless the link already succeeded (the bot may still fetch it).
    async function teardown(attempt) {
        if (!attempt) return;
        attempt.done = true;
        clearTimeout(attempt.timer);
        await killSocket(attempt.id);
        if (!attempt.linked) await deleteRecord(attempt.id);
        if (current === attempt) current = null;
    }

    async function startLinking(payload) {
        const method = payload && payload.method === 'pairing' ? 'pairing' : 'qr';
        const phone = String((payload && payload.phoneNumber) || '').replace(/\D/g, '');

        if (method === 'pairing' && (phone.length < 7 || phone.length > 15)) {
            socket.emit('error', { message: 'Invalid phone number. Use country code + digits only, e.g. 254712345678' });
            return;
        }
        if (!allowStart(ip)) {
            socket.emit('error', { message: 'Too many attempts. Please wait a minute and try again.' });
            return;
        }

        // Supersede any previous attempt FIRST so its teardown-induced `close`
        // can never start a retry loop of its own.
        await teardown(current);

        if (liveSockets.size >= MAX_LIVE_SOCKETS) {
            socket.emit('error', { message: 'The server is busy linking other devices. Please try again in a minute.' });
            return;
        }

        await loadBaileys();

        const id = newSessionId();
        const sessionPath = path.join(SESSIONS_DIR, id);
        await fs.ensureDir(sessionPath);
        await writeRecord(id, { status: 'pending', method, createdAt: Date.now() });

        const attempt = {
            id, method, phone,
            done: false,      // finished one way or the other — nothing may restart it
            linked: false,
            retries: 0,
            freshAuth: true,  // start from clean keys
            auth: null,       // { state, saveCreds }
            timer: null,
        };
        current = attempt;

        const log = (event, data) => console.log(`[diag ${id}] ${event}`, data || '');

        async function fail(message) {
            if (attempt.done) return;
            log('failed', { message });
            socket.emit('error', { message });
            await teardown(attempt);
        }

        attempt.timer = setTimeout(() => {
            if (attempt.done || attempt.linked) return;
            fail('Timed out waiting for WhatsApp to confirm the link. If you scanned/entered the code and nothing happened, tap start again for a fresh one.');
        }, LINK_TIMEOUT_MS);

        async function spawn() {
            if (attempt.done) return;

            // Before pairing has completed, always start from clean keys: a
            // retry that reuses creds from a half-finished registration (e.g.
            // `me` set by requestPairingCode) makes WhatsApp reject the login.
            // After pair-success the creds ARE the device — keep them.
            if (attempt.freshAuth || !attempt.auth) {
                await fs.emptyDir(sessionPath);
                attempt.auth = await B.useMultiFileAuthState(sessionPath);
                attempt.freshAuth = false;
            }
            const { state, saveCreds } = attempt.auth;

            const config = {
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                browser: BROWSER,
                syncFullHistory: false,
                markOnlineOnConnect: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            };
            const version = await getWaVersion();
            if (version) config.version = version; // never pass `version: undefined` — it would override Baileys' default
            if (attempt.done) return;

            const sock = B.makeWASocket(config);
            sock.__retired = false;
            liveSockets.set(id, sock);
            sock.ev.on('creds.update', saveCreds);

            let markReady, markNotReady;
            const socketReady = new Promise((resolve, reject) => { markReady = resolve; markNotReady = reject; });
            socketReady.catch(() => {});

            const stale = () => sock.__retired || attempt.done;

            // Raw notification some WhatsApp builds send mid-registration that
            // Baileys ignores. Only act on it BEFORE pairing finished, and mark
            // the old socket retired so its close event cannot spawn a second one.
            if (sock.ws && typeof sock.ws.on === 'function') {
                let handled = false;
                sock.ws.on('CB:notification', (node) => {
                    if (handled || stale() || isPaired(state.creds)) return;
                    if (node?.attrs?.type !== 'companion_reg_refresh') return;
                    handled = true;
                    log('companion_reg_refresh — restarting with fresh keys');
                    socket.emit('status', { message: 'WhatsApp reset this registration — generating a fresh one automatically…' });
                    attempt.freshAuth = true;
                    killSocket(id).then(() => spawn()).catch((err) => fail('Auto-restart failed: ' + err.message));
                });
            }

            // ── Pairing code ──
            // requestPairingCode() resolves as soon as the frame is *written*, and
            // WhatsApp discards it if the handshake hasn't finished. The first `qr`
            // (also emitted for pairing sockets) is the reliable readiness signal.
            if (attempt.method === 'pairing' && !isPaired(state.creds)) {
                (async () => {
                    try {
                        socket.emit('status', { message: 'Contacting WhatsApp…' });
                        await withTimeout(socketReady, PAIRING_READY_TIMEOUT_MS, 'WhatsApp did not become ready');
                        if (stale()) return;
                        if (!sock.ws?.isOpen) throw new Error('the connection to WhatsApp dropped before a code could be requested');

                        const code = await sock.requestPairingCode(attempt.phone);
                        if (!code) throw new Error('WhatsApp returned no pairing code');
                        if (stale()) return;

                        const formatted = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
                        socket.emit('pairing-code', { code: formatted, sessionId: id });
                        log('pairing-code issued');
                    } catch (err) {
                        if (stale()) return;
                        console.error('[pairing] requestPairingCode failed:', err.message);
                        // A close-before-ready is handled by the retry logic below.
                        if (/closed before a pairing code/.test(err.message)) return;
                        await fail('Could not get pairing code: ' + err.message);
                    }
                })();
            }

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;

                if (connection === 'close') {
                    markNotReady(new Error('the WhatsApp connection closed before a pairing code could be requested'));
                }
                if (stale()) return;

                if (connection || lastDisconnect || isNewLogin) {
                    log('connection.update', {
                        connection, hasQr: !!qr, isNewLogin: !!isNewLogin,
                        closeCode: lastDisconnect?.error?.output?.statusCode || null
                    });
                }

                if (qr || connection === 'open') markReady();

                // ── QR ──
                if (qr && attempt.method === 'qr') {
                    attempt.qrCount = (attempt.qrCount || 0) + 1;
                    try {
                        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 440, errorCorrectionLevel: 'M' });
                        if (!stale()) socket.emit('qr', { qr: dataUrl, sessionId: id, attempt: attempt.qrCount });
                    } catch {
                        socket.emit('error', { message: 'Failed to render QR code.' });
                    }
                }

                // The phone accepted the link; WhatsApp now restarts the connection.
                if (isNewLogin) socket.emit('paired', { message: 'Device paired — finishing setup…' });

                // ── Open ──
                if (connection === 'open') {
                    // `open` on the post-pair restart socket arrives with the new
                    // creds already loaded. Allow a short grace period in case the
                    // account info is still being merged.
                    const deadline = Date.now() + OPEN_CONFIRM_TIMEOUT_MS;
                    while (!isPaired(state.creds) && Date.now() < deadline && !stale()) await sleep(250);
                    if (stale()) return;
                    if (!isPaired(state.creds)) {
                        await fail('WhatsApp connected but the device link did not complete. Please try again.');
                        return;
                    }
                    await finalize(sock, state);
                    return;
                }

                // ── Close ──
                if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;

                    if (code === B.DisconnectReason.loggedOut) {
                        await fail('WhatsApp logged out the session. Please try again.');
                        return;
                    }

                    // 515 is the NORMAL step after a successful scan/code entry:
                    // WhatsApp asks the companion to reconnect with its new creds.
                    if (code === B.DisconnectReason.restartRequired) {
                        log('restart required after pairing — reconnecting with saved creds');
                        attempt.freshAuth = !isPaired(state.creds);
                        await killSocket(id);
                        if (attempt.done) return;
                        spawn().catch((err) => fail('Reconnect failed: ' + err.message));
                        return;
                    }

                    attempt.retries++;
                    log(`closed (code ${code}), retry ${attempt.retries}/${MAX_RETRIES}`);
                    if (attempt.retries > MAX_RETRIES) {
                        await fail(`Failed to connect after ${MAX_RETRIES} attempts. Please try again.`);
                        return;
                    }
                    socket.emit('status', { message: `Connection dropped — retrying (${attempt.retries}/${MAX_RETRIES})…` });
                    await sleep(attempt.retries * 2000);
                    if (attempt.done) return;
                    attempt.freshAuth = !isPaired(state.creds);
                    await killSocket(id);
                    spawn().catch((err) => fail('Reconnect failed: ' + err.message));
                }
            });
        }

        async function finalize(sock, state) {
            if (attempt.linked || attempt.done) return;
            attempt.linked = true;
            clearTimeout(attempt.timer);

            let portable;
            try {
                portable = buildPortableSession(state.creds);
            } catch (err) {
                attempt.linked = false;
                await fail('Linked but could not build the session: ' + err.message);
                return;
            }

            const user = sock.user ? { id: sock.user.id, name: sock.user.name } : (state.creds.me ? { id: state.creds.me.id, name: state.creds.me.name } : null);
            const record = { status: 'connected', method: attempt.method, user, connectedAt: Date.now(), portableSessionId: portable };

            // The browser gets the session before anything else can fail or stall.
            socket.emit('connected', { sessionId: id, user, sessionString: portable });
            console.log(`[session ${id}] linked as ${user?.id}`);

            try {
                await writeRecord(id, record);
            } catch (err) {
                console.error('[session] failed to persist record:', err.message);
                socket.emit('status', { message: `Warning: could not save the session record (${err.message}). Copy the SESSION_ID from this page now — fetching it by id later will not work.` });
            }

            // DM the session to the linked account's own chat ("Message yourself").
            // Plain text goes FIRST because it always displays; the tappable copy
            // button is a bonus (WhatsApp may accept it yet not render it). A short
            // settle delay after `open` avoids sending before WhatsApp is ready.
            let dmSent = false;
            try {
                const selfJid = B.jidNormalizedUser(sock.user.id);
                await sleep(DM_SETTLE_MS);
                const plain =
                    '✅ *Device linked — MEGA MIND*\n\nYour SESSION_ID:\n\n```' + portable + '```\n\n' +
                    '⚠️ Keep this private — it grants full access to this WhatsApp account.';
                for (let i = 1; i <= 3 && !dmSent; i++) {
                    try {
                        await withTimeout(sock.sendMessage(selfJid, { text: plain }), 20000, 'sending the session to WhatsApp');
                        dmSent = true;
                    } catch (err) {
                        console.error(`[session] DM attempt ${i}/3 failed:`, err.message);
                        if (i < 3) await sleep(2000 * i);
                    }
                }
                if (dmSent) {
                    console.log(`[session ${id}] SESSION_ID sent to self-chat`);
                    socket.emit('dm-sent', { message: 'Session also sent to your WhatsApp “Message yourself” chat.' });
                    try { await withTimeout(sendSessionCopyCard(sock, selfJid, portable), 15000, 'copy button message'); } catch {}
                } else {
                    socket.emit('status', { message: 'Could not DM the session to WhatsApp. Copy it from this page instead.' });
                }
            } catch (err) {
                console.error('[session] self-message failed:', err.message);
                socket.emit('status', { message: `Could not DM the session to WhatsApp (${err.message}). Copy it from this page instead.` });
            }

            // Close the generator socket: two live connections on one session make
            // WhatsApp log one of them out once the bot connects. Remove the keys
            // from disk too — the portable string is all the bot needs.
            await sleep(4000); // let queued receipts/acks flush before closing
            await killSocket(id);
            await fs.remove(sessionPath).catch(() => {});
            console.log(`[session ${id}] generator socket closed — handed off to bot`);
        }

        await spawn();
    }

    socket.on('start-session', (data) => {
        queue = queue
            .then(() => startLinking(data))
            .catch((err) => {
                console.error('[start-session] error:', err);
                socket.emit('error', { message: 'Internal error: ' + err.message });
            });
    });

    socket.on('cancel-session', () => {
        queue = queue.then(async () => {
            await teardown(current);
            socket.emit('cancelled');
        }).catch(() => {});
    });

    socket.on('disconnect', () => {
        console.log('client disconnected:', socket.id);
        // Browser gone => nobody is waiting for this link; free the socket now.
        // (An already-linked session is left alone so the bot can still fetch it.)
        const attempt = current;
        if (attempt && !attempt.linked) teardown(attempt).catch(() => {});
    });
});

// ---------- lifecycle ----------
const cleanupTimer = setInterval(() => {
    cleanupExpired().catch((err) => console.error('cleanup error:', err.message));
}, 10 * 60 * 1000);
cleanupTimer.unref();

function start(port = PORT) {
    return new Promise((resolve) => {
        httpServer.listen(port, () => {
            console.log(`MEGA MIND SESSION SERVER running on port ${httpServer.address().port}`);
            resolve(httpServer);
        });
    });
}

async function shutdown() {
    for (const id of [...liveSockets.keys()]) await killSocket(id);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && err.message ? err.message : err));

module.exports = { app, httpServer, io, start, _setBaileysForTests: (mock) => { B = mock; } };

if (require.main === module) start();
