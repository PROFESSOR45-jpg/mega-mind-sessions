/**
 * Basic Usage Example
 */

const { useMegaMindAuth } = require('../index');
const { default: makeWASocket } = require('@whiskeysockets/baileys');

async function basicExample() {
    const { state, saveCreds, exportSession } = await useMegaMindAuth('./session');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection === 'open') {
            console.log('Connected!');
            const sessionId = await exportSession();
            console.log('Session ID:', sessionId);
        }
    });
}

basicExample();
