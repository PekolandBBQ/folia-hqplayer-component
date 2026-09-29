import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Verify real SDK list indices, deferred ownership, and rollback with mode-dependent catalogs.
const require = createRequire(import.meta.url);
const { createDspController } = require('../src/hqplayerDsp.cjs');
const { parseDocument } = require('../src/hqplayerProtocol.cjs');
function fixture(playing = false) {
    const state = { state: playing ? 2 : 0, mode: 1, filter: 7, filter1x: 8, shaper: 9, rate: 4 };
    const request = vi.fn(async (name: string, attrs?: { value: number; value1x?: number }) => {
        if (name === 'State') return parseDocument(`<State ${Object.entries(state).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`);
        if (name === 'GetModes') return parseDocument('<GetModes><ModesItem index="1" name="PCM" value="0"/><ModesItem index="2" name="SDM" value="1"/></GetModes>');
        if (name === 'GetFilters') return parseDocument(`<GetFilters><FiltersItem index="7" name="filter-${state.mode}" value="200"/></GetFilters>`);
        if (name === 'GetShapers') return parseDocument(`<GetShapers><ShapersItem index="9" name="shaper-${state.mode}" value="300"/></GetShapers>`);
        if (name === 'GetRates') return parseDocument(`<GetRates><RatesItem index="4" rate="${state.mode === 1 ? 192000 : 11289600}"/></GetRates>`);
        if (name === 'SetMode') state.mode = attrs!.value;
        return parseDocument(`<${name} result="OK"/>`);
    });
    return { state, request, controller: createDspController() };
}
describe('HQPlayer DSP settings', () => {
    it('applies defaults per track while an explicit next-track choice takes priority once', async () => {
        const f = fixture(); await f.controller.read(f); f.request.mockClear();
        const defaults = { mode: 1, filter: 'filter-1', shaper: 'shaper-1', rate: 192000 };
        await f.controller.beforeTrack(f, 'a', defaults);
        expect(f.request).toHaveBeenCalledWith('SetMode', { value: 1 });
        f.controller.defer({ mode: 2, filter: 'filter-2', shaper: 'shaper-2', rate: 11289600 }, 'a');
        f.request.mockClear(); await f.controller.beforeTrack(f, 'b', defaults);
        expect(f.request).toHaveBeenCalledWith('SetMode', { value: 2 });
        expect(f.request).not.toHaveBeenCalledWith('SetMode', { value: 1 });
        f.request.mockClear(); await f.controller.beforeTrack(f, 'c', defaults);
        expect(f.request).toHaveBeenCalledWith('SetMode', { value: 1 });
    });
    it('discovers stopped mode catalogs and restores the original mode and filters', async () => {
        const f = fixture();
        const catalog = await f.controller.read(f);
        expect(Object.keys(catalog.catalogs)).toEqual(['1', '2']);
        expect(f.state.mode).toBe(1);
        expect(f.request).toHaveBeenCalledWith('SetFilter', { value: 7, value1x: 8 });
    });
    it('never changes mode to inspect options during playback', async () => {
        const f = fixture(true);
        await f.controller.read(f);
        expect(f.request.mock.calls.some(([name]) => name.startsWith('Set'))).toBe(false);
    });
    it('keeps next-song settings away from same-song retries and translates names to indices', async () => {
        const f = fixture(); await f.controller.read(f); f.request.mockClear();
        f.controller.defer({ mode: 2, filter: 'filter-2', shaper: 'shaper-2', rate: 11289600 }, 'song-a');
        await f.controller.beforeTrack(f, 'song-a'); expect(f.request).not.toHaveBeenCalled();
        await f.controller.beforeTrack(f, 'song-b');
        expect(f.request).toHaveBeenCalledWith('SetMode', { value: 2 });
        expect(f.request).toHaveBeenCalledWith('SetFilter', { value: 7, value1x: 7 });
        expect(f.request).toHaveBeenCalledWith('SetShaping', { value: 9 });
        expect(f.request).toHaveBeenCalledWith('SetRate', { value: 4 });
        f.request.mockClear(); await f.controller.beforeTrack(f, 'song-c'); expect(f.request).not.toHaveBeenCalled();
    });
    it('rejects stale target capabilities and restores prior settings', async () => {
        const f = fixture();
        await expect(f.controller.apply(f, { mode: 2, filter: 'missing', shaper: 'shaper-2', rate: 11289600 })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
        expect(f.state.mode).toBe(1);
        expect(f.request).toHaveBeenLastCalledWith('SetRate', { value: 4 });
    });
});
