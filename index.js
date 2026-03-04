/**
 * MEGA MIND SESSIONS - Main Export
 * Advanced authentication for WhatsApp Baileys
 */

const MultiFileAuthState = require('./lib/MultiFileAuthState');
const { useEnhancedMultiFileAuthState, SessionManager } = require('./lib/enhancedAuth');

/**
 * Standard multi-file auth (Baileys compatible)
 */
async function useMultiFileAuthState(folderPath = './session') {
    const auth = new MultiFileAuthState(folderPath);
    return await auth.init();
}

/**
 * Enhanced auth with export/import
 */
async function useMegaMindAuth(folderPath = './session') {
    return await useEnhancedMultiFileAuthState(folderPath);
}

module.exports = {
    // Core classes
    MultiFileAuthState,
    SessionManager,
    
    // Functions
    useMultiFileAuthState,
    useMegaMindAuth,
    useEnhancedMultiFileAuthState
};
      
