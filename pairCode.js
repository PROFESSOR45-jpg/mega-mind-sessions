const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const NodeCache = require('node-cache');

const logger = pino({ level: 'silent' });
const pairCache = new NodeCache({ stdTTL: 300 });

class PairCodeGenerator {
    constructor() {
        this.activeSockets = new Map();
    }

    generateSessionId() {
        return 'MEGA_PAIR_' + Math.random().toString(36).substring(2, 10).toUpperCase();
    }

    async createPairSession(sessionId, phoneNumber) {
        const sessionPath = `./sessions/pair_${sessionId}`;
        
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
            browser: ['Chrome (Linux)', '', ''],
            version: [2, 3000, 1015901307]
        });

        this.activeSockets.set(sessionId, sock);

        let codeRequested = false;
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (!codeRequested && sock.ws.socket) {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    codeRequested = true;
                    
                    pairCache.set(sessionId, {
                        code: code,
                        phone: phoneNumber,
                        status: 'waiting',
                        timestamp: Date.now()
                    });

                    console.log(`[${sessionId}] Pair code generated: ${code}`);
                } catch (err) {
                    console.error('Pair code error:', err);
                    pairCache.set(sessionId, {
                        error: 'Failed to generate pair code',
                        status: 'error'
                    });
                }
            }

            if (connection === 'open') {
                console.log(`[${sessionId}] Connected via Pair Code!`);
                
                const creds = state.creds;
                const sessionData = Buffer.from(JSON.stringify(creds)).toString('base64');
                
                pairCache.set(sessionId, {
                    ...pairCache.get(sessionId),
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
        return pairCache.get(sessionId) || { status: 'expired' };
    }

    getSession(sessionId) {
        const data = pairCache.get(sessionId);
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
        pairCache.del(sessionId);
        await fs.remove(`./sessions/pair_${sessionId}`);
    }
}

module.exports = new PairCodeGenerator();
