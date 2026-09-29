const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { findRunningHQPlayers } = require('../src/hqplayerInstance.cjs');
const { findHQPlayerExecutable } = require('../src/hqplayerDiscovery.cjs');
const { startMinimized, createHQPlayerHost } = require('../src/hqplayerHost.cjs');
const { HQPlayerProtocol } = require('../src/hqplayerProtocol.cjs');

// Exercise a real controlled Desktop instance without playing audio; preserve its DSP settings.
async function main() {
    const output = path.resolve(process.argv[2] || '../artifacts/playback-preparation-20260930/hqp-control.json');
    if ((await findRunningHQPlayers()).length) throw new Error('Close the existing HQPlayer before this isolated test');
    let pid, host, client;
    try {
        pid = await startMinimized(await findHQPlayerExecutable());
        assert.equal((await findRunningHQPlayers()).length, 1);
        host = createHQPlayerHost();
        const status = await host.configuration();
        assert.equal(status.needsConfirmation, true); assert.equal(status.instancePid, pid);
        await assert.rejects(host.prepare(), { code: 'HQPLAYER_CONFIRM_EXISTING' });
        await assert.rejects(startMinimized(await findHQPlayerExecutable(), { silent: true }), { code: 'HQPLAYER_CONFIRM_EXISTING' });
        assert.equal((await findRunningHQPlayers()).length, 1);
        await host.authorizeExisting(pid);
        // The user-facing window may still be starting while the process already exists.
        for (let i = 0; ; i++) {
            try { await host.prepare(); break; }
            catch (error) { if (i >= 40 || error.code !== 'HQPLAYER_CONTROL_UNAVAILABLE') throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
        }
        client = new HQPlayerProtocol(); client.on('error', () => {}); await client.connect();
        const before = (await client.request('State')).toString();
        const catalog = await host.dspSettings();
        const after = (await client.request('State')).toString();
        assert.equal(after, before, 'Reading catalogs must restore the original DSP configuration');
        assert.ok(catalog.modes.some(mode => mode.value === 0)); assert.ok(catalog.modes.some(mode => mode.value === 1));
        for (const mode of catalog.modes) {
            assert.ok(catalog.catalogs[mode.index].filters.length); assert.ok(catalog.catalogs[mode.index].shapers.length); assert.ok(catalog.catalogs[mode.index].rates.length);
        }
        host.dispose(); host = null;
        assert.equal((await findRunningHQPlayers()).length, 1, 'Disposing a connection must leave the external instance alive');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify({ consentRequired: true, preventedSecondInstance: true, retainedExternalInstance: true, foregroundDefault: true, before, after, catalog }, null, 2));
        console.log('PASS: foreground launch, existing-instance consent, launch mutex, both mode catalogs, DSP restoration, external ownership');
    } finally { client?.close(); host?.dispose(); if (pid) process.kill(pid); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
