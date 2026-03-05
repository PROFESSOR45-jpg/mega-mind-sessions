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

    // QR Code Connection
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

    // FIXED: Pairing Code with proper timing
    socket.on('request-pairing-code', async (data) => {
        let sessionId = null;
        let sock = null;
        
        try {
            let { phoneNumber } = data;
            
            if (!phoneNumber) {
                socket.emit('error', { message: 'Phone number is required' });
                return;
            }

            // Clean phone number
            let cleanNumber = phoneNumber.replace(/\D/g, '');
            
            // Remove leading 0 if present
            if (cleanNumber.startsWith('0')) {
                cleanNumber = cleanNumber.substring(1);
            }
            
            // Validate
            if (cleanNumber.length < 10) {
                socket.emit('error', { 
                    message: 'Invalid phone number. Include country code (e.g., 12345678901 for US)' 
                });
                return;
            }

            console.log(`Setting up pairing code for: ${cleanNumber}`);

            sessionId = `session-${uuidv4()}`;
            const sessionPath = path.join(SESSIONS_DIR, sessionId);
            
            await fs.ensureDir(sessionPath);
            
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            // IMPORTANT: Use specific browser for pairing code
            sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Chrome (Linux)', '', ''],
                syncFullHistory: false,
                // IMPORTANT: Mark as mobile pairing
                mobileSocket: true
            });

            const sessionData = {
                socket: sock,
                user: null,
                connectedAt: null,
                clientSocketId: socket.id,
                pairingCode: null,
                pairingRequested: false
            };
            activeSessions.set(sessionId, sessionData);

            // Handle credentials update
            sock.ev.on('creds.update', saveCreds);

            // Handle connection updates
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                console.log(`[${sessionId}] Connection state:`, connection);

                // If we get QR, pairing code failed - show QR instead
                if (qr && !sessionData.pairingRequested) {
                    console.log(`[${sessionId}] QR received instead of pairing code`);
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        socket.emit('qr-instead', { qr: qrDataUrl, sessionId, message: 'Pairing code not available for this number. Use QR code instead.' });
                    } catch (err) {
                        console.error('QR generation error:', err);
                    }
                    return;
                }

                // Connection successful
                if (connection === 'open') {
                    console.log(`[${sessionId}] Connected successfully`);
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

                // Connection closed
                if (connection === 'close') {
                    const lastError = lastDisconnect?.error;
                    const statusCode = lastError?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    console.log(`[${sessionId}] Connection closed. Should reconnect:`, shouldReconnect);
                    
                    if (!shouldReconnect) {
                        await disconnectSession(sessionId);
                        io.emit('session-removed', { sessionId });
                    }
                }
            });

            // Handle messages
            sock.ev.on('messages.upsert', async (m) => {
                socket.emit('new-message', { sessionId, data: m });
                io.emit('message-received', {
                    sessionId,
                    message: m.messages[0],
                    timestamp: new Date()
                });
            });

            // CRITICAL: Wait for socket to be ready before requesting pairing code
            // The socket needs to establish connection to WhatsApp servers first
            console.log(`[${sessionId}] Waiting for socket to initialize...`);
            
            // Wait longer for connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Check if socket is connected
            if (!sock.ws || sock.ws.readyState !== 1) {
                console.log(`[${sessionId}] Socket not ready, waiting more...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Request pairing code
            try {
                console.log(`[${sessionId}] Requesting pairing code for ${cleanNumber}`);
                sessionData.pairingRequested = true;
                
                const code = await sock.requestPairingCode(cleanNumber);
                
                console.log(`[${sessionId}] Pairing code received: ${code}`);
                sessionData.pairingCode = code;
                
                socket.emit('pairing-code', { code, sessionId });
                
            } catch (pairingErr) {
                console.error(`[${sessionId}] Pairing code error:`, pairingErr.message);
                
                // If pairing code fails, try to get QR instead
                socket.emit('pairing-failed', { 
                    sessionId, 
                    message: 'Pairing code failed: ' + pairingErr.message + '. Try QR code method instead.' 
                });
                
                // Don't disconnect - let QR be generated
                sessionData.pairingRequested = false;
            }

        } catch (error) {
            console.error('Pairing code setup error:', error);
            socket.emit('error', { 
                message: 'Failed to setup pairing code: ' + error.message 
            });
            
            // Cleanup on error
            if (sessionId && activeSessions.has(sessionId)) {
                await disconnectSession(sessionId);
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
