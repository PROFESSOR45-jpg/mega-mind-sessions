/**
 * Enhanced Multi-File Auth State
 * Baileys-compatible with additional features
 */

const fs = require('fs-extra');
const path = require('path');
const { BufferJSON } = require('@whiskeysockets/baileys');

async function useEnhancedMultiFileAuthState(dir = './session') {
    
    await fs.ensureDir(dir);

    const credsFile = path.join(dir, 'creds.json');
    const keysDir = path.join(dir, 'keys');
    await fs.ensureDir(keysDir);

    async function readCreds() {
        try {
            if (await fs.pathExists(credsFile)) {
                const data = await fs.readFile(credsFile, { encoding: 'utf-8' });
                return JSON.parse(data, BufferJSON.reviver);
            }
        } catch (err) {
            console.error('Error reading credentials:', err.message);
        }
        
        return {
            noiseKey: undefined,
            signedIdentityKey: undefined,
            signedPreKey: undefined,
            registrationId: -1,
            advSecretKey: '',
            me: undefined,
            accountSyncCounter: 0,
            accountSettings: undefined,
            deviceId: undefined,
            phoneId: undefined,
            identityId: undefined,
            registered: false,
            backupToken: undefined,
            registration: undefined,
            pairingCode: undefined,
            lastPropHash: undefined,
            routingInfo: undefined
        };
    }

    async function writeCreds(creds) {
        await fs.writeFile(
            credsFile, 
            JSON.stringify(creds, BufferJSON.replacer, 2)
        );
    }

    function getKeyFilePath(type, id) {
        return path.join(keysDir, `${type}-${id}.json`);
    }

    async function readKeys() {
        const keys = {
            preKeys: {},
            sessions: {},
            senderKeys: {},
            appStateSyncKeys: {},
            appStateVersions: {}
        };

        try {
            const files = await fs.readdir(keysDir);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const filePath = path.join(keysDir, file);
                const data = await fs.readFile(filePath, { encoding: 'utf-8' });
                const parsed = JSON.parse(data, BufferJSON.reviver);
                
                const match = file.match(/^(.+)-(.+)\\.json$/);
                if (match) {
                    const [, type, id] = match;
                    if (keys[type] !== undefined) {
                        keys[type][id] = parsed;
                    }
                }
            }
        } catch (err) {
            console.error('Error reading keys:', err.message);
        }

        return keys;
    }

    async function writeKey(type, id, data) {
        const filePath = getKeyFilePath(type, id);
        await fs.writeFile(
            filePath, 
            JSON.stringify(data, BufferJSON.replacer, 2)
        );
    }

    async function removeKey(type, id) {
        const filePath = getKeyFilePath(type, id);
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
        }
    }

    const creds = await readCreds();
    const keys = await readKeys();

    async function saveCreds() {
        await writeCreds(creds);
    }

    const keyHandlers = {
        set: async ({ key, value }) => {
            const { type, id } = key;
            keys[type] = keys[type] || {};
            keys[type][id] = value;
            await writeKey(type, id, value);
        },
        get: ({ key }) => {
            const { type, id } = key;
            return keys[type]?.[id];
        },
        del: async ({ key }) => {
            const { type, id } = key;
            delete keys[type]?.[id];
            await removeKey(type, id);
        }
    };

    return {
        state: {
            creds,
            keys: {
                get: keyHandlers.get,
                set: keyHandlers.set,
                del: keyHandlers.del
            }
        },
        saveCreds,
        exportSession: async () => {
            const sessionData = {
                creds: await fs.readFile(credsFile, 'utf-8'),
                keys: {}
            };
            
            const keyFiles = await fs.readdir(keysDir);
            for (const file of keyFiles) {
                if (file.endsWith('.json')) {
                    const content = await fs.readFile(
                        path.join(keysDir, file), 
                        'utf-8'
                    );
                    sessionData.keys[file] = content;
                }
            }
            
            return Buffer.from(JSON.stringify(sessionData)).toString('base64');
        },
        importSession: async (base64Session) => {
            try {
                const sessionData = JSON.parse(
                    Buffer.from(base64Session, 'base64').toString('utf-8')
                );
                
                await fs.emptyDir(dir);
                await fs.ensureDir(keysDir);
                
                if (sessionData.creds) {
                    await fs.writeFile(credsFile, sessionData.creds);
                }
                
                for (const [file, content] of Object.entries(sessionData.keys)) {
                    await fs.writeFile(path.join(keysDir, file), content);
                }
                
                return true;
            } catch (err) {
                console.error('Session import failed:', err.message);
                return false;
            }
        },
        clearSession: async () => {
            await fs.emptyDir(dir);
            await fs.ensureDir(keysDir);
        },
        getSessionInfo: async () => {
            const info = await readCreds();
            const keyFiles = await fs.readdir(keysDir).catch(() => []);
            return {
                registered: info.registered,
                phone: info.me?.id?.split(':')[0] || 'unknown',
                deviceId: info.deviceId,
                keyCount: keyFiles.filter(f => f.endsWith('.json')).length,
                path: dir
            };
        }
    };
}

class SessionManager {
    constructor(baseDir = './sessions') {
        this.baseDir = baseDir;
        fs.ensureDirSync(baseDir);
    }

    async getSession(sessionId) {
        const sessionDir = path.join(this.baseDir, sessionId);
        return await useEnhancedMultiFileAuthState(sessionDir);
    }

    async listSessions() {
        const dirs = await fs.readdir(this.baseDir);
        const sessions = [];
        
        for (const dir of dirs) {
            const sessionDir = path.join(this.baseDir, dir);
            const stat = await fs.stat(sessionDir);
            
            if (stat.isDirectory()) {
                const credsFile = path.join(sessionDir, 'creds.json');
                if (await fs.pathExists(credsFile)) {
                    const data = await fs.readFile(credsFile, 'utf-8');
                    const creds = JSON.parse(data);
                    sessions.push({
                        id: dir,
                        registered: creds.registered,
                        phone: creds.me?.id?.split(':')[0] || 'unknown',
                        lastModified: stat.mtime
                    });
                }
            }
        }
        
        return sessions;
    }

    async deleteSession(sessionId) {
        const sessionDir = path.join(this.baseDir, sessionId);
        if (await fs.pathExists(sessionDir)) {
            await fs.remove(sessionDir);
            return true;
        }
        return false;
    }

    async backupSession(sessionId, backupPath) {
        const sessionDir = path.join(this.baseDir, sessionId);
        const { exportSession } = await useEnhancedMultiFileAuthState(sessionDir);
        const sessionData = await exportSession();
        
        await fs.writeFile(backupPath, sessionData);
        return true;
    }

    async restoreSession(sessionId, backupPath) {
        const sessionDir = path.join(this.baseDir, sessionId);
        const sessionData = await fs.readFile(backupPath, 'utf-8');
        
        const { importSession } = await useEnhancedMultiFileAuthState(sessionDir);
        return await importSession(sessionData);
    }
}

module.exports = {
    useEnhancedMultiFileAuthState,
    SessionManager
};
