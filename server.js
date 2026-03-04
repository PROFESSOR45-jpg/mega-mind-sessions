const express = require('express');
const path = require('path');
const pairCode = require('./pairCode');
const qrSession = require('./qrSession');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== PAIR CODE ENDPOINTS ====================

app.get('/api/pair/generate', async (req, res) => {
    const { phone } = req.query;
    
    if (!phone) {
        return res.status(400).json({ 
            success: false, 
            error: 'Phone number required' 
        });
    }

    try {
        const sessionId = pairCode.generateSessionId();
        await pairCode.createPairSession(sessionId, phone);
        
        setTimeout(() => {
            const status = pairCode.getStatus(sessionId);
            res.json({
                success: true,
                sessionId: sessionId,
                code: status.code || null,
                phone: phone,
                message: 'Enter this code in WhatsApp'
            });
        }, 2000);
        
    } catch (error) {
        console.error('Pair generation error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/pair/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = pairCode.getStatus(sessionId);
    res.json(status);
});

app.get('/api/pair/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = pairCode.getSession(sessionId);
    
    if (session) {
        res.json({
            status: 'connected',
            session: session
        });
    } else {
        res.json({
            status: 'waiting',
            session: null
        });
    }
});

app.delete('/api/pair/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await pairCode.deleteSession(sessionId);
    res.json({ success: true, message: 'Session deleted' });
});

// ==================== QR CODE ENDPOINTS ====================

app.get('/api/qr/generate', async (req, res) => {
    try {
        const sessionId = qrSession.generateSessionId();
        await qrSession.createQRSession(sessionId);
        
        res.json({
            success: true,
            sessionId: sessionId,
            message: 'QR generation started'
        });
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/qr/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = qrSession.getStatus(sessionId);
    res.json(status);
});

app.get('/api/qr/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = qrSession.getSession(sessionId);
    
    if (session) {
        res.json({
            status: 'connected',
            session: session
        });
    } else {
        res.json({
            status: 'waiting',
            session: null
        });
    }
});

app.delete('/api/qr/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    await qrSession.deleteSession(sessionId);
    res.json({ success: true, message: 'Session deleted' });
});

// ==================== ADMIN & HEALTH ====================

app.get('/admin/sessions', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    res.json({
        pairSessions: pairCode.activeSockets ? Array.from(pairCode.activeSockets.keys()) : [],
        qrSessions: qrSession.activeSockets ? Array.from(qrSession.activeSockets.keys()) : []
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'running', 
        service: 'MEGA MIND Session Server',
        version: '3.0.0',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`
    ███╗   ███╗███████╗ ██████╗  █████╗     ███╗   ███╗██╗███╗   ██╗██████╗ 
    ████╗ ████║██╔════╝██╔════╝ ██╔══██╗    ████╗ ████║██║████╗  ██║██╔══██╗
    ██╔████╔██║█████╗  ██║  ███╗███████║    ██╔████╔██║██║██╔██╗ ██║██║  ██║
    ██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║
    ██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝
    ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝ 
                                                                            
     🔐 Session Server Running on port ${PORT}
     📱 Pair Code Endpoint: /api/pair/generate
     📷 QR Code Endpoint: /api/qr/generate
     🌐 3D Interface: http://localhost:${PORT}
    `);
});

module.exports = app;
