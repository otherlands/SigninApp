'use strict';
// deploy/kiosk-pi/display-diag.sh: the one-shot HDMI diagnostic for the Argon HMI 10CS, run against a fake /sys tree.
// Needs bash (Linux CI); skipped where there is none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'kiosk-pi', 'display-diag.sh');
const BASE = 'console=serial0,115200 console=tty1 root=PARTUUID=dc26593c-02 rootfstype=ext4 fsck.repair=yes rootwait quiet splash';
const ARM = ' systemd.run=/boot/firmware/display-diag.sh systemd.run_success_action=reboot systemd.run_failure_action=none systemd.unit=kernel-command-line.target';
let hasBash = process.platform !== 'win32';
try { if (hasBash) execFileSync('bash', ['-c', 'true']); } catch { hasBash = false; }

function run(states) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-diag-'));
    const boot = path.join(dir, 'boot'); const drm = path.join(dir, 'drm');
    fs.mkdirSync(boot);
    fs.writeFileSync(path.join(boot, 'cmdline.txt'), BASE + ARM);
    states.forEach((st, i) => {
        const c = path.join(drm, `card1-HDMI-A-${i + 1}`); fs.mkdirSync(c, { recursive: true });
        fs.writeFileSync(path.join(c, 'status'), st + '\n'); fs.writeFileSync(path.join(c, 'enabled'), 'enabled\n');
        fs.writeFileSync(path.join(c, 'edid'), st === 'connected' ? 'TEST MONITOR' : ''); fs.writeFileSync(path.join(c, 'modes'), st === 'connected' ? '1920x1080\n' : '');
    });
    execFileSync('bash', [SCRIPT], { env: { ...process.env, DIAG_BOOT: boot, DIAG_DRM: drm } });
    const out = { cmdline: fs.readFileSync(path.join(boot, 'cmdline.txt'), 'utf8'), report: fs.readFileSync(path.join(boot, 'display-diag.txt'), 'utf8') };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
}

test('display-diag: forces only the panel\'s port, disarms itself, keeps cmdline.txt one line', { skip: !hasBash && 'needs bash' }, () => {
    let r = run(['connected', 'disconnected']);
    assert.equal(r.cmdline, BASE + ' video=HDMI-A-2:1280x800@60D', 'one line, one-shot args gone, port 2 forced');
    assert.match(r.report, /HDMI-A-1 is connected .* HDMI-A-2 reports disconnected/);
    r = run(['disconnected', 'connected']);
    assert.equal(r.cmdline, BASE + ' video=HDMI-A-1:1280x800@60D');
    r = run(['disconnected', 'disconnected']);
    assert.equal(r.cmdline, BASE, 'ambiguous: disarmed, nothing forced');
    assert.match(r.report, /nothing changed/);
    r = run(['connected', 'connected']);
    assert.equal(r.cmdline, BASE);
});
