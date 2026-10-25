import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../../..');
const publishScript = resolve(projectRoot, 'services/control/deploy/publish-windows-feed.sh');
const hasUnixTools =
  spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('ssh-keygen', ['-V'], { encoding: 'utf8' }).error === undefined;

describe('JR Windows update publisher', () => {
  it('passes the pinned SFTP settings to the release publisher', () => {
    const workflow = readFileSync(resolve(projectRoot, '.github/workflows/release-distribute.yml'), 'utf8');

    expect(workflow).toContain('JR_UPDATES_SSH_HOST: ${{ vars.JR_UPDATES_SSH_HOST }}');
    expect(workflow).toContain('JR_UPDATES_SSH_PRIVATE_KEY: ${{ secrets.JR_UPDATES_SSH_PRIVATE_KEY }}');
    expect(workflow).toContain('bash services/control/deploy/publish-windows-feed.sh');
  });

  // windows-2022 ships Git Bash and OpenSSH, so the bash/ssh-keygen probe above
  // passes and this body used to run. The sftp double is a shell script placed on a
  // colon-separated PATH, which does not shadow sftp.exe; OpenSSH then exits 255.
  // The publisher script is LF and reaches that sftp call, so this is not a CRLF or
  // path bug. publish-jr-windows-feed runs on ubuntu-latest. Linux and macOS still
  // assert upload order and checksum rejection.
  it.skipIf(process.platform === 'win32' || !hasUnixTools)(
    'uploads verified assets before replacing the feed manifest',
    () => {
      const tempDir = mkdtempSync(resolve(tmpdir(), 'jr-update-publisher-'));
      const releaseDir = resolve(tempDir, 'release');
      const binDir = resolve(tempDir, 'bin');
      const keyPath = resolve(tempDir, 'deploy-key');
      const batchCapture = resolve(tempDir, 'sftp-batch.txt');
      const version = '1.2.3';
      const installer = `JR-Bot-${version}-win-x64.exe`;

      try {
        mkdirSync(releaseDir);
        mkdirSync(binDir);
        const installerPath = resolve(releaseDir, installer);
        const installerBytes = 'JR Bot installer test bytes';
        const installerHash = createHash('sha512').update(installerBytes).digest('base64');
        writeFileSync(installerPath, installerBytes);
        writeFileSync(`${installerPath}.blockmap`, 'JR Bot blockmap bytes');
        writeFileSync(
          resolve(releaseDir, 'latest.yml'),
          `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${installerHash}\npath: ${installer}\nsha512: ${installerHash}\n`
        );

        const keyResult = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], {
          encoding: 'utf8',
        });
        expect(keyResult.status).toBe(0);
        const [keyType, keyData] = readFileSync(`${keyPath}.pub`, 'utf8').trim().split(' ');
        const knownHosts = `jr-updates.test ${keyType} ${keyData}\n`;

        const fakeSftp = `#!/bin/bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == "-b" ]]; then
    cat "$2" > "$SFTP_BATCH_CAPTURE"
    exit 0
  fi
  shift
done
exit 2
`;
        const sftpPath = resolve(binDir, 'sftp');
        writeFileSync(sftpPath, fakeSftp);
        chmodSync(sftpPath, 0o755);

        const env = {
          ...process.env,
          JR_UPDATES_SSH_HOST: 'jr-updates.test',
          JR_UPDATES_SSH_USER: 'jr-bot-updates',
          JR_UPDATES_SSH_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
          JR_UPDATES_SSH_KNOWN_HOSTS: knownHosts,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SFTP_BATCH_CAPTURE: batchCapture,
        };
        const publishResult = spawnSync('bash', [publishScript, releaseDir, version], {
          cwd: projectRoot,
          env,
          encoding: 'utf8',
        });
        expect(publishResult.status).toBe(0);

        const batch = readFileSync(batchCapture, 'utf8');
        const installerUpload = batch.indexOf(`put "${installerPath}" "/updates/${installer}"`);
        const blockmapUpload = batch.indexOf(`put "${installerPath}.blockmap" "/updates/${installer}.blockmap"`);
        const manifestUpload = batch.indexOf('latest.yml');
        const manifestReplace = batch.indexOf(`rename "/updates/.latest.yml.${version}.tmp" "/updates/latest.yml"`);
        expect(installerUpload).toBeGreaterThanOrEqual(0);
        expect(blockmapUpload).toBeGreaterThan(installerUpload);
        expect(manifestUpload).toBeGreaterThan(blockmapUpload);
        expect(manifestReplace).toBeGreaterThan(manifestUpload);

        rmSync(batchCapture);
        writeFileSync(resolve(releaseDir, 'latest.yml'), `version: ${version}\npath: ${installer}\nsha512: wrong\n`);
        const rejectedResult = spawnSync('bash', [publishScript, releaseDir, version], {
          cwd: projectRoot,
          env,
          encoding: 'utf8',
        });
        expect(rejectedResult.status).not.toBe(0);
        expect(existsSync(batchCapture)).toBe(false);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    }
  );
});
