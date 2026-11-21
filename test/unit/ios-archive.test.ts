// scripts/ios-archive.sh: a Release archive and an App Store IPA for TestFlight, signed with a team the
// owner gives for one run, and never uploaded. The build itself needs Xcode and the owner's Apple
// account, so it is not run here (docs/IOS.md, TestFlight).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/ios-archive.sh');
const src = readFileSync(SCRIPT, 'utf8');
const code = src.replace(/^\s*#.*$/gm, '');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 20_000, env: { ...process.env, FORGE_IOS_TEAM: '', ...env } });

describe('the iPhone archive script', () => {
  it('is valid bash that stops on the first error', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(src).toMatch(/^set -euo pipefail$/m);
  });

  it('builds nothing without a team id, or with one that is not ten capitals and digits', () => {
    const none = run([]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('No team id given (--team or FORGE_IOS_TEAM). Nothing was built.');
    const bad = run(['--team', 'abc123']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ten capital letters and digits');
    const badEnv = run([], { FORGE_IOS_TEAM: 'not a team' });
    expect(badEnv.status).toBe(1);
    expect(badEnv.stderr).toContain('ten capital letters and digits');
  });

  it('takes an App Store Connect API key only whole, from a file that exists outside the repository, and never reads it', () => {
    const half = run(['--team', 'ABCDE12345', '--key-id', 'ABC123']);
    expect(half.status).toBe(1);
    expect(half.stderr).toContain('An API key needs all three');
    const missing = run(['--team', 'ABCDE12345', '--key', '/nowhere/key.p8', '--key-id', 'ABC123', '--issuer', 'x']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No API key file at /nowhere/key.p8');
    const inside = run(['--team', 'ABCDE12345', '--key', 'package.json', '--key-id', 'ABC123', '--issuer', 'x']);
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain('The API key is inside the repository');
    const env = run(['--team', 'ABCDE12345'], { FORGE_ASC_KEY_ID: 'ABC123' });
    expect(env.stderr).toContain('An API key needs all three');
    // The key file goes to xcodebuild by path, for the archive and the export; the script never opens it.
    expect(code.match(/\$\{AUTH\[@\]\+"\$\{AUTH\[@\]\}"\}/g)).toHaveLength(2);
    expect(code).toContain('AUTH=(-authenticationKeyPath "$KEY" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER")');
    expect(code).not.toMatch(/cat "\$KEY"|<\s*"\$KEY"/);
  });

  it('keeps its output out of git: dist/, or a folder outside the repository', () => {
    const r = run(['--team', 'ABCDE12345', '--out', 'ios/not-here']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('inside the repository but not in dist/');
    expect(existsSync(resolve(ROOT, 'ios/not-here'))).toBe(false);
    expect(src).toContain('OUT="$ROOT/dist/ios"');
    expect(readFileSync(resolve(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist$/m);
  });

  it('bundles the web app and installs the pods first', () => {
    expect(code).toContain('(cd "$ROOT" && pnpm -s ios:web)');
    expect(code).toContain('(cd "$IOS" && pod install)');
    expect(code.indexOf('pnpm -s ios:web')).toBeLessThan(code.indexOf(' archive\n'));
    expect(code.indexOf('pod install')).toBeLessThan(code.indexOf(' archive\n'));
  });

  it('archives Release for any iPhone with automatic signing and the team for this run only', () => {
    expect(code).toContain('xcodebuild -workspace "$IOS/App.xcworkspace" -scheme App -configuration Release');
    expect(code).toContain("-destination 'generic/platform=iOS'");
    expect(code).toMatch(/-allowProvisioningUpdates \$\{AUTH\[@\]\+"\$\{AUTH\[@\]\}"\} CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="\$TEAM" archive$/m);
    // The project file is put back if xcodebuild changed it, so no team is ever left in it to commit.
    expect(code).toContain('cp "$PROJECT" "$WORK/project.pbxproj"');
    expect(code).toMatch(/trap restore EXIT/);
    expect(code).toMatch(/cmp -s "\$WORK\/project\.pbxproj" "\$PROJECT"/);
    expect(code).not.toMatch(/sed -i|PlistBuddy|>\s*"\$PROJECT"/);
    // The archived app carries the privacy manifest.
    expect(code).toContain('[[ -f "$APP/PrivacyInfo.xcprivacy" ]]');
  });

  it('exports an App Store IPA to a folder and uploads nothing', () => {
    expect(code).toMatch(/<key>method<\/key>\s*<string>app-store-connect<\/string>/);
    expect(code).toMatch(/<key>destination<\/key>\s*<string>export<\/string>/);
    expect(code).not.toMatch(/<string>upload<\/string>/);
    expect(code).toContain('xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT"');
    // No upload tool, and no API key of its own: one is only passed to xcodebuild to sign in, when given.
    expect(code).not.toMatch(/altool|notarytool|iTMSTransporter|Transporter\.app|upload-app|appstoreconnect|private_keys/i);
    // The export options, which name the team, are written to a temporary folder that is removed.
    expect(code).toContain('cat > "$WORK/ExportOptions.plist"');
    expect(code).toContain('rm -rf "$WORK"');
  });

  it('exports with a named profile and the distribution certificate when asked, else with automatic signing', () => {
    expect(code).toMatch(/<key>signingStyle<\/key>\s*<string>manual<\/string>\s*<key>signingCertificate<\/key>\s*<string>Apple Distribution<\/string>/);
    expect(code).toMatch(/<key>com\.forgereserve\.ai<\/key>\s*<string>\$PROFILE<\/string>/);
    expect(code).toMatch(/<key>signingStyle<\/key>\s*<string>automatic<\/string>/);
    expect(code).toContain('PROFILE="${FORGE_IOS_PROFILE:-}"');
    // A name that could break out of the options file is refused.
    expect(code).toContain('[[ "$PROFILE" =~ ^[A-Za-z0-9\\ ._-]+$ ]]');
  });

  it('prints the IPA, its size, version and build number', () => {
    expect(code).toContain('echo "IPA:      $IPA"');
    expect(code).toMatch(/echo "Size: .*wc -c < "\$IPA"/);
    expect(code).toContain('plutil -extract CFBundleShortVersionString raw');
    expect(code).toContain('plutil -extract CFBundleVersion raw');
    expect(code).toContain('echo "Version:  $VERSION (build $BUILD)"');
  });
});
