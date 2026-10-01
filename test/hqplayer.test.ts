import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// test/unit/nativeAudio/hqplayer.test.ts — official XML status mapping and managed-host lifecycle.
const require = createRequire(import.meta.url);
const { parseDocument, parsePlaylistItem, parseStatus, SOURCE_REJECTED_CODE }
    = require('../src/hqplayerProtocol.cjs');
const { createHQPlayerHost, volumeToDb, waitForPlaylistItem, addPreparedPlaylist }
    = require('../src/hqplayerHost.cjs');

describe('HQPlayer Control API integration', () => {
    it('returns cloneable preparation data and waits for all Desktop instances to close', async () => {
        const protocol = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(),
            isConnected: () => true, send: vi.fn(), request: vi.fn(async () => parseDocument('<Stop result="OK"/>')) });
        let release!: () => void;
        const closeAll = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
        const kill = vi.fn(), owned = vi.fn();
        const host = createHQPlayerHost({ findRunning: async () => [], probe: async () => false,
            discover: async () => 'hqplayer.exe', launch: async () => 123, wait: async () => {},
            protocolFactory: () => protocol, closeAll, kill, onOwnedProcess: owned });
        expect(structuredClone(await host.prepare())).toEqual({ ok: true });
        let finished = false; const shutdown = host.shutdown().then(() => { finished = true; });
        await vi.waitFor(() => expect(closeAll).toHaveBeenCalledOnce());
        expect(finished).toBe(false); expect(protocol.close).toHaveBeenCalledOnce();
        expect(kill).not.toHaveBeenCalled(); expect(owned).toHaveBeenLastCalledWith(123);
        release(); await shutdown; expect(finished).toBe(true);
        expect(owned).toHaveBeenLastCalledWith(null); host.dispose(); expect(kill).not.toHaveBeenCalled();
    });
    it('maps reported playback position, duration, output delay and source format', () => {
        const status = parseStatus(parseDocument('<?xml version="1.0"?><Status state="2" position="12.4" '
            + 'display_position="12.25" length="180" active_rate="705600" active_channels="2" '
            + 'active_mode="PCM" active_filter="poly-sinc" output_delay="240000" volume="-2.5"/>'), { session: 'one' });
        expect(status).toMatchObject({ session: 'one', position: 12.4, duration: 180, playing: true,
            ended: false, sampleRate: 705600, channels: 2, latency: 0.24, volumeDb: -2.5,
            outputFormat: 'PCM · poly-sinc' });
        const item = parsePlaylistItem(parseDocument('<PlaylistGet><PlaylistItem length="180" rate="96000" '
            + 'channels="2" bits="24"/></PlaylistGet>'));
        expect(item).toEqual({ duration: 180, sampleRate: 96000, channels: 2, bits: 24 });
        const ended = parseStatus(parseDocument('<Status state="0" position="0" length="0" track_serial="8"/>'),
            { session: 'one', position: 179, duration: 180, playing: true, trackSerial: 7 });
        expect(ended).toMatchObject({ position: 180, duration: 180, playing: false, ended: true });
        const stopped = parseStatus(parseDocument('<Status state="0" position="0" length="0" track_serial="7"/>'),
            { session: 'one', position: 179.8, duration: 180, playing: true, trackSerial: 7 });
        expect(stopped).toMatchObject({ position: 0, duration: 180, playing: false, ended: false });
    });

    it('starts a missing Desktop in the background, loads without playing and routes transport commands', async () => {
        class FakeProtocol extends EventEmitter {
            connect = vi.fn(async () => {});
            close = vi.fn();
            isConnected = vi.fn(() => true);
            sent: Array<[string, Record<string, unknown>]> = [];
            send(name: string, attrs: Record<string, unknown>) { this.sent.push([name, attrs]); }
            request = vi.fn(async (name: string) => {
                if (name === 'Status') throw new Error('HQPlayer Status failed: Error');
                return name === 'PlaylistGet'
                ? parseDocument('<PlaylistGet><PlaylistItem length="8" rate="96000" channels="2" bits="24"/></PlaylistGet>')
                : parseDocument(`<${name} result="OK"/>`); });
        }
        const protocol = new FakeProtocol();
        const launch = vi.fn(async () => 43210); const kill = vi.fn();
        const onState = vi.fn();
        const host = createHQPlayerHost({ findRunning: async () => [], protocolFactory: () => protocol, discover: async () => 'D:\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe',
            probe: async () => false, launch, wait: async () => {}, kill, onState });
        expect(await host.device()).toMatchObject({ backend: 'hqplayer', id: 'hqplayer-local' });
        await expect(host.load({ session: 'track', filePath: 'C:\\Music\\source.flac' })).resolves.toMatchObject({
            session: 'track', duration: 8, sampleRate: 96000, playing: false, hqplayerGainDb: -2,
        });
        expect(protocol.request.mock.calls.some(call => call[0] === 'Status')).toBe(false);
        expect(launch).toHaveBeenCalledWith('D:\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe', { silent: false });
        expect(protocol.request).toHaveBeenCalledWith('PlaylistAdd', expect.objectContaining({
            uri: 'C:\\Music\\source.flac', clear: 1, start: 0,
        }));
        expect(protocol.request).toHaveBeenCalledWith('Volume', { value: -2 });
        await expect(host.command('track', 'play')).resolves.toMatchObject({ playing: true });
        protocol.emit('status', parseDocument('<Status state="0" position="0" length="0"/>'));
        expect(onState).not.toHaveBeenCalled();
        protocol.emit('status', parseDocument('<Status result="Error"/>'));
        expect(onState).not.toHaveBeenCalled();
        await new Promise(resolve => setTimeout(resolve, 510));
        protocol.emit('status', parseDocument('<Status state="2" position="7" length="8" track_serial="4" volume="-3.5"/>'));
        expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ hqplayerGainDb: -3.5 }));
        const validStatusCount = onState.mock.calls.length;
        protocol.emit('status', parseDocument('<Status result="Error"/>'));
        expect(onState).toHaveBeenCalledTimes(validStatusCount);
        protocol.emit('status', parseDocument('<Status state="0" position="0" length="0" track_serial="5"/>'));
        expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ position: 8, ended: true }));
        await expect(host.command('track', 'seek', 4.6)).resolves.toMatchObject({ position: 4.6 });
        const beforeSeekStatus = onState.mock.calls.length;
        protocol.emit('status', parseDocument('<Status state="1" position="0" length="8"/>'));
        expect(onState).toHaveBeenCalledTimes(beforeSeekStatus);
        protocol.emit('status', parseDocument('<Status state="1" position="5" length="8"/>'));
        expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ position: 5 }));
        await host.command('track', 'volume', 0.5);
        expect(protocol.request).toHaveBeenCalledWith('Seek', { position: 5 });
        expect(protocol.request).toHaveBeenCalledWith('Volume', { value: expect.closeTo(-9.5206, 3) });
        await host.command('track', 'gain', -4);
        expect(protocol.request).toHaveBeenCalledWith('Volume', { value: expect.closeTo(-10.0206, 3) });
        await host.command('track', 'replaygain', 2);
        expect(protocol.request).toHaveBeenLastCalledWith('Volume', { value: -4 });
        protocol.emit('status', parseDocument('<Status state="2" position="5" length="8" volume="-10"/>'));
        expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ hqplayerGainDb: -4 }));
        await host.command('track', 'volume', 1);
        expect(protocol.request).toHaveBeenLastCalledWith('Volume', { value: 0 });
        await new Promise(resolve => setTimeout(resolve, 510));
        protocol.emit('status', parseDocument('<Status state="2" position="5" length="8" volume="0"/>'));
        expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ hqplayerGainDb: -4 }));
        await host.command('track', 'replaygain', 1);
        expect(protocol.request).toHaveBeenLastCalledWith('Volume', { value: -4 });
        host.dispose(); expect(kill).toHaveBeenCalledWith(43210); expect(protocol.close).toHaveBeenCalled();
    });

    it('uses decibels for HQPlayer volume without exceeding unity gain', () => {
        expect(volumeToDb(1)).toBe(0); expect(volumeToDb(0)).toBe(-120);
        expect(volumeToDb(2)).toBe(0);
    });

    it('waits briefly for asynchronous playlist ingestion and identifies a rejected source', async () => {
        const rejected = () => parseDocument('<PlaylistGet album="0"/>');
        const accepted = parseDocument('<PlaylistGet><PlaylistItem length="184" rate="48000" channels="2" bits="32"/></PlaylistGet>');
        const client = { request: vi.fn()
            .mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected()).mockResolvedValueOnce(accepted) };
        await expect(waitForPlaylistItem(client, 500)).resolves.toMatchObject({ duration: 184, bits: 32 });
        let error: Error & { code?: string } | null = null;
        try { parsePlaylistItem(rejected()); } catch (value) { error = value as Error & { code?: string }; }
        expect(error?.code).toBe(SOURCE_REJECTED_CODE);
    });
});

describe('HQPlayer cold connection preparation', () => {
    const rejected = () => Object.assign(new Error('HQPlayer PlaylistAdd failed: Error'),
        { code: 'HQPLAYER_COMMAND_REJECTED', command: 'PlaylistAdd', result: 'Error' });
    it('waits then retries an explicit first-load rejection with playback disabled', async () => {
        let adds = 0;
        const client = { request: vi.fn(async (name: string) => {
            if (name === 'PlaylistAdd' && ++adds < 4) throw rejected();
        }) };
        const delay = vi.fn(async () => {});
        const diagnostic = vi.fn();
        await addPreparedPlaylist(client, 'source.flac', true, delay, diagnostic);
        expect(adds).toBe(4);
        expect(delay.mock.calls).toEqual([[250], [500], [1000]]);
        expect(diagnostic).toHaveBeenLastCalledWith({ attempt: 4, attempts: 6, coldConnection: true, result: 'accepted' });
        expect(client.request).toHaveBeenCalledWith('PlaylistAdd', expect.objectContaining({ clear: 1, start: 0 }));
    });
    it('stops after six explicit rejections and bounded total backoff', async () => {
        const error = rejected(); const client = { request: vi.fn(async (name: string) => { if (name === 'PlaylistAdd') throw error; }) };
        const delay = vi.fn(async () => {});
        await expect(addPreparedPlaylist(client, 'source.flac', true, delay)).rejects.toBe(error);
        expect(client.request.mock.calls.filter(call => call[0] === 'PlaylistAdd')).toHaveLength(6);
        expect(delay.mock.calls.reduce((total, call) => total + Number(call[0]), 0)).toBe(5750);
    });
    it('adds no wait to a ready cold reader', async () => {
        const client = { request: vi.fn().mockResolvedValue(undefined) }, delay = vi.fn();
        await addPreparedPlaylist(client, 'source.flac', true, delay);
        expect(client.request).toHaveBeenCalledTimes(1); expect(delay).not.toHaveBeenCalled();
    });
    it('does not repeat permission or authentication rejections', async () => {
        const error = { ...rejected(), result: 'NotAuthenticated' };
        const client = { request: vi.fn().mockRejectedValue(error) }, delay = vi.fn();
        await expect(addPreparedPlaylist(client, 'source.flac', true, delay)).rejects.toBe(error);
        expect(client.request).toHaveBeenCalledTimes(1); expect(delay).not.toHaveBeenCalled();
    });
    it.each([false, true])('does not retry ambiguous failures (cold=%s)', async cold => {
        const error = new Error('HQPlayer PlaylistAdd response timed out');
        const client = { request: vi.fn().mockRejectedValue(error) }; const delay = vi.fn();
        await expect(addPreparedPlaylist(client, 'source.flac', cold, delay)).rejects.toBe(error);
        expect(client.request).toHaveBeenCalledTimes(1); expect(delay).not.toHaveBeenCalled();
    });
    it('does not retry ordinary warm-session rejections', async () => {
        const client = { request: vi.fn().mockRejectedValue(rejected()) };
        await expect(addPreparedPlaylist(client, 'source.flac', false, async () => {})).rejects.toThrow('PlaylistAdd');
        expect(client.request).toHaveBeenCalledTimes(1);
    });
    it('retains cold recovery after an exhausted first load', async () => {
        vi.useFakeTimers();
        let rejectLoad = true;
        const diagnostic = vi.fn();
        const protocol = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(),
            isConnected: () => true, send: vi.fn(), request: vi.fn(async (name: string) => {
                if (name === 'PlaylistAdd' && rejectLoad) throw rejected();
                return parseDocument(name === 'PlaylistGet'
                    ? '<PlaylistGet><PlaylistItem length="30" rate="48000" channels="2" bits="24"/></PlaylistGet>'
                    : `<${name} result="OK"/>`);
            }) });
        const host = createHQPlayerHost({ protocolFactory: () => protocol, probe: async () => true,
            findRunning: async () => [], onDiagnostic: diagnostic });
        try {
            const failed = host.load({ session: 'first', filePath: 'source.flac' }).catch((error: Error) => error);
            await vi.advanceTimersByTimeAsync(6000);
            expect(await failed).toMatchObject({ code: 'HQPLAYER_COMMAND_REJECTED' });
            rejectLoad = false;
            await host.load({ session: 'retry', filePath: 'source.flac' });
            expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ coldConnection: true, result: 'accepted' }));
        } finally { host.dispose(); vi.useRealTimers(); }
    });
});
