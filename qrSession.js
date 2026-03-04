// mega-mind-sessions/index.js (or server.js)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    Browsers 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active sessions
const sessions = new Map();

// Logger
const logger = pino({ level: 'silent' });

// Create session directory if not exists
const SESSION_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

/**
 * Create WhatsApp Socket with latest Baileys config
 */
async function createSession(sessionId, socket) {
    const sessionPath = path.join(SESSION_DIR, sessionId);
    
    // Clear old session if exists for fresh start
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Fetch latest Baileys version for compatibility
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using Baileys version: ${version.join('.')}, Latest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Chrome'), // More stable browser fingerprint
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30000,
        // Important: Disable mobile platform to ensure QR works
        mobile: false,
        // Connection retry logic
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
    });

    // Store session
    sessions.set(sessionId, { sock, socket, sessionPath });

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code received - send to frontend
        if (qr) {
            try {
                // Generate QR as data URL
                const qrDataUrl = await QRCode.toDataURL(qr, {
                    width: 400,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#ffffff'
                    }
                });
                
                socket.emit('qr', { 
                    qr: qrDataUrl, 
                    raw: qr,
                    message: 'Scan this QR code with WhatsApp' 
                });
                console.log(`[${sessionId}] QR Code generated`);
            } catch (err) {
                console.error('QR Generation error:', err);
                socket.emit('error', { message: 'Failed to generate QR code' });
            }
        }

        // Connection status changes
        if (connection === 'connecting') {
            socket.emit('status', { 
                status: 'connecting', 
                message: 'Connecting to WhatsApp...' 
            });
        }

        // Connected successfully
        if (connection === 'open') {
            console.log(`[${sessionId}] Connected successfully`);
            
            // Get user info
            const user = sock.user;
            
            socket.emit('connected', {
                status: 'connected',
                message: 'Successfully connected!',
                user: {
                    id: user.id,
                    name: user.name,
                    phone: user.id.split(':')[0]
                }
            });

            // Generate session data for the bot
            await generateSessionData(sessionId, socket);
        }

        // Connection closed
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${sessionId}] Connection closed. Reason: ${reason}`);

            if (reason === DisconnectReason.restartRequired) {
                console.log(`[${sessionId}] Restart required, reconnecting...`);
                socket.emit('status', { 
                    status: 'restarting', 
                    message: 'Restarting connection...' 
                });
                // Restart session
                setTimeout(() => createSession(sessionId, socket), 3000);
            } else if (shouldReconnect) {
                socket.emit('status', { 
                    status: 'reconnecting', 
                    message: 'Connection lost, reconnecting...' 
                });
                setTimeout(() => createSession(sessionId, socket), 5000);
            } else {
                socket.emit('disconnected', { 
                    status: 'disconnected',
                    message: 'Session ended. Please generate new session.' 
                });
                sessions.delete(sessionId);
            }
        }
    });

    // Handle errors
    sock.ev.on('error', (err) => {
        console.error(`[${sessionId}] Socket error:`, err);
        socket.emit('error', { message: err.message });
    });

    return sock;
}

/**
 * Generate session data file for the main bot
 */
async function generateSessionData(sessionId, socket) {
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
        // Read auth credentials
        const credsPath = path.join(session.sessionPath, 'creds.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

        // Create session data object
        const sessionData = {
            sessionId,
            creds,
            createdAt: new Date().toISOString(),
            platform: 'mega-mind'
        };

        // Save to file
        const outputPath = path.join(__dirname, 'output', `${sessionId}.json`);
        if (!fs.existsSync(path.join(__dirname, 'output'))) {
            fs.mkdirSync(path.join(__dirname, 'output'));
        }

        fs.writeFileSync(outputPath, JSON.stringify(sessionData, null, 2));

        // Send to client
        socket.emit('session-ready', {
            message: 'Session created successfully!',
            downloadUrl: `/download/${sessionId}`,
            sessionData: Buffer.from(JSON.stringify(sessionData)).toString('base64')
        });

        console.log(`[${sessionId}] Session data generated`);

    } catch (error) {
        console.error('Error generating session:', error);
        socket.emit('error', { message: 'Failed to generate session data' });
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('start-session', async (data) => {
        const sessionId = data.sessionId || `session-${Date.now()}`;
        console.log(`Starting session: ${sessionId}`);
        
        socket.emit('status', { 
            status: 'initializing', 
            message: 'Initializing WhatsApp connection...' 
        });

        try {
            await createSession(sessionId, socket);
        } catch (error) {
            console.error('Session creation error:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('request-pairing-code', async (data) => {
        const { sessionId, phoneNumber } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('error', { message: 'Session not found' });
            return;
        }

        try {
            // Format phone number (remove +, spaces, etc)
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            
            // Request pairing code
            const code = await session.sock.requestPairingCode(cleanNumber);
            
            socket.emit('pairing-code', { 
                code,
                phoneNumber: cleanNumber,
                message: `Your pairing code is: ${code}. Enter this in WhatsApp > Linked Devices > Link with phone number`
            });
            
            console.log(`[${sessionId}] Pairing code sent: ${code}`);
        } catch (error) {
            console.error('Pairing code error:', error);
            socket.emit('error', { message: 'Failed to generate pairing code. Try QR code instead.' });
        }
    });

    socket.on('disconnect-session', (data) => {
        const { sessionId } = data;
        const session = sessions.get(sessionId);
        
        if (session) {
            session.sock.logout();
            sessions.delete(sessionId);
            
            // Clean up files
            if (fs.existsSync(session.sessionPath)) {
                fs.rmSync(session.sessionPath, { recursive: true, force: true });
            }
            
            socket.emit('disconnected', { message: 'Session disconnected' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Download session endpoint
app.get('/download/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const filePath = path.join(__dirname, 'output', `${sessionId}.json`);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath, `mega-mind-session-${sessionId}.json`);
    } else {
        res.status(404).json({ error: 'Session file not found' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        activeSessions: sessions.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Mega Mind Session Server running on port ${PORT}`);
});
