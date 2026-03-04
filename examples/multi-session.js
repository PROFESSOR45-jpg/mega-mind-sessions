/**
 * Multi-Session Example
 */

const { SessionManager } = require('../index');
const { default: makeWASocket } = require('@whiskeysockets/baileys');

async function multiSessionExample() {
    const manager = new SessionManager('./multi-sessions');
    
    // Create 2 sessions
    const user1 = await manager.getSession('user1');
    const user2 = await manager.getSession('user2');
    
    const sock1 = makeWASocket({ auth: user1.state });
    const sock2 = makeWASocket({ auth: user2.state });
    
    sock1.ev.on('creds.update', user1.saveCreds);
    sock2.ev.on('creds.update', user2.saveCreds);
    
    console.log('Sessions:', await manager.listSessions());
}

multiSessionExample();
