const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { audioError } = require('./errors.cjs');

// Count Desktop processes even when their Control API is disabled or still starting.
async function findRunningHQPlayers({ exec = promisify(execFile) } = {}) {
    const script = "@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match '^HQPlayer[0-9]*Desktop$' } | ForEach-Object { @{ pid=$_.Id; name=$_.ProcessName } }) | ConvertTo-Json -Compress";
    try {
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        const value = stdout.trim() ? JSON.parse(stdout) : [];
        const rows = Array.isArray(value) ? value : [value];
        return rows.filter(row => Number.isInteger(row.pid) && row.pid > 0).map(row => ({ pid: row.pid, name: row.name }));
    } catch (error) { throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', `Cannot verify HQPlayer instances: ${error.message}`); }
}
// An explicit output switch releases every local Desktop instance, including user-launched ones.
async function closeAllHQPlayers({ exec = promisify(execFile) } = {}) {
    const script = "$items=@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'});"
        + "$items | ForEach-Object { [void]$_.CloseMainWindow() };"
        + "foreach($p in $items){if(-not $p.WaitForExit(3000)){Stop-Process -Id $p.Id -Force -ErrorAction Stop;if(-not $p.WaitForExit(3000)){throw 'HQPlayer did not exit'}}};"
        + "if(@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'}).Count){throw 'HQPlayer still running'}";
    try { await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, encoding: 'utf8' }); }
    catch (error) { throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', `Cannot release HQPlayer devices: ${error.message}`); }
}
module.exports = { findRunningHQPlayers, closeAllHQPlayers };
