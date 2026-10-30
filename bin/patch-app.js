import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import picocolors from 'picocolors';
import ora from 'ora';
import prompts from 'prompts';
import * as asar from '@electron/asar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { blue, green, red, yellow } = picocolors;

const PATCH_START = '/* ANTIGRAVITY RTL PATCH */';
const PATCH_END = '/* END ANTIGRAVITY RTL PATCH */';
const ANCHOR = 'void win.loadURL(url);';
const PATCH_BLOCK = /\/\* ANTIGRAVITY RTL PATCH \*\/[\s\S]*?\/\* END ANTIGRAVITY RTL PATCH \*\//;
const LEGACY_PATCH_ERROR = 'This Antigravity install was patched by an older version of antigravity-rtl and no clean backup exists. Reinstall Antigravity, then run this command again.';

function readUtils(asarFile) {
    asar.uncache(asarFile);
    return asar.extractFile(asarFile, 'dist/utils.js').toString('utf8');
}

function stripPatch(code) {
    return PATCH_BLOCK.test(code) ? code.replace(PATCH_BLOCK, ANCHOR) : null;
}

export function resolveAppAsarPath(inputPath) {
    if (!inputPath || !fs.existsSync(inputPath)) return null;
    try {
        const stat = fs.statSync(inputPath);
        if (stat.isFile() && inputPath.endsWith('.asar')) return inputPath;
        if (stat.isDirectory()) {
            const candidates = [
                path.join(inputPath, 'resources', 'app.asar'),
                path.join(inputPath, 'Antigravity-x64', 'resources', 'app.asar'),
                path.join(inputPath, 'antigravity', 'resources', 'app.asar'),
                path.join(inputPath, 'Contents', 'Resources', 'app.asar')
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) return c;
            }
        }
    } catch (_) {}
    return null;
}

function getAppCandidatePaths() {
    const candidates = [];
    const platform = os.platform();

    if (platform === 'darwin') {
        candidates.push('/Applications/Antigravity.app/Contents/Resources/app.asar');
        candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'));
    } else if (platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app.asar'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Antigravity', 'resources', 'app.asar'));
        }
        if (process.env.PROGRAMFILES) {
            candidates.push(path.join(process.env.PROGRAMFILES, 'Antigravity', 'resources', 'app.asar'));
        }
        if (process.env['PROGRAMFILES(X86)']) {
            candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Antigravity', 'resources', 'app.asar'));
        }
    } else {
        candidates.push(path.join(os.homedir(), 'Downloads', 'Antigravity', 'Antigravity-x64', 'resources', 'app.asar'));
        candidates.push(path.join(os.homedir(), 'Downloads', 'Antigravity', 'resources', 'app.asar'));
        candidates.push('/opt/Antigravity/resources/app.asar');
        candidates.push('/opt/antigravity/resources/app.asar');
        candidates.push('/usr/share/antigravity/resources/app.asar');
        candidates.push(path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app.asar'));
    }
    return candidates;
}

export function detectAppAsarPath() {
    return getAppCandidatePaths().find(c => fs.existsSync(c)) || null;
}

export function hasAppBackup(asarPath) {
    return asarPath ? fs.existsSync(asarPath + '.bak') : false;
}

export async function getAppAsarPath() {
    const detected = detectAppAsarPath();
    if (detected) {
        console.log(blue(`ℹ Found Antigravity installation at:`));
        console.log(`  ${detected}\n`);
        return detected;
    }

    console.log(yellow(`⚠ Could not find Antigravity (App) at default location.`));
    const response = await prompts({
        type: 'text',
        name: 'customPath',
        message: 'Please enter the full path to app.asar:'
    });

    if (!response.customPath || !fs.existsSync(response.customPath)) {
        console.error(red('\n✖ Invalid path. Aborting.\n'));
        process.exit(1);
    }
    return response.customPath;
}

export async function restoreApp(rawPath, { exitOnError = true } = {}) {
    const asarPath = resolveAppAsarPath(rawPath) || rawPath;
    const backupPath = asarPath + '.bak';
    if (!fs.existsSync(backupPath)) {
        console.error(red('✖ No backup found for Antigravity (App) to restore.\n'));
        if (exitOnError) process.exit(1);
        return false;
    }
    const spinner = ora('Restoring original Antigravity app.asar...').start();
    try {
        if (readUtils(backupPath).includes(PATCH_START)) {
            spinner.fail('The backup is itself patched, so restoring would not remove RTL. Run the patcher once to rebuild a clean backup, or reinstall Antigravity.\n');
            if (exitOnError) process.exit(1);
            return false;
        }
        fs.copyFileSync(backupPath, asarPath);
        asar.uncache(asarPath);
        fs.unlinkSync(backupPath);
        spinner.succeed('Successfully restored original Antigravity!\n');
        return true;
    } catch (e) {
        spinner.fail('Failed to restore Antigravity.');
        console.error(red(e.message));
        if (exitOnError) process.exit(1);
        return false;
    }
}

export async function patchApp(rawPath, { exitOnError = true } = {}) {
    const asarPath = resolveAppAsarPath(rawPath) || rawPath;
    const backupPath = asarPath + '.bak';
    const extractDir = path.join(path.dirname(asarPath), 'app-extracted-rtl-temp');
    const spinner = ora('Checking permissions and backing up Antigravity App...').start();
    let failLabel = 'Permission Denied.';
    try {
        fs.accessSync(path.dirname(asarPath), fs.constants.W_OK);

        failLabel = 'Failed to read app.asar.';
        let unpackOptions = {};
        try {
            const unpackedDirs = new Set();
            const scanHeader = (asarFile) => {
                if (!asarFile || !fs.existsSync(asarFile)) return;
                try {
                    const rawHeader = asar.getRawHeader(asarFile);
                    const headerObj = JSON.parse(rawHeader.headerString);
                    const scanUnpacked = (node, currentPath = '') => {
                        if (node.unpacked && currentPath) {
                            const parts = currentPath.split('/');
                            if (parts[0] === 'node_modules' && parts.length >= 2) {
                                unpackedDirs.add(parts.slice(0, parts[1].startsWith('@') ? 3 : 2).join('/'));
                            } else {
                                unpackedDirs.add(parts[0]);
                            }
                        }
                        if (node.files) {
                            for (const [key, val] of Object.entries(node.files)) {
                                scanUnpacked(val, currentPath ? `${currentPath}/${key}` : key);
                            }
                        }
                    };
                    scanUnpacked(headerObj);
                } catch (_) {}
            };
            scanHeader(backupPath);
            scanHeader(asarPath);

            const unpackedFolder = path.join(path.dirname(asarPath), path.basename(asarPath) + '.unpacked');
            if (fs.existsSync(unpackedFolder)) {
                const nm = path.join(unpackedFolder, 'node_modules');
                if (fs.existsSync(nm)) {
                    for (const item of fs.readdirSync(nm)) {
                        if (item.startsWith('@')) {
                            for (const sub of fs.readdirSync(path.join(nm, item))) {
                                unpackedDirs.add(`node_modules/${item}/${sub}`);
                            }
                        } else {
                            unpackedDirs.add(`node_modules/${item}`);
                        }
                    }
                }
            }

            if (unpackedDirs.size > 0) {
                const patterns = Array.from(unpackedDirs).map(d => `**/${d}/**`);
                const dirList = Array.from(unpackedDirs);
                unpackOptions = {
                    unpack: patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`,
                    unpackDir: dirList.length === 1 ? dirList[0] : `{${dirList.join(',')}}`
                };
            }
        } catch (_) {}

        const currentUtils = readUtils(asarPath);
        const backupUtils = fs.existsSync(backupPath) ? readUtils(backupPath) : null;
        let cleanUtils;
        let repairBackup = false;

        if (!currentUtils.includes(PATCH_START)) {
            failLabel = 'Permission Denied.';
            fs.copyFileSync(asarPath, backupPath);
            asar.uncache(backupPath);
            cleanUtils = currentUtils;
        } else {
            const backupIsClean = backupUtils !== null && !backupUtils.includes(PATCH_START);
            cleanUtils = stripPatch(currentUtils) ?? (backupIsClean ? backupUtils : null);
            if (cleanUtils === null) throw new Error(LEGACY_PATCH_ERROR);
            repairBackup = !backupIsClean;
            spinner.text = 'Updating existing RTL patch to latest version...';
        }

        failLabel = 'Failed to extract ASAR.';
        spinner.text = 'Extracting app.asar (this may take a few seconds)...';
        fs.rmSync(extractDir, { recursive: true, force: true });
        asar.extractAll(asarPath, extractDir);

        const utilsPath = path.join(extractDir, 'dist', 'utils.js');
        const fontDest = path.join(extractDir, 'dist', 'Vazirmatn-Variable.woff2');

        if (repairBackup) {
            failLabel = 'Failed to rebuild clean backup.';
            spinner.text = 'Rebuilding clean backup...';
            fs.writeFileSync(utilsPath, cleanUtils);
            fs.rmSync(fontDest, { force: true });
            await asar.createPackageWithOptions(extractDir, backupPath, unpackOptions);
            asar.uncache(backupPath);
        }

        failLabel = 'Injection failed.';
        spinner.text = 'Injecting RTL features...';
        let utilsCode = cleanUtils;

        const core = fs.readFileSync(path.join(__dirname, 'rtl-core.js'), 'utf8');
        const payload = fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8')
            .replace('__RTL_CORE__', () => JSON.stringify(core));
        if (!utilsCode.includes(ANCHOR)) {
            throw new Error('Injection anchor not found. The app version might be unsupported.');
        }
        utilsCode = utilsCode.replace(ANCHOR, () => `${payload.trimEnd()}\n${PATCH_END}`);
        // Force-enable DevTools in packaged app
        utilsCode = utilsCode.replace(/devTools:\s*!electron_1?\.app\.isPackaged/g, 'devTools: true');
        fs.writeFileSync(utilsPath, utilsCode);

        fs.copyFileSync(path.join(__dirname, 'Vazirmatn-Variable.woff2'), fontDest);

        failLabel = 'Failed to repack ASAR.';
        spinner.text = 'Repacking app.asar (almost done)...';
        await asar.createPackageWithOptions(extractDir, asarPath, unpackOptions);
        asar.uncache(asarPath);
        fs.rmSync(extractDir, { recursive: true, force: true });
        spinner.succeed('Successfully patched Antigravity!');
        console.log(green('\n✨ RTL Features have been enabled for Antigravity (Standalone App).'));
        console.log(green('✨ Please restart Antigravity to see the changes.\n'));
        return true;
    } catch (e) {
        spinner.fail(failLabel);
        if (failLabel === 'Permission Denied.') {
            console.error(red('\nSystem Error: ' + e.message));
            if (os.platform() === 'win32') {
                console.error(yellow('\nPlease run your terminal (PowerShell/CMD) as Administrator and try again.\n'));
            } else if (os.platform() === 'darwin') {
                console.error(yellow('\nPlease ensure you run this command with sudo.'));
                console.error(yellow('If you are using sudo, macOS requires your terminal to have "App Management" permission.'));
                console.error(yellow('Go to: System Settings > Privacy & Security > App Management'));
                console.error(yellow('And enable the toggle for your terminal, then try again.\n'));
            } else {
                console.error(yellow('\nPlease run this command with sudo.\n'));
            }
        } else {
            console.error(red(/dist\/utils\.js/.test(e.message)
                ? 'dist/utils.js not found in ASAR. Unsupported Antigravity version.'
                : e.message));
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        if (exitOnError) process.exit(1);
        return false;
    }
}
