const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs-extra');
const NodeCache = require('node-cache');

const logger = pino({ level: 'silent' });
const qrCache = new NodeCache({ stdTTL: 300 });

class QRSessionGenerator {
    constructor() {
        this.activeSockets = new Map();
    }

    generateSessionId() {
        return 'MEGA_QR_' + Math.random().toString(36).substring(2, 10).toUpperCase();
    }

    async createQRSession(sessionId) {
        const sessionPath = `./sessions/qr_${sessionId}`;
        
        await fs.ensureDir(sessionPath);
        
        if (this.activeSockets.has(sessionId)) {
            try {
                await this.activeSockets.get(sessionId).logout();
            } catch {}
            this.activeSockets.delete(sessionId);
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        
        const sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            logger: logger,
            browser: ['MEGA MIND Session', 'Chrome', '1.0.0']
        });

        this.activeSockets.set(sessionId, sock);

        let qrGenerated = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !qrGenerated) {
                qrGenerated = true;
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, {
                        width: 400,
                        margin: 2,
                        color: {
                            dark: '#00d4ff',
                            light: '#0a0a0a'
                        }
                    });
                    
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
                console.log(`[${sessionId}] Connected via QR!`);
                
                const creds = state.creds;
                const sessionData = Buffer.from(JSON.stringify(creds)).toString('base64');
                
                qrCache.set(sessionId, {
                    ...qrCache.get(sessionId),
                    status: 'connected',
                    session: sessionData,
                    user: sock.user
                });

                await fs.writeFile(`${sessionPath}/session.txt`, sessionData);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    this.activeSockets.delete(sessionId);
                    await fs.remove(sessionPath);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return sock;
    }

    getStatus(sessionId) {
        return qrCache.get(sessionId) || { status: 'expired' };
    }

    getSession(sessionId) {
        const data = qrCache.get(sessionId);
        if (!data || data.status !== 'connected') return null;
        return data.session;
    }

    async deleteSession(sessionId) {
        if (this.activeSockets.has(sessionId)) {
            try {
                await this.activeSockets.get(sessionId).logout();
            } catch {}
            this.activeSockets.delete(sessionId);
        }
        qrCache.del(sessionId);
        await fs.remove(`./sessions/qr_${sessionId}`);
    }
}

module.exports = new QRSessionGenerator();
