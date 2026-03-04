/**
 * Multi-File Authentication State for WhatsApp
 * Secure session management with file-based credentials
 */

const fs = require('fs-extra');
const path = require('path');

class MultiFileAuthState {
    constructor(folderPath = './session') {
        this.folderPath = folderPath;
        this.credsFile = path.join(folderPath, 'creds.json');
        this.keysFolder = path.join(folderPath, 'keys');
        
        fs.ensureDirSync(this.folderPath);
        fs.ensureDirSync(this.keysFolder);
    }

    async init() {
        const creds = await this.readCreds();
        const keys = await this.readKeys();
        
        return {
            state: { creds, keys },
            saveCreds: this.saveCreds.bind(this),
            saveKey: this.saveKey.bind(this),
            deleteKey: this.deleteKey.bind(this)
        };
    }

    async readCreds() {
        try {
            if (await fs.pathExists(this.credsFile)) {
                const data = await fs.readFile(this.credsFile, 'utf-8');
                return JSON.parse(data, this.reviver);
            }
        } catch (err) {
            console.error('Error reading creds:', err.message);
        }
        
        return this.initCreds();
    }

    initCreds() {
        return {
            noiseKey: undefined,
            signedIdentityKey: undefined,
            signedPreKey: undefined,
            registrationId: undefined,
            advSecretKey: undefined,
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

    async saveCreds(creds) {
        try {
            await fs.writeFile(
                this.credsFile, 
                JSON.stringify(creds, this.replacer, 2)
            );
            return true;
        } catch (err) {
            console.error('Error saving creds:', err.message);
            return false;
        }
    }

    async readKeys() {
        const keys = {
            preKeys: {},
            sessions: {},
            senderKeys: {},
            appStateSyncKeys: {},
            appStateVersions: {}
        };

        try {
            const files = await fs.readdir(this.keysFolder);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const filePath = path.join(this.keysFolder, file);
                const data = await fs.readFile(filePath, 'utf-8');
                const parsed = JSON.parse(data, this.reviver);
                
                const [type, id] = file.replace('.json', '').split('_');
                
                if (keys[type] !== undefined) {
                    keys[type][id] = parsed;
                }
            }
        } catch (err) {
            console.error('Error reading keys:', err.message);
        }

        return keys;
    }

    async saveKey(type, id, data) {
        try {
            const fileName = `${type}_${id}.json`;
            const filePath = path.join(this.keysFolder, fileName);
            
            await fs.writeFile(
                filePath, 
                JSON.stringify(data, this.replacer, 2)
            );
            return true;
        } catch (err) {
            console.error(`Error saving key ${type}_${id}:`, err.message);
            return false;
        }
    }

    async deleteKey(type, id) {
        try {
            const fileName = `${type}_${id}.json`;
            const filePath = path.join(this.keysFolder, fileName);
            
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
            }
            return true;
        } catch (err) {
            console.error(`Error deleting key ${type}_${id}:`, err.message);
            return false;
        }
    }

    async clearAll() {
        try {
            await fs.emptyDir(this.folderPath);
            await fs.ensureDir(this.keysFolder);
            return true;
        } catch (err) {
            console.error('Error clearing auth:', err.message);
            return false;
        }
    }

    async exportSession() {
        try {
            const sessionData = {};

            if (await fs.pathExists(this.credsFile)) {
                sessionData.creds = await fs.readFile(this.credsFile, 'utf-8');
            }

            sessionData.keys = {};
            const keyFiles = await fs.readdir(this.keysFolder);
            
            for (const file of keyFiles) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(this.keysFolder, file);
                    sessionData.keys[file] = await fs.readFile(filePath, 'utf-8');
                }
            }

            const jsonStr = JSON.stringify(sessionData);
            return Buffer.from(jsonStr).toString('base64');
        } catch (err) {
            console.error('Error exporting session:', err.message);
            return null;
        }
    }

    async importSession(base64String) {
        try {
            const jsonStr = Buffer.from(base64String, 'base64').toString('utf-8');
            const sessionData = JSON.parse(jsonStr);

            await this.clearAll();

            if (sessionData.creds) {
                await fs.writeFile(this.credsFile, sessionData.creds);
            }

            if (sessionData.keys) {
                for (const [fileName, content] of Object.entries(sessionData.keys)) {
                    const filePath = path.join(this.keysFolder, fileName);
                    await fs.writeFile(filePath, content);
                }
            }

            return true;
        } catch (err) {
            console.error('Error importing session:', err.message);
            return false;
        }
    }

    async getInfo() {
        try {
            const creds = await this.readCreds();
            const keyFiles = await fs.readdir(this.keysFolder);
            
            return {
                registered: creds.registered || false,
                deviceId: creds.deviceId,
                phoneId: creds.phoneId,
                me: creds.me,
                keyCount: keyFiles.filter(f => f.endsWith('.json')).length,
                hasCreds: await fs.pathExists(this.credsFile)
            };
        } catch (err) {
            return { error: err.message };
        }
    }

    replacer(key, value) {
        if (value instanceof Buffer || value instanceof Uint8Array) {
            return {
                type: 'Buffer',
                data: Array.from(value)
            };
        }
        return value;
    }

    reviver(key, value) {
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
        }
        return value;
    }
}

module.exports = MultiFileAuthState;
