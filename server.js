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

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = './sessions';

// Ensure sessions directory exists
fs.ensureDirSync(SESSIONS_DIR);

// Store active sockets
const activeSockets = new Map();

// Serve static files
app.use(express.static('public'));

// Get all sessions
app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = await fs.readdir(SESSIONS_DIR);
        const sessionData = sessions.filter(s => !s.startsWith('.')).map(id => ({
            id,
            status: activeSockets.has(id) ? 'connected' : 'disconnected',
            connectedAt: activeSockets.has(id) ? activeSockets.get(id).connectedAt : null
        }));
        res.json(sessionData);
    } catch (err) {
        res.json([]);
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    let currentSocket = null;
    let currentSessionId = null;

    // Initialize WhatsApp connection
    socket.on('init-qr', async (data) => {
        const { sessionId } = data;
        currentSessionId = sessionId;
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        
        await fs.ensureDir(sessionPath);
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', '', '']
        });

        currentSocket = sock;
        activeSockets.set(sessionId, { socket: sock, connectedAt: new Date() });

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
                } catch (err) {
                    console.error('QR generation error:', err);
                }
            }

            // Connection established
            if (connection === 'open') {
                console.log(`Session ${sessionId} connected`);
                socket.emit('connected', { 
                    sessionId, 
                    user: sock.user,
                    message: 'Successfully connected to WhatsApp!'
                });
            }

            // Connection closed
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    socket.emit('reconnecting', { sessionId, message: 'Reconnecting...' });
                } else {
                    socket.emit('disconnected', { sessionId, message: 'Logged out' });
                    activeSockets.delete(sessionId);
                    await fs.remove(sessionPath);
                }
            }
        });

        // Handle messages
        sock.ev.on('messages.upsert', async (m) => {
            console.log('New message:', m);
        });
    });

    // Request pairing code
    socket.on('request-pairing-code', async (data) => {
        const { phoneNumber, sessionId } = data;
        currentSessionId = sessionId;
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        
        await fs.ensureDir(sessionPath);
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Chrome (Linux)', '', '']
        });

        currentSocket = sock;
        activeSockets.set(sessionId, { socket: sock, connectedAt: new Date() });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            // Wait for connecting state then request pairing code
            if (connection === 'connecting' || connection === undefined) {
                try {
                    // Format phone number (remove + if present)
                    const cleanNumber = phoneNumber.replace(/\D/g, '');
                    const code = await sock.requestPairingCode(cleanNumber);
                    socket.emit('pairing-code', { code, sessionId });
                } catch (err) {
                    console.error('Pairing code error:', err);
                    socket.emit('error', { message: 'Failed to get pairing code. Try QR method instead.' });
                }
            }

            if (connection === 'open') {
                socket.emit('connected', { 
                    sessionId, 
                    user: sock.user,
                    message: 'Successfully connected to WhatsApp!'
                });
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    activeSockets.delete(sessionId);
                    await fs.remove(sessionPath);
                }
            }
        });
    });

    // Disconnect session
    socket.on('disconnect-session', async (data) => {
        const { sessionId } = data;
        if (activeSockets.has(sessionId)) {
            const { socket: sock } = activeSockets.get(sessionId);
            await sock.logout();
            activeSockets.delete(sessionId);
        }
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        await fs.remove(sessionPath);
        socket.emit('disconnected', { sessionId });
    });

    // Client disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to view the app`);
});
