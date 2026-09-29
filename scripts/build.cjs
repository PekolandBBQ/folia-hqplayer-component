const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync } = require('fflate');

// Builds a self-contained component; Folia's ordinary build never invokes this script.
async function main() {
    const root = path.resolve(__dirname, '..');
    // Bundler region paths must be independent of the caller's working directory.
    process.chdir(root);
    const manifest = require('../component.json'), pkg = require('../package.json');
    if (manifest.version !== pkg.version) throw new Error('Component versions disagree');
    const { rolldown } = await import('rolldown');
    const build = await rolldown({ input: path.join(root, 'src/worker.cjs'), platform: 'node', external: [/^node:/] });
    await build.write({ file: path.join(root, 'dist', manifest.entry), format: 'cjs' }); await build.close();
    const entryPath = path.join(root, 'dist', manifest.entry);
    // Canonicalize bundler region comments when node_modules is a Windows junction.
    const entry = Buffer.from((await fs.readFile(entryPath, 'utf8')).replace(/^\/\/#region .*?node_modules\//gm, '//#region node_modules/'));
    await fs.writeFile(entryPath, entry);
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const archive = zipSync({ [manifest.entry]: entry, 'component.json': Buffer.from(JSON.stringify(manifest)),
        'LICENSE.txt': await fs.readFile(path.join(root, 'LICENSE')), 'NOTICE.txt': Buffer.from('Includes @xmldom/xmldom, MIT license. HQPlayer Desktop is not included.\n' + await fs.readFile(require.resolve('@xmldom/xmldom/LICENSE'), 'utf8')) }, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
    const directory = path.join(root, 'artifacts'); await fs.mkdir(directory, { recursive: true });
    const name = `folia-hqplayer-${manifest.version}-win32-x64.zip`, localPath = path.join(directory, name);
    await fs.writeFile(localPath, archive);
    const release = { version: manifest.version, protocolMajor: 1, platform: manifest.platform, sha256: sha(archive), entrySha256: sha(entry), localPath };
    const catalogPath = path.join(directory, 'development-catalog.json');
    let previous = [];
    try { previous = JSON.parse(await fs.readFile(catalogPath, 'utf8')).releases || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Keep earlier local artifacts available for the application's rollback pin.
    await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases: [release,
        ...previous.filter(item => item.version !== release.version || item.platform !== release.platform)] }, null, 2));
    console.log(JSON.stringify(release));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
