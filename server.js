const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs-extra');
const pino = require('pino');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = './sessions';

// Ensure sessions directory exists
fs.ensureDirSync(SESSIONS_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache for storing QR codes and session data
const qrCache = new NodeCache({ stdTTL: 300 }); // 5 minutes
const sessionCache = new NodeCache({ stdTTL: 600 }); // 10 minutes

// Logger
const logger = pino({ level: 'silent' });

// Active sockets storage
const activeSockets = new Map();

// Generate Session ID
function generateSessionId() {
    return 'MEGA_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Create WhatsApp Socket
async function createSession(sessionId, res) {
    const sessionPath = `${SESSIONS_DIR}/${sessionId}`;
    
    // Clean previous session if exists
    if (activeSockets.has(sessionId)) {
        const oldSock = activeSockets.get(sessionId);
        try {
            await oldSock.logout();
        } catch {}
        activeSockets.delete(sessionId);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        logger: logger,
        browser: ['MEGA MIND Session', 'Chrome', '1.0.0']
    });

    activeSockets.set(sessionId, sock);

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !qrSent) {
            qrSent = true;
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
                
                // Store in cache
                qrCache.set(sessionId, {
                    qr: qrDataUrl,
                    status: 'waiting',
                    timestamp: Date.now()
                });

                console.log(`[${sessionId}] QR Code generated`);
            } catch (err) {
                console.error('QR Generation error:', err);
            }
        }

        if (connection === 'open') {
            console.log(`[${sessionId}] Connected successfully!`);
            
            // Get session credentials
            const creds = state.creds;
            const sessionData = Buffer.from(JSON.stringify(creds)).toString('base64');
            
            // Store session
            sessionCache.set(sessionId, {
                status: 'connected',
                session: sessionData,
                user: sock.user,
                timestamp: Date.now()
            });
            
            qrCache.set(sessionId, {
                ...qrCache.get(sessionId),
                status: 'connected'
            });

            // Save to file for persistence
            await fs.writeFile(`${sessionPath}/session.txt`, sessionData);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (!shouldReconnect) {
                console.log(`[${sessionId}] Logged out`);
                activeSockets.delete(sessionId);
                sessionCache.del(sessionId);
                qrCache.del(sessionId);
                await fs.remove(sessionPath);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// Routes

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'MEGA MIND Session Server Running',
        version: '1.0.0',
        endpoints: {
            generate: '/generate',
            qr: '/qr/:sessionId',
            session: '/session/:sessionId',
            status: '/status/:sessionId'
        }
    });
});

// Generate new session
app.get('/generate', async (req, res) => {
    const sessionId = generateSessionId();
    
    try {
        await createSession(sessionId);
        
        res.json({
            success: true,
            sessionId: sessionId,
            qrUrl: `${req.protocol}://${req.get('host')}/qr/${sessionId}`,
            statusUrl: `${req.protocol}://${req.get('host')}/status/${sessionId}`,
            message: 'Scan QR code within 5 minutes'
        });
    } catch (error) {
        console.error('Generate error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate session'
        });
    }
});

// Get QR Code page
app.get('/qr/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>MEGA MIND - Scan QR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: white;
                padding: 20px;
            }
            .container {
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                max-width: 500px;
                width: 100%;
                box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                border: 1px solid rgba(255, 255, 255, 0.18);
            }
            h1 { margin-bottom: 10px; font-size: 2.5em; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
            .subtitle { opacity: 0.9; margin-bottom: 30px; font-size: 1.1em; }
            #qr-container {
                background: white;
                padding: 20px;
                border-radius: 15px;
                margin: 20px 0;
                min-height: 300px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #qr-image { max-width: 100%; height: auto; }
            .status {
                margin-top: 20px;
                padding: 15px;
                border-radius: 10px;
                font-weight: bold;
                font-size: 1.1em;
            }
            .waiting { background: #f39c12; }
            .connected { background: #27ae60; }
            .expired { background: #e74c3c; }
            .session-box {
                background: rgba(0,0,0,0.3);
                padding: 15px;
                border-radius: 10px;
                margin-top: 20px;
                word-break: break-all;
                font-family: monospace;
                font-size: 0.9em;
                display: none;
            }
            .timer {
                margin-top: 15px;
                font-size: 0.9em;
                opacity: 0.8;
            }
            .instructions {
                margin-top: 20px;
                text-align: left;
                background: rgba(255,255,255,0.1);
                padding: 15px;
                border-radius: 10px;
                font-size: 0.9em;
            }
            .instructions ol { margin-left: 20px; }
            .instructions li { margin: 8px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🔐 MEGA MIND</h1>
            <p class="subtitle">WhatsApp Session Generator</p>
            
            <div id="qr-container">
                <div id="loading">Generating QR Code...</div>
                <img id="qr-image" style="display:none;" alt="QR Code">
            </div>
            
            <div id="status" class="status waiting">⏳ Waiting for scan...</div>
            
            <div id="session-data" class="session-box">
                <strong>SESSION ID:</strong><br>
                <span id="session-text"></span>
            </div>
            
            <div class="timer" id="timer">QR expires in: 5:00</div>
            
            <div class="instructions">
                <strong>📱 How to connect:</strong>
                <ol>
                    <li>Open WhatsApp on your phone</li>
                    <li>Tap Menu (⋮) → Linked Devices</li>
                    <li>Tap "Link a Device"</li>
                    <li>Scan the QR code above</li>
                    <li>Wait for "Connected" status</li>
                    <li>Copy the Session ID shown</li>
                </ol>
            </div>
        </div>

        <script>
            const sessionId = '${sessionId}';
            let checkInterval;
            let timeLeft = 300; // 5 minutes
            
            function updateTimer() {
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft % 60;
                document.getElementById('timer').textContent = 
                    \`QR expires in: \${minutes}:\${seconds.toString().padStart(2, '0')}\`;
                if (timeLeft > 0) timeLeft--;
            }
            
            async function checkStatus() {
                try {
                    const response = await fetch('/status/' + sessionId);
                    const data = await response.json();
                    
                    if (data.qr) {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('qr-image').src = data.qr;
                        document.getElementById('qr-image').style.display = 'block';
                    }
                    
                    if (data.status === 'connected') {
                        document.getElementById('status').className = 'status connected';
                        document.getElementById('status').textContent = '✅ Connected! Copy Session ID below';
                        document.getElementById('timer').style.display = 'none';
                        
                        // Get session data
                        const sessionRes = await fetch('/session/' + sessionId);
                        const sessionData = await sessionRes.json();
                        
                        if (sessionData.session) {
                            document.getElementById('session-data').style.display = 'block';
                            document.getElementById('session-text').textContent = sessionData.session;
                            clearInterval(checkInterval);
                        }
                    } else if (data.status === 'expired') {
                        document.getElementById('status').className = 'status expired';
                        document.getElementById('status').textContent = '❌ Session expired. Generate new one.';
                        clearInterval(checkInterval);
                    }
                } catch (e) {
                    console.error('Check error:', e);
                }
            }
            
            checkInterval = setInterval(() => {
                checkStatus();
                updateTimer();
            }, 2000);
            
            checkStatus();
            updateTimer();
        </script>
    </body>
    </html>
    `);
});

// API: Get QR status
app.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const data = qrCache.get(sessionId);
    
    if (!data) {
        return res.json({ status: 'expired', qr: null });
    }
    
    res.json(data);
});

// API: Get Session Data (after connection)
app.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const data = sessionCache.get(sessionId);
    
    if (!data || data.status !== 'connected') {
        return res.json({ status: 'waiting', session: null });
    }
    
    res.json({
        status: 'connected',
        session: data.session,
        user: data.user
    });
});

// Delete session
app.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    if (activeSockets.has(sessionId)) {
        try {
            await activeSockets.get(sessionId).logout();
        } catch {}
        activeSockets.delete(sessionId);
    }
    
    sessionCache.del(sessionId);
    qrCache.del(sessionId);
    await fs.remove(`${SESSIONS_DIR}/${sessionId}`);
    
    res.json({ success: true, message: 'Session deleted' });
});

// Get all active sessions (admin)
app.get('/admin/sessions', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const sessions = [];
    qrCache.keys().forEach(key => {
        sessions.push({
            sessionId: key,
            ...qrCache.get(key)
        });
    });
    
    res.json({ sessions });
});

app.listen(PORT, () => {
    console.log(`🚀 MEGA MIND Session Server running on port ${PORT}`);
    console.log(`📱 Generate session at: http://localhost:${PORT}/generate`);
});
