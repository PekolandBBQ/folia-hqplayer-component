const { createHQPlayerHost } = require('./hqplayerHost.cjs');
const { validExecutable } = require('./hqplayerDiscovery.cjs');
const { errorCode, diagnostic } = require('./errors.cjs');
const manifest = require('../component.json');

// Versioned RPC over Electron's private parent port. Node IPC supports independent CI verification.
const send = value => process.parentPort ? process.parentPort.postMessage(value) : process.send?.(value);
let host;
async function handle(message) {
    if (!Number.isSafeInteger(message?.id) || typeof message.action !== 'string') return;
    try {
        let result;
        if (message.action === 'hello') {
            if (message.protocolMajor !== manifest.protocolMajor) throw Object.assign(new Error('Protocol mismatch'), { code: 'COMPONENT_INCOMPATIBLE' });
            result = { ...manifest, componentVersion: manifest.version };
        } else if (message.action === 'initialize') {
            if (host || typeof message.configPath !== 'string') throw Object.assign(new Error('Invalid initialization'), { code: 'INVALID_REQUEST' });
            host = createHQPlayerHost({ configPath: message.configPath,
                onState: state => send({ event: 'state', state }),
                onError: error => { diagnostic(error); send({ event: 'error', errorCode: errorCode(error) }); },
                onOwnedProcess: pid => send({ event: 'owned-process', pid }) });
            host.setSilent(message.silent === true); result = { ok: true };
        } else if (message.action === 'dispose') { host?.dispose(); result = { ok: true }; }
        else {
            if (!host) throw Object.assign(new Error('Not initialized'), { code: 'INVALID_REQUEST' });
            const args = Array.isArray(message.args) ? message.args : [];
            if (message.action === 'validateExecutable') result = await validExecutable(args[0]);
            else if (['configuration', 'device', 'prepare', 'checkExisting', 'authorizeExisting', 'configure', 'load', 'command', 'stop', 'shutdown', 'dspSettings', 'setSilent'].includes(message.action))
                result = await host[message.action](...args);
            else throw Object.assign(new Error('Unknown action'), { code: 'INVALID_REQUEST' });
        }
        send({ id: message.id, ok: true, result });
        if (message.action === 'dispose') process.exit(0);
    } catch (error) { diagnostic(error); send({ id: message.id, ok: false, errorCode: errorCode(error) }); }
}
if (process.parentPort) process.parentPort.on('message', event => void handle(event.data));
else process.on('message', message => void handle(message));
process.on('disconnect', () => { host?.dispose(); process.exit(0); });
process.on('exit', () => host?.dispose());
