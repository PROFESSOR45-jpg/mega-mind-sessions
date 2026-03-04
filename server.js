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

// Ensure sessions directory exists
fs.ensureDirSync(SESSIONS_DIR);

// Store all active sessions (multi-device support)
const activeSessions = new Map(); // sessionId -> { socket, user, connectedAt, clientSocketId }

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Get all sessions endpoint
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

// Delete session endpoint
app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        await disconnectSession(sessionId);
        res.json({ success: true, message: 'Session deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect and cleanup session
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

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Send current sessions to new client
    const sessionsList = Array.from(activeSessions.entries()).map(([id, data]) => ({
        id,
        status: 'connected',
        user: data.user,
        connectedAt: data.connectedAt
    }));
    socket.emit('sessions-list', sessionsList);

    // Initialize new WhatsApp connection (QR)
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

            // Store session data
            const sessionData = {
                socket: sock,
                user: null,
                connectedAt: null,
                clientSocketId: socket.id,
                qrTimeout: null
            };
            activeSessions.set(sessionId, sessionData);

            // Save credentials when updated
            sock.ev.on('creds.update', saveCreds);

            // Connection updates
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // Send QR code to frontend
                if (qr) {
                    try {
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        socket.emit('qr', { qr: qrDataUrl, sessionId });
                        
                        // QR expires in 60 seconds, auto-regenerate
                        if (sessionData.qrTimeout) clearTimeout(sessionData.qrTimeout);
                        sessionData.qrTimeout = setTimeout(() => {
                            socket.emit('qr-expired', { sessionId });
                        }, 60000);
                    } catch (err) {
                        console.error('QR generation error:', err);
                    }
                }

                // Connection established
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
                    
                    // Broadcast to all clients about new session
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
                    
                    if (shouldReconnect) {
                        socket.emit('reconnecting', { sessionId, message: 'Reconnecting...' });
                    } else {
                        socket.emit('disconnected', { sessionId, message: 'Logged out' });
                        await disconnectSession(sessionId);
                        io.emit('session-removed', { sessionId });
                    }
                }
            });

            // Handle incoming messages
            sock.ev.on('messages.upsert', async (m) => {
                console.log(`New message in session ${sessionId}`);
                socket.emit('new-message', { sessionId, data: m });
                
                // Broadcast to all clients viewing this session
                io.emit('message-received', {
                    sessionId,
                    message: m.messages[0],
                    timestamp: new Date()
                });
            });

            // Handle presence updates
            sock.ev.on('presence.update', (update) => {
                socket.emit('presence-update', { sessionId, update });
            });

        } catch (error) {
            console.error('QR Init error:', error);
            socket.emit('error', { message: 'Failed to initialize QR: ' + error.message });
        }
    });

    // Request pairing code for new session
    socket.on('request-pairing-code', async (data) => {
        try {
            const sessionId = data.sessionId || `session-${uuidv4()}`;
            const { phoneNumber } = data;
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

            let pairingCodeRequested = false;

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (!pairingCodeRequested && (connection === 'connecting' || !connection)) {
                    try {
                        pairingCodeRequested = true;
                        const cleanNumber = phoneNumber.replace(/\D/g, '');
                        const code = await sock.requestPairingCode(cleanNumber);
                        socket.emit('pairing-code', { code, sessionId });
                    } catch (err) {
                        console.error('Pairing code error:', err);
                        socket.emit('error', { message: 'Failed to get pairing code. Try QR method instead.' });
                    }
                }

                if (connection === 'open') {
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
            socket.emit('error', { message: 'Failed to request pairing code: ' + error.message });
        }
    });

    // Connect to existing session (for reconnection)
    socket.on('connect-existing', async (data) => {
        const { sessionId } = data;
        if (activeSessions.has(sessionId)) {
            socket.emit('session-resumed', { sessionId, message: 'Connected to existing session' });
        } else {
            // Try to restore from saved credentials
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

    // Disconnect specific session
    socket.on('disconnect-session', async (data) => {
        const { sessionId } = data;
        await disconnectSession(sessionId);
        socket.emit('disconnected', { sessionId });
        io.emit('session-removed', { sessionId });
    });

    // Get all active sessions
    socket.on('get-sessions', () => {
        const sessions = Array.from(activeSessions.entries()).map(([id, data]) => ({
            id,
            status: 'connected',
            user: data.user,
            connectedAt: data.connectedAt
        }));
        socket.emit('sessions-list', sessions);
    });

    // Switch to session (for multi-device management)
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

    // Client disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        // Don't disconnect WhatsApp sessions - they persist until explicitly logged out
    });
});

httpServer.listen(PORT, () => {
    console.log(`Multi-Device WhatsApp Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to view the app`);
    console.log(`Supports multiple simultaneous WhatsApp connections`);
});
