import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// Exercise checkpoint restoration across DSP restart, including paused tracks and rejected settings.
const require = createRequire(import.meta.url);
const { createHQPlayerHost } = require('../src/hqplayerHost.cjs');
const { parseDocument } = require('../src/hqplayerProtocol.cjs');
function fixture() {
    let position = 0, playing = false;
    const request = vi.fn(async (name: string, attrs?: Record<string, number>) => {
        if (name === 'Stop') { position = 0; playing = false; }
        if (name === 'Pause') playing = false;
        if (name === 'Play') { position = 0; playing = true; }
        if (name === 'Seek') position = attrs!.position;
        const replies: Record<string, string> = {
            PlaylistGet: '<PlaylistItem length="180" rate="48000" channels="2" bits="24"/>',
            GetModes: '<ModesItem index="0" value="0" name="PCM"/>',
            GetFilters: '<FiltersItem index="0" name="poly-sinc"/>',
            GetShapers: '<ShapersItem index="0" name="TPDF"/>',
            GetRates: '<RatesItem index="0" rate="192000"/>',
        };
        return parseDocument(name === 'State' ? '<State state="0" mode="0" filter="0" shaper="0" rate="0"/>'
            : `<${name} result="OK">${replies[name] || ''}</${name}>`);
    });
    const protocol = Object.assign(new EventEmitter(), { connect: async () => {}, close: () => {}, isConnected: () => true, send: () => {}, request });
    const host = createHQPlayerHost({ protocolFactory: () => protocol, findRunning: async () => [],
        probe: async () => true, discover: async () => 'hqplayer.exe', onState: vi.fn() });
    return { host, request, status: () => ({ position, playing }) };
}
const settings = { mode: 0, filter: 'poly-sinc', shaper: 'TPDF', rate: 192000 };
describe('apply settings to current track', () => {
    it.each([false, true])('restores a checkpoint and automatically plays (previously playing=%s)', async playing => {
        const { host, request, status } = fixture();
        try {
            await host.load({ session: 'track', filePath: 'source.flac' });
            if (playing) await host.command('track', 'play');
            await host.command('track', 'seek', 37);
            request.mockClear();
            const state = await host.dspSettings(settings, 'current', 'track');
            expect(state).toMatchObject({ session: 'track', playing: true, position: 37 });
            expect(status()).toEqual({ position: 37, playing: true });
            const calls = request.mock.calls.map(call => call[0]);
            expect(calls.indexOf('Play')).toBeLessThan(calls.indexOf('Seek'));
        } finally { host.dispose(); }
    });
    it('does not restart on rejected settings or a stale track', async () => {
        const { host, request, status } = fixture();
        try {
            await host.load({ session: 'track', filePath: 'source.flac' }); request.mockClear();
            await expect(host.dspSettings(settings, 'current', 'old')).rejects.toMatchObject({ code: 'CANCELLED' });
            expect(request).not.toHaveBeenCalled();
            await expect(host.dspSettings({ ...settings, filter: 'missing' }, 'current', 'track')).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
            expect(status().playing).toBe(false);
            expect(request.mock.calls.some(call => call[0] === 'Play')).toBe(false);
        } finally { host.dispose(); }
    });
});
