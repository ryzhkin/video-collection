const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const VIDEO_EXTENSION = '.mp4';
const OUTPUT_FILE = 'lib.json';

function isEmptyObject(obj) {
    return Object.keys(obj).length === 0;
}

function isVideoFile(fileName) {
    return path.extname(fileName).toLowerCase() === VIDEO_EXTENSION;
}

async function readDirectorySafe(currentPath) {
    try {
        return await fsp.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
        console.warn(`[build] Skip "${currentPath}": ${error.message}`);
        return null;
    }
}

async function scanDirectory(currentPath) {
    const result = {};
    const dirNames = [];
    const files = [];

    const entries = await readDirectorySafe(currentPath);
    if (!entries) return result;

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
            dirNames.push(entry.name);
            continue;
        }

        if (entry.isFile() && isVideoFile(entry.name)) {
            files.push(entry.name);
        }
    }

    dirNames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const subResults = await Promise.all(
        dirNames.map(async (dirName) => {
            const dirPath = path.join(currentPath, dirName);
            const subDirResult = await scanDirectory(dirPath);
            return [dirName, subDirResult];
        })
    );

    for (const [dirName, subDirResult] of subResults) {
        if (!isEmptyObject(subDirResult)) {
            result[dirName] = subDirResult;
        }
    }

    for (const fileName of files) {
        result[fileName] = null;
    }

    return result;
}

async function writeJsonAtomically(outputPath, data) {
    const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;

    try {
        await fsp.writeFile(tempPath, data, 'utf8');
        await fsp.rename(tempPath, outputPath);
    } catch (error) {
        try {
            await fsp.unlink(tempPath);
        } catch (_) {
            // Ignore cleanup errors.
        }
        throw error;
    }
}

async function main() {
    const rootPath = process.cwd();
    const result = await scanDirectory(rootPath);
    const jsonData = JSON.stringify(result, null, 2);
    await writeJsonAtomically(path.join(rootPath, OUTPUT_FILE), jsonData);
    console.log(`[build] Library index updated: ${OUTPUT_FILE}`);
}

main().catch((error) => {
    console.error(`[build] Failed: ${error.message}`);
    process.exit(1);
});
