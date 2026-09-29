import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Pre-existing Desktop instances are never launched over, killed, or silently taken over.
const require = createRequire(import.meta.url);
const { createHQPlayerHost, startMinimized } = require('../src/hqplayerHost.cjs');
function fixture(instances: { pid: number }[], reachable = true) {
    const client = Object.assign(new EventEmitter(), { isConnected: (): boolean => false, connect: vi.fn(async () => {}), close: vi.fn(), send: vi.fn() });
    const launch = vi.fn(async (_path: string, _options: { silent: boolean }) => 101), kill = vi.fn();
    const host = createHQPlayerHost({ findRunning: async () => instances, probe: async () => reachable,
        discover: async () => 'D:\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe', launch, kill, wait: async () => {}, protocolFactory: () => client });
    return { host, launch, kill, client };
}
describe('HQPlayer instance ownership and visibility', () => {
    it('requires consent before connecting and never launches or kills an existing process', async () => {
        const f = fixture([{ pid: 77 }]);
        try {
            expect(await f.host.configuration()).toMatchObject({ needsConfirmation: true, instancePid: 77 });
            await expect(f.host.prepare()).rejects.toMatchObject({ code: 'HQPLAYER_CONFIRM_EXISTING' });
            expect(f.client.connect).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
            await f.host.authorizeExisting(77); await f.host.prepare();
            expect(f.client.connect).toHaveBeenCalledOnce(); expect(f.launch).not.toHaveBeenCalled();
        } finally { f.host.dispose(); }
        expect(f.kill).not.toHaveBeenCalled();
    });
    it('refuses multiple instances or a disabled Control API instead of spawning another', async () => {
        const multiple = fixture([{ pid: 1 }, { pid: 2 }]);
        await expect(multiple.host.prepare()).rejects.toMatchObject({ code: 'HQPLAYER_MULTIPLE_INSTANCES' });
        expect(multiple.launch).not.toHaveBeenCalled(); multiple.host.dispose();
        const disabled = fixture([{ pid: 77 }], false); await disabled.host.authorizeExisting(77);
        await expect(disabled.host.prepare()).rejects.toMatchObject({ code: 'HQPLAYER_CONTROL_UNAVAILABLE' });
        expect(disabled.launch).not.toHaveBeenCalled(); disabled.host.dispose();
    });
    it('serializes launches, defaults to foreground and honors explicit silent startup', async () => {
        const f = fixture([], false);
        // Real connections report true after connect, preventing a second queued launch.
        let connected = false; f.client.isConnected = () => connected;
        f.client.connect.mockImplementation(async () => { connected = true; });
        await Promise.all([f.host.prepare(), f.host.prepare()]);
        expect(f.launch).toHaveBeenCalledOnce(); expect(f.launch.mock.calls[0][1]).toEqual({ silent: false }); f.host.dispose();
        const silent = fixture([], false); silent.host.setSilent(true); await silent.host.prepare();
        expect(silent.launch.mock.calls[0][1]).toEqual({ silent: true }); silent.host.dispose();
    });
    it('uses an OS launch mutex and rechecks running processes inside it', async () => {
        const exec = vi.fn(async (_path: string, _args: string[], _options: unknown) => ({ stdout: '123' }));
        await startMinimized('D:\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe', { exec });
        const script = exec.mock.calls[0][1].at(-1);
        expect(script).toContain('System.Threading.Mutex'); expect(script).toContain('Get-Process'); expect(script).toContain('-WindowStyle Normal');
        exec.mockResolvedValueOnce({ stdout: 'EXISTING' });
        await expect(startMinimized('D:\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe', { exec, silent: true })).rejects.toMatchObject({ code: 'HQPLAYER_CONFIRM_EXISTING' });
        expect(exec.mock.calls[1][1].at(-1)).toContain('-WindowStyle Hidden');
    });
});
