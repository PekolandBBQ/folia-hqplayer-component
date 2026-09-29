const { audioError } = require('./errors.cjs');

// HQPlayer 6.0.1 Control SDK: setters take list indices, not the DSP enum in `value`.
const items = (root, tag) => Array.from(root.getElementsByTagName(tag));
const options = (root, tag) => items(root, tag).map(item => ({ index: Number(item.getAttribute('index')),
    name: item.getAttribute('name'), value: Number(item.getAttribute('value')) }));
async function readState(client) {
    const root = await client.request('State');
    return Object.fromEntries(['state', 'mode', 'filter', 'filter1x', 'filterNx', 'shaper', 'rate'].map(key => [key, root.hasAttribute(key) ? Number(root.getAttribute(key)) : undefined]));
}
async function readMode(client) {
    const filters = options(await client.request('GetFilters'), 'FiltersItem');
    const shapers = options(await client.request('GetShapers'), 'ShapersItem');
    const rates = items(await client.request('GetRates'), 'RatesItem').map(item => ({ index: Number(item.getAttribute('index')), rate: Number(item.getAttribute('rate')) }));
    return { filters, shapers, rates };
}
async function restore(client, state) {
    await client.request('SetMode', { value: state.mode });
    await client.request('SetFilter', { value: state.filterNx ?? state.filter, ...(state.filter1x !== undefined ? { value1x: state.filter1x } : {}) });
    await client.request('SetShaping', { value: state.shaper });
    await client.request('SetRate', { value: state.rate });
}
function createDspController() {
    const catalogs = {};
    let pending = null;
    async function read(client) {
        const state = await readState(client);
        const modes = options(await client.request('GetModes'), 'ModesItem').filter(mode => mode.value === 0 || mode.value === 1);
        catalogs[state.mode] = await readMode(client);
        // Mode-dependent lists can only be discovered without interrupting audio while stopped.
        if (state.state === 0) {
            try {
                for (const mode of modes) {
                    if (mode.index === state.mode) continue;
                    await client.request('SetMode', { value: mode.index });
                    catalogs[mode.index] = await readMode(client);
                }
            } finally { await restore(client, state); }
        }
        return { state, modes, catalogs: { ...catalogs }, pending: pending?.settings || null,
            deviceControlAvailable: false };
    }
    // Resolve names/rates again after selecting the target mode: indices may change with a DAC.
    async function apply(client, settings) {
        if (!settings || !Number.isInteger(settings.mode) || typeof settings.filter !== 'string'
            || typeof settings.shaper !== 'string' || !Number.isFinite(settings.rate)) throw audioError('INVALID_REQUEST');
        const modes = options(await client.request('GetModes'), 'ModesItem');
        if (!modes.some(mode => mode.index === settings.mode && [0, 1].includes(mode.value))) throw audioError('INVALID_REQUEST');
        const before = await readState(client);
        try {
            await client.request('SetMode', { value: settings.mode });
            const catalog = await readMode(client);
            const filter = catalog.filters.find(item => item.name === settings.filter);
            const shaper = catalog.shapers.find(item => item.name === settings.shaper);
            const rate = catalog.rates.find(item => item.rate === settings.rate);
            if (!filter || !shaper || !rate) throw audioError('FORMAT_UNSUPPORTED');
            await client.request('SetFilter', { value: filter.index, value1x: filter.index });
            await client.request('SetShaping', { value: shaper.index });
            await client.request('SetRate', { value: rate.index });
        } catch (error) {
            try { await restore(client, before); } catch { throw audioError('HQPLAYER_SETTINGS_FAILED', 'Settings failed and restoration could not be confirmed'); }
            throw error;
        }
    }
    function defer(settings, trackKey) {
        const catalog = catalogs[settings?.mode];
        if (!catalog || !catalog.filters.some(item => item.name === settings.filter)
            || !catalog.shapers.some(item => item.name === settings.shaper) || !catalog.rates.some(item => item.rate === settings.rate)) throw audioError('INVALID_REQUEST');
        pending = { settings: { ...settings }, trackKey };
    }
    async function beforeTrack(client, trackKey, defaults) {
        if (!pending || (pending.trackKey && pending.trackKey === trackKey)) {
            if (defaults) await apply(client, defaults);
            return;
        }
        const next = pending;
        await apply(client, next.settings);
        pending = null;
    }
    return { read, apply, defer, beforeTrack, clearPending: () => { pending = null; }, clear: () => { pending = null; for (const key of Object.keys(catalogs)) delete catalogs[key]; } };
}
module.exports = { createDspController, readState, readMode };
