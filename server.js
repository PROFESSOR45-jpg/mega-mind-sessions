const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

fs.ensureDirSync(SESSIONS_DIR);

const activeSessions = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = [];
        const sessionFolders = await fs.readdir(SESSIONS_DIR);
        
        for (const sessionId of sessionFolders.filter(s => !s.startsWith('.'))) {
            const sessionData = activeSessions.get(sessionId);
            sessions.push({
                id: sessionId,
                status: sessionData ? 'connected' : 'disconnected',
                user: sessionData?.user || null,
                connectedAt: sessionData?.connectedAt || null,
                phone: sessionData?.user?.id?.split(':')[0] || null
            });
        }
        
        res.json(sessions);
    } catch (err) {
        res.json([]);
    }
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        await disconnectSession(sessionId);
        res.json({ success: true, message: 'Session deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function disconnectSession(sessionId) {
    if (activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        try {
            await session.socket.logout();
        } catch (e) {
            console.log('Logout error:', e.message);
        }
        activeSessions.delete(sessionId);
    }
    
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    try {
        await fs.remove(sessionPath);
    } catch (e) {
        console.log('Remove session folder error:', e.message);
    }
    
    return true;
}

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    const sessionsList = Array.from(activeSessions.entries()).map(([id, data]) => ({
        id,
        status: 'connected',
        user: data.user,
        connectedAt: data.connectedAt
    }));
    socket.emit('sessions-list', sessionsList);

    socket.on('init-qr', async (data) => {
        try {
            const sessionId = data.sessionId || `session-${uuidv4()}`;
            const sessionPath = path.join(SESSIONS_DIR, sessionId);
            
            await fs.ensureDir(sessionPath);
            
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Chrome (Linux)', '', ''],
                syncFullHistory: false
            });

            const sessionData = {
                socket: sock,
                user: null,
                connectedAt: null,
                clientSocketId: socket.id,
                qrTimeout: null
            };
            activeSessions.set(sessionId, sessionData);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        socket.emit('qr', { qr: qrDataUrl, sessionId });
                        
                        if (sessionData.qrTimeout) clearTimeout(sessionData.qrTimeout);
                        sessionData.qrTimeout = setTimeout(() => {
                            socket.emit('qr-expired', { sessionId });
                        }, 60000);
                    } catch (err) {
                        console.error('QR generation error:', err);
                    }
                }

                if (connection === 'open') {
                    console.log(`Session ${sessionId} connected`);
                    sessionData.user = sock.user;
                    sessionData.connectedAt = new Date();
                    if (sessionData.qrTimeout) clearTimeout(sessionData.qrTimeout);
                    
                    socket.emit('connected', { 
                        sessionId, 
                        user: sock.user,
                        message: 'Successfully connected to WhatsApp!'
                    });
                    
                    io.emit('session-updated', {
                        id: sessionId,
                        status: 'connected',
                        user: sock.user,
                        connectedAt: sessionData.connectedAt
                    });
                }

                if (connection === 'close') {
                    const lastError = lastDisconnect?.error;
                    const statusCode = lastError?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    if (shouldReconnect) {
                        socket.emit('reconnecting', { sessionId, message: 'Reconnecting...' });
                    } else {
                        socket.emit('disconnected', { sessionId, message: 'Logged out' });
                        await disconnectSession(sessionId);
                        io.emit('session-removed', { sessionId });
                    }
                }
            });

            sock.ev.on('messages.upsert', async (m) => {
                console.log(`New message in session ${sessionId}`);
                socket.emit('new-message', { sessionId, data: m });
                io.emit('message-received', {
                    sessionId,
                    message: m.messages[0],
                    timestamp: new Date()
                });
            });

        } catch (error) {
            console.error('QR Init error:', error);
            socket.emit('error', { message: 'Failed to initialize QR: ' + error.message });
        }
    });

    socket.on('request-pairing-code', async (data) => {
        try {
            let { phoneNumber, sessionId } = data;
            
            if (!phoneNumber) {
                socket.emit('error', { message: 'Phone number is required' });
                return;
            }

            let cleanNumber = phoneNumber.replace(/\D/g, '');
            
            if (cleanNumber.startsWith('0')) {
                cleanNumber = cleanNumber.substring(1);
            }
            
            if (cleanNumber.length < 10) {
                socket.emit('error', { 
                    message: 'Invalid phone number. Please include country code (e.g., 12345678901 for US)' 
                });
                return;
            }

            console.log(`Requesting pairing code for: ${cleanNumber}`);

            sessionId = sessionId || `session-${uuidv4()}`;
            const sessionPath = path.join(SESSIONS_DIR, sessionId);
            
            await fs.ensureDir(sessionPath);
            
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                syncFullHistory: false
            });

            const sessionData = {
                socket: sock,
                user: null,
                connectedAt: null,
                clientSocketId: socket.id,
                pairingCode: null
            };
            activeSessions.set(sessionId, sessionData);

            sock.ev.on('creds.update', saveCreds);

            let codeRequested = false;

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                console.log(`Connection update for ${sessionId}:`, connection);

                if (!codeRequested && connection === 'connecting') {
                    try {
                        codeRequested = true;
                        
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        console.log(`Requesting pairing code for ${cleanNumber}...`);
                        
                        const code = await sock.requestPairingCode(cleanNumber);
                        
                        console.log(`Pairing code received: ${code}`);
                        
                        sessionData.pairingCode = code;
                        socket.emit('pairing-code', { code, sessionId });
                        
                    } catch (err) {
                        console.error('Pairing code request failed:', err);
                        
                        let errorMsg = 'Failed to get pairing code. ';
                        
                        if (err.message.includes('not authorized')) {
                            errorMsg += 'Phone number not authorized. Try QR code method.';
                        } else if (err.message.includes('timeout')) {
                            errorMsg += 'Request timed out. Please try again.';
                        } else if (err.message.includes('invalid')) {
                            errorMsg += 'Invalid phone number format. Use format: 12345678901';
                        } else {
                            errorMsg += 'Try using QR code method instead.';
                        }
                        
                        socket.emit('error', { message: errorMsg });
                        
                        await disconnectSession(sessionId);
                    }
                }

                if (connection === 'open') {
                    console.log(`Session ${sessionId} connected successfully`);
                    sessionData.user = sock.user;
                    sessionData.connectedAt = new Date();
                    
                    socket.emit('connected', { 
                        sessionId, 
                        user: sock.user,
                        message: 'Successfully connected to WhatsApp!'
                    });
                    
                    io.emit('session-updated', {
                        id: sessionId,
                        status: 'connected',
                        user: sock.user,
                        connectedAt: sessionData.connectedAt
                    });
                }

                if (connection === 'close') {
                    const lastError = lastDisconnect?.error;
                    const statusCode = lastError?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    if (!shouldReconnect) {
                        await disconnectSession(sessionId);
                        io.emit('session-removed', { sessionId });
                    }
                }
            });

        } catch (error) {
            console.error('Pairing code error:', error);
            socket.emit('error', { 
                message: 'Failed to request pairing code: ' + error.message 
            });
        }
    });

    socket.on('connect-existing', async (data) => {
        const { sessionId } = data;
        if (activeSessions.has(sessionId)) {
            socket.emit('session-resumed', { sessionId, message: 'Connected to existing session' });
        } else {
            try {
                const sessionPath = path.join(SESSIONS_DIR, sessionId);
                if (await fs.pathExists(sessionPath)) {
                    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
                    const { version } = await fetchLatestBaileysVersion();
                    
                    const sock = makeWASocket({
                        version,
                        auth: state,
                        logger: P({ level: 'silent' }),
                        printQRInTerminal: false,
                        browser: ['Chrome (Linux)', '', ''],
                        syncFullHistory: false
                    });

                    activeSessions.set(sessionId, {
                        socket: sock,
                        user: null,
                        connectedAt: null,
                        clientSocketId: socket.id
                    });

                    sock.ev.on('creds.update', saveCreds);
                    sock.ev.on('connection.update', async (update) => {
                        const { connection } = update;
                        if (connection === 'open') {
                            const session = activeSessions.get(sessionId);
                            if (session) {
                                session.user = sock.user;
                                session.connectedAt = new Date();
                            }
                            socket.emit('connected', { sessionId, user: sock.user });
                        }
                    });

                    socket.emit('session-restoring', { sessionId });
                }
            } catch (err) {
                socket.emit('error', { message: 'Failed to restore session' });
            }
        }
    });

    socket.on('disconnect-session', async (data) => {
        const { sessionId } = data;
        await disconnectSession(sessionId);
        socket.emit('disconnected', { sessionId });
        io.emit('session-removed', { sessionId });
    });

    socket.on('get-sessions', () => {
        const sessions = Array.from(activeSessions.entries()).map(([id, data]) => ({
            id,
            status: 'connected',
            user: data.user,
            connectedAt: data.connectedAt
        }));
        socket.emit('sessions-list', sessions);
    });

    socket.on('switch-session', (data) => {
        const { sessionId } = data;
        if (activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            socket.emit('session-switched', {
                sessionId,
                user: session.user,
                connectedAt: session.connectedAt
            });
        } else {
            socket.emit('error', { message: 'Session not found' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

httpServer.listen(PORT, () => {
    console.log(`Multi-Device WhatsApp Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to view the app`);
});
