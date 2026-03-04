const express = require('express');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.get('/api/qr', async (req, res) => {
    try {
        const sessionId = generateSessionId();
        const qrData = await QRCode.toDataURL(sessionId);
        res.json({ sessionId, qrData });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR' });
    }
});

app.get('/api/pairing-code', (req, res) => {
    const code = generatePairingCode();
    res.json({ code });
});

function generateSessionId() {
    return 'MEGA-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

function generatePairingCode() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// WebSocket for real-time updates
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        // Handle WhatsApp connection logic here
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
