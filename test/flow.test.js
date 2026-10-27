/**
 * End-to-end tests of the linking state machine using a fake Baileys.
 * Run: npm test
 * (Real WhatsApp can't be reached from CI; the fake reproduces the event
 * sequence Baileys 7.0.0-rc14 actually emits for each flow.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
const server = require('../server.js');
const { io: ioc } = require('socket.io-client');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const closeErr = (code) => ({ error: { output: { statusCode: code } } });

// ---- fake Baileys ----
function makeFake(script) {
    const f = { spawns: 0, freshAuths: 0, pairingCalls: 0, sockets: [], messages: [] };
    f.DisconnectReason = { loggedOut: 401, restartRequired: 515 };
    f.BufferJSON = { replacer: (_k, v) => v };
    f.jidNormalizedUser = (j) => j.replace(/:\d+@/, '@');
    f.fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
    f.generateWAMessageFromContent = () => ({ key: { id: 'x' }, message: {} });
    const leaf = () => ({ create: (o) => o });
    f.proto = { Message: { InteractiveMessage: { create: (o) => o, Body: leaf(), Footer: leaf(), NativeFlowMessage: { create: (o) => o, NativeFlowButton: leaf() } } } };
    f.useMultiFileAuthState = async () => {
        f.freshAuths++;
        const state = { creds: { noiseKey: { public: 1 }, registered: false }, keys: {} };
        return { state, saveCreds: async () => {} };
    };
    f.makeWASocket = (config) => {
        const n = ++f.spawns;
        const ev = new EventEmitter();
        const ws = new EventEmitter();
        ws.isOpen = true;
        const sock = {
            ev: { on: ev.on.bind(ev), emit: ev.emit.bind(ev) },
            ws,
            authState: config.auth,
            user: { id: '254700000001:7@s.whatsapp.net', name: 'Tester' },
            end() { setImmediate(() => ev.emit('connection.update', { connection: 'close', lastDisconnect: closeErr(428) })); },
            async requestPairingCode(phone) {
                f.pairingCalls++;
                assert.equal(phone, '254700000001');
                config.auth.creds.me = { id: phone + '@s.whatsapp.net', name: '~' };
                return 'ABCD1234';
            },
            async sendMessage(jid, c) { f.messages.push([jid, c]); },
            async relayMessage() { f.messages.push(['relay']); },
        };
        sock.__ev = ev;
        f.sockets.push(sock);
        const emit = (u) => ev.emit('connection.update', u);
        const paired = () => {
            Object.assign(config.auth.creds, { account: { details: 1 }, me: { id: '254700000001:7@s.whatsapp.net', lid: '1:7@lid', name: 'Tester' } });
            emit({ isNewLogin: true });
        };
        setTimeout(() => script(n, { emit, paired, config, sock }), 20);
        return sock;
    };
    return f;
}

let port;
test.before(async () => {
    await server.start(0);
    port = server.httpServer.address().port;
});
test.after(() => { server.httpServer.close(); setTimeout(() => process.exit(0), 100).unref(); });

function client() {
    const c = ioc(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    const events = [];
    for (const name of ['qr', 'paired', 'pairing-code', 'connected', 'status', 'error', 'cancelled']) {
        c.on(name, (d) => events.push([name, d]));
    }
    c.waitFor = async (name, ms = 8000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const hit = events.find((e) => e[0] === name);
            if (hit) return hit[1];
            await wait(25);
        }
        throw new Error(`timed out waiting for "${name}"; saw: ${JSON.stringify(events.map((e) => e[0]))}`);
    };
    c.events = events;
    return new Promise((res) => c.on('connect', () => res(c)));
}

test('QR link completes even though creds.registered is never set (the original bug)', async () => {
    const fake = makeFake((n, h) => {
        if (n === 1) {
            h.emit({ qr: 'qr-ref-data' });
            setTimeout(() => { h.paired(); h.emit({ connection: 'close', lastDisconnect: closeErr(515) }); }, 150);
        } else {
            h.emit({ connection: 'open' });
        }
    });
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'qr' });

    const qr = await c.waitFor('qr');
    assert.match(qr.qr, /^data:image\/png;base64,/);
    await c.waitFor('paired');
    const done = await c.waitFor('connected');
    assert.ok(done.sessionString.startsWith('MEGA~'));
    const creds = JSON.parse(Buffer.from(done.sessionString.slice(5), 'base64').toString());
    assert.equal(creds.registered, true, 'exported creds must be marked registered');
    assert.ok(creds.account && creds.me.id);
    assert.equal(c.events.filter((e) => e[0] === 'error').length, 0, 'no error events');
    assert.equal(fake.spawns, 2, 'exactly one reconnect after 515');
    assert.equal(fake.freshAuths, 1, 'creds must be KEPT across the post-pair restart');

    // REST lookup the bot uses
    const r = await fetch(`http://localhost:${port}/session/${done.sessionId}`).then((x) => x.json());
    assert.equal(r.status, 'connected');
    assert.equal(r.session, done.sessionString);

    await wait(3200); // generator socket closes + keys wiped
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'sessions', done.sessionId)), false);
    c.close();
});

test('pairing-code link completes and does not request a second code after the 515 restart', async () => {
    const fake = makeFake((n, h) => {
        if (n === 1) {
            h.emit({ qr: 'ready-signal' }); // readiness signal for pairing sockets
            setTimeout(() => { h.paired(); h.emit({ connection: 'close', lastDisconnect: closeErr(515) }); }, 300);
        } else {
            h.emit({ connection: 'open' });
        }
    });
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'pairing', phoneNumber: '+254 700 000 001' });

    const code = await c.waitFor('pairing-code');
    assert.equal(code.code, 'ABCD-1234');
    const done = await c.waitFor('connected');
    assert.ok(done.sessionString.startsWith('MEGA~'));
    assert.equal(fake.pairingCalls, 1);
    assert.equal(c.events.filter((e) => e[0] === 'error').length, 0);
    c.close();
    await wait(3200);
});

test('connection drop before pairing restarts from CLEAN keys and re-issues a code', async () => {
    const fake = makeFake((n, h) => {
        if (n === 1) {
            h.emit({ qr: 'ready' });
            setTimeout(() => h.emit({ connection: 'close', lastDisconnect: closeErr(408) }), 200);
        } else {
            h.emit({ qr: 'ready-again' });
        }
    });
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'pairing', phoneNumber: '254700000001' });
    await c.waitFor('pairing-code');
    await wait(2800); // retry back-off is 2s
    assert.equal(fake.spawns, 2);
    assert.equal(fake.freshAuths, 2, 'second spawn must NOT reuse half-registered creds');
    assert.equal(fake.pairingCalls, 2);
    c.close();
    await wait(200);
});

test('superseding an attempt leaves exactly one live socket', async () => {
    const fake = makeFake((n, h) => h.emit({ qr: 'q' + n }));
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'qr' });
    await c.waitFor('qr');
    c.emit('start-session', { method: 'qr' });
    await wait(500);
    assert.equal(fake.spawns, 2);
    assert.equal(fake.sockets.filter((s) => !s.__retired).length, 1);
    const res = await fetch(`http://localhost:${port}/health`).then((r) => r.json());
    assert.equal(res.live, 1);
    c.close();
    await wait(300);
});

test('closing the browser mid-link frees the socket and deletes the pending record', async () => {
    const fake = makeFake((n, h) => h.emit({ qr: 'q' }));
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'qr' });
    const qr = await c.waitFor('qr');
    c.close();
    await wait(400);
    const res = await fetch(`http://localhost:${port}/health`).then((r) => r.json());
    assert.equal(res.live, 0);
    const rec = await fetch(`http://localhost:${port}/status/${qr.sessionId}`);
    assert.equal(rec.status, 404);
});

test('invalid phone number is rejected immediately; logged-out is reported once', async () => {
    const fake = makeFake((n, h) => {
        h.emit({ connection: 'close', lastDisconnect: closeErr(401) });
    });
    server._setBaileysForTests(fake);
    const c = await client();
    c.emit('start-session', { method: 'pairing', phoneNumber: '12' });
    const err = await c.waitFor('error');
    assert.match(err.message, /Invalid phone number/);
    assert.equal(fake.spawns, 0);

    const c2 = await client();
    c2.emit('start-session', { method: 'qr' });
    const e2 = await c2.waitFor('error');
    assert.match(e2.message, /logged out/);
    await wait(200);
    assert.equal(c2.events.filter((e) => e[0] === 'error').length, 1);
    c.close(); c2.close();
});

test('DELETE rejects path-traversal ids', async () => {
    const r = await fetch(`http://localhost:${port}/session/..%2F..%2Fetc`, { method: 'DELETE' });
    assert.equal(r.status, 400);
});
