#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const ROOT_DIR = process.cwd();
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_COMPLETED_JOBS = 30;
const MAX_JOB_LOG_LINES = 60;
const YT_SCRIPT_PATH = path.join(ROOT_DIR, 'yt');

function usage() {
    console.log(`Usage: node server.js [--host ADDRESS] [--port PORT]

Options:
  --host ADDRESS   Bind address (default: 0.0.0.0)
  --port PORT      Port number (default: 8081)
  -h, --help       Show this help
`);
}

function parseArgs(argv) {
    let host = '0.0.0.0';
    let port = 8081;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '-h' || arg === '--help') {
            usage();
            process.exit(0);
        }
        if (arg === '--host') {
            const next = argv[index + 1];
            if (!next) throw new Error('Missing value for --host');
            host = next;
            index += 1;
            continue;
        }
        if (arg === '--port') {
            const next = argv[index + 1];
            if (!next) throw new Error('Missing value for --port');
            const parsed = Number(next);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
                throw new Error(`Invalid port: ${next}`);
            }
            port = parsed;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return { host, port };
}

const mimeTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'application/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/mp4'],
    ['.webm', 'video/webm'],
    ['.mov', 'video/quicktime'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.txt', 'text/plain; charset=utf-8']
]);

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendText(res, statusCode, text) {
    const body = `${text}\n`;
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function decodeRequestPath(pathname) {
    try {
        return decodeURIComponent(pathname);
    } catch (_) {
        return null;
    }
}

function resolveStaticPath(pathname) {
    const decoded = decodeRequestPath(pathname);
    if (decoded === null) return null;

    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const absolute = path.resolve(ROOT_DIR, relative);
    const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;
    if (absolute !== ROOT_DIR && !absolute.startsWith(rootWithSep)) {
        return null;
    }
    return absolute;
}

function parseByteRange(rangeHeader, fileSize) {
    if (!rangeHeader) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return { error: 'Malformed range header' };

    const startRaw = match[1];
    const endRaw = match[2];
    let start;
    let end;

    if (startRaw === '' && endRaw === '') {
        return { error: 'Malformed range header' };
    }

    if (startRaw === '') {
        const suffixLength = Number(endRaw);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
            return { error: 'Invalid range suffix' };
        }
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else {
        start = Number(startRaw);
        if (!Number.isInteger(start) || start < 0) {
            return { error: 'Invalid range start' };
        }
        if (endRaw === '') {
            end = fileSize - 1;
        } else {
            end = Number(endRaw);
            if (!Number.isInteger(end) || end < 0) {
                return { error: 'Invalid range end' };
            }
        }
    }

    if (start >= fileSize || end < start) {
        return { error: 'Unsatisfiable range' };
    }

    end = Math.min(end, fileSize - 1);
    return { start, end };
}

async function serveStatic(req, res, pathname) {
    const filePath = resolveStaticPath(pathname);
    if (!filePath) {
        sendText(res, 403, 'Forbidden');
        return;
    }

    let stats;
    try {
        stats = await fsp.stat(filePath);
    } catch (_) {
        sendText(res, 404, 'Not Found');
        return;
    }

    if (!stats.isFile()) {
        sendText(res, 404, 'Not Found');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes.get(ext) || 'application/octet-stream';
    const cacheControl = (ext === '.html' || ext === '.json') ? 'no-store' : 'public, max-age=300';

    const range = parseByteRange(req.headers.range, stats.size);
    const headers = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl
    };

    if (range && range.error) {
        res.writeHead(416, {
            ...headers,
            'Content-Range': `bytes */${stats.size}`
        });
        res.end();
        return;
    }

    if (range) {
        const contentLength = (range.end - range.start) + 1;
        res.writeHead(206, {
            ...headers,
            'Content-Length': contentLength,
            'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        ...headers,
        'Content-Length': stats.size
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    fs.createReadStream(filePath).pipe(res);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];

        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_JSON_BODY_BYTES) {
                reject(new Error('Request body is too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                resolve(parsed);
            } catch (_) {
                reject(new Error('Invalid JSON body'));
            }
        });

        req.on('error', (error) => reject(error));
    });
}

function isYouTubeUrl(urlValue) {
    if (typeof urlValue !== 'string') return false;
    const raw = urlValue.trim();
    if (!raw) return false;

    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return false;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'youtu.be'
        || host === 'youtube.com'
        || host.endsWith('.youtube.com');
}
function resolveTargetDirectory(targetPathValue) {
    const raw = typeof targetPathValue === 'string' ? targetPathValue.trim() : '';
    if (!raw) return ROOT_DIR;

    let normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.toLowerCase().endsWith('.mp4')) {
        const parts = normalized.split('/');
        parts.pop();
        normalized = parts.join('/');
    }
    if (!normalized) return ROOT_DIR;

    const absolute = path.resolve(ROOT_DIR, normalized);
    const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;
    if (absolute !== ROOT_DIR && !absolute.startsWith(rootWithSep)) {
        return null;
    }
    return absolute;
}
function resolveLibraryPathInsideRoot(pathValue) {
    const raw = typeof pathValue === 'string' ? pathValue.trim() : '';
    const normalized = raw
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '');

    const absolute = path.resolve(ROOT_DIR, normalized || '.');
    const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;
    if (absolute !== ROOT_DIR && !absolute.startsWith(rootWithSep)) {
        return null;
    }
    return {
        normalized,
        absolute
    };
}

const PROGRESS_PHASE_ORDER = new Map([
    ['queued', 0],
    ['starting', 1],
    ['downloading', 2],
    ['processing', 3],
    ['indexing', 4],
    ['done', 5],
    ['failed', 5]
]);

function clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 100) return 100;
    return value;
}

function createJobProgress(phase, percent, text, approximate = false, etaSeconds = null) {
    const normalizedEta = Number.isFinite(etaSeconds) && etaSeconds >= 0
        ? Math.floor(etaSeconds)
        : null;
    return {
        phase,
        percent: clampPercent(percent),
        text,
        approximate,
        etaSeconds: normalizedEta
    };
}

function setJobProgress(job, phase, percent, text, approximate = false, etaSeconds = null) {
    if (!job.progress) {
        job.progress = createJobProgress(phase, percent, text, approximate, etaSeconds);
        return;
    }

    const currentRank = PROGRESS_PHASE_ORDER.get(job.progress.phase) || 0;
    const nextRank = PROGRESS_PHASE_ORDER.get(phase) || 0;
    if (nextRank < currentRank) return;

    const nextProgress = createJobProgress(
        phase,
        percent,
        text || job.progress.text,
        approximate,
        etaSeconds
    );
    if (nextProgress.etaSeconds === null && nextRank === currentRank) {
        nextProgress.etaSeconds = job.progress.etaSeconds;
    }
    if (nextRank === currentRank && nextProgress.percent < job.progress.percent) {
        return;
    }
    job.progress = nextProgress;
}

function getOverallDownloadPercent(job, partPercent) {
    const safePartPercent = clampPercent(partPercent);
    const partTotal = Math.max(1, job.downloadPartTotal || job.downloadPartSeen || 1);
    const partSeen = Math.max(1, job.downloadPartSeen || 1);
    const completedPartCount = Math.max(0, Math.min(partSeen - 1, partTotal));
    const fraction = (completedPartCount + (safePartPercent / 100)) / partTotal;
    return Math.max(1, Math.min(100, Math.round(fraction * 100)));
}
function mapPhasePercentToOverallPercent(phase, phasePercent) {
    const p = clampPercent(phasePercent);
    switch (phase) {
        case 'queued':
            return 0;
        case 'starting':
            return Math.round(p * 0.02); // 0..2
        case 'downloading':
            return Math.round(p * 0.5); // 0..50
        case 'processing':
            return Math.round(50 + (p * 0.45)); // 50..95
        case 'indexing':
            return Math.round(95 + (p * 0.04)); // 95..99
        case 'done':
            return 100;
        case 'failed':
            return p;
        default:
            return p;
    }
}
function parseClockEtaToSeconds(rawEta) {
    if (typeof rawEta !== 'string') return null;
    const token = rawEta.trim();
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(token)) return null;
    const parts = token.split(':').map((value) => Number(value));
    if (parts.some((value) => !Number.isFinite(value))) return null;
    if (parts.length === 2) {
        return (parts[0] * 60) + parts[1];
    }
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
}
function parsePercentValue(rawPercent) {
    if (typeof rawPercent !== 'string') return null;
    const normalized = rawPercent.trim().replace('%', '').replace(',', '.');
    if (normalized === '') return null;
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    return clampPercent(value);
}
function parseYtProgressEvent(line) {
    const match = /^\[yt-progress\]\s+([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)\|(.*)$/.exec(line);
    if (!match) return null;
    const phase = String(match[1] || '').trim();
    const percentRaw = String(match[2] || '');
    const percent = parsePercentValue(percentRaw);
    const approximate = String(match[3]).trim() === '1';
    const etaRaw = String(match[4] || '').trim();
    const text = String(match[5] || '').trim();
    const etaSeconds = /^\d+$/.test(etaRaw)
        ? Number(etaRaw)
        : parseClockEtaToSeconds(etaRaw);
    if (!phase || !Number.isFinite(percent)) return null;
    return {
        phase,
        percent,
        approximate,
        etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null,
        text
    };
}

function updateJobProgressFromLogLine(job, line) {
    if (!line) return;

    const ytProgressEvent = parseYtProgressEvent(line);
    if (ytProgressEvent) {
        let phasePercent = ytProgressEvent.percent;
        if (ytProgressEvent.phase === 'downloading' && (job.downloadPartTotal || job.downloadPartSeen)) {
            phasePercent = getOverallDownloadPercent(job, ytProgressEvent.percent);
        }
        const nextPercent = mapPhasePercentToOverallPercent(ytProgressEvent.phase, phasePercent);
        setJobProgress(
            job,
            ytProgressEvent.phase,
            nextPercent,
            ytProgressEvent.text,
            ytProgressEvent.approximate,
            ytProgressEvent.etaSeconds
        );
        return;
    }

    const formatMatch = line.match(/Downloading\s+\d+\s+format\(s\):\s*(.+)$/i);
    if (formatMatch) {
        const formatList = formatMatch[1].trim();
        const parts = formatList
            .split('+')
            .map((value) => value.trim())
            .filter(Boolean);
        if (parts.length > 0) {
            job.downloadPartTotal = parts.length;
        }
        return;
    }

    if (line.startsWith('[download] Destination:')) {
        job.downloadPartSeen = (job.downloadPartSeen || 0) + 1;
        if (!job.downloadPartTotal || job.downloadPartTotal < job.downloadPartSeen) {
            job.downloadPartTotal = job.downloadPartSeen;
        }
        const phasePercent = getOverallDownloadPercent(job, 0);
        const overallPercent = mapPhasePercentToOverallPercent('downloading', phasePercent);
        setJobProgress(job, 'downloading', overallPercent, 'Downloading media...', false, null);
        return;
    }

    const downloadPercentMatch = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (downloadPercentMatch) {
        if (!job.downloadPartSeen) job.downloadPartSeen = 1;
        const streamPercent = Number(downloadPercentMatch[1]);
        const phasePercent = getOverallDownloadPercent(job, streamPercent);
        const overallPercent = mapPhasePercentToOverallPercent('downloading', phasePercent);
        const etaMatch = line.match(/\bETA\s+([0-9:]+)/i);
        const etaSeconds = etaMatch ? parseClockEtaToSeconds(etaMatch[1]) : null;
        setJobProgress(job, 'downloading', overallPercent, 'Downloading media...', false, etaSeconds);
        return;
    }

    if (
        line.startsWith('[Merger]')
        || line.startsWith('[VideoRemuxer]')
        || line.startsWith('[ExtractAudio]')
    ) {
        setJobProgress(job, 'processing', mapPhasePercentToOverallPercent('processing', 55), 'Processing downloaded media...', true, null);
        return;
    }

    if (
        line.startsWith('[yt] Transcoding downloaded files')
        || line.startsWith('[yt] Transcoding for mobile+size:')
    ) {
        setJobProgress(job, 'processing', mapPhasePercentToOverallPercent('processing', 1), 'Processing downloaded media...', true, null);
        return;
    }

    if (
        line.startsWith('[yt] Transcoding done')
        || line.startsWith('[yt] Keeping original (already smaller):')
        || line.startsWith('[yt] No new MP4 files to transcode.')
    ) {
        setJobProgress(job, 'processing', mapPhasePercentToOverallPercent('processing', 100), 'Processing downloaded media...', true, null);
        return;
    }

    if (line.startsWith('[yt] Rebuilding library index...')) {
        setJobProgress(job, 'indexing', mapPhasePercentToOverallPercent('indexing', 0), 'Refreshing library index...', true, null);
        return;
    }

    if (line.startsWith('[build] Library index updated:')) {
        setJobProgress(job, 'indexing', mapPhasePercentToOverallPercent('indexing', 100), 'Refreshing library index...', true, null);
        return;
    }

    if (line.startsWith('[yt] Done.')) {
        setJobProgress(job, 'done', 100, 'Completed.', false, 0);
    }
}

let nextJobId = 1;
let activeJob = null;
let activeChildProcess = null;
const pendingJobs = [];
const completedJobs = [];

function pushJobLog(job, chunk) {
    if (!chunk) return;
    const lines = String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        job.logs.push(line);
        updateJobProgressFromLogLine(job, line);
    }

    if (job.logs.length > MAX_JOB_LOG_LINES) {
        job.logs.splice(0, job.logs.length - MAX_JOB_LOG_LINES);
    }
}

function summarizeJob(job, includeTail = false) {
    if (!job) return null;
    const summary = {
        id: job.id,
        url: job.url,
        targetPath: job.targetPath,
        state: job.state,
        progress: job.progress || null,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
        error: job.error || null
    };
    if (includeTail) {
        summary.logTail = job.logs.slice(-5);
    }
    return summary;
}

function buildStatusPayload() {
    return {
        activeJob: summarizeJob(activeJob, true),
        queueLength: pendingJobs.length,
        pendingJobs: pendingJobs.slice(0, 8).map((job) => summarizeJob(job)),
        lastFinishedJob: completedJobs[0] ? summarizeJob(completedJobs[0], true) : null
    };
}

function processQueue() {
    if (activeJob || pendingJobs.length === 0) return;

    if (!fs.existsSync(YT_SCRIPT_PATH)) {
        const failedJob = pendingJobs.shift();
        failedJob.state = 'failed';
        failedJob.startedAt = Date.now();
        failedJob.finishedAt = Date.now();
        failedJob.error = 'Missing ./yt script';
        failedJob.logs.push('Missing ./yt script');
        completedJobs.unshift(failedJob);
        if (completedJobs.length > MAX_COMPLETED_JOBS) completedJobs.length = MAX_COMPLETED_JOBS;
        return;
    }

    const job = pendingJobs.shift();
    job.state = 'running';
    job.startedAt = Date.now();
    setJobProgress(job, 'starting', 1, 'Preparing download...', true);
    activeJob = job;

    const child = spawn(YT_SCRIPT_PATH, [job.url], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            YT_OUTPUT_DIR: job.targetDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChildProcess = child;

    child.stdout.on('data', (chunk) => pushJobLog(job, chunk));
    child.stderr.on('data', (chunk) => pushJobLog(job, chunk));

    child.on('error', (error) => {
        job.state = 'failed';
        job.finishedAt = Date.now();
        job.error = error.message || 'Failed to spawn downloader';
        pushJobLog(job, job.error);
        setJobProgress(job, 'failed', job.progress ? job.progress.percent : 0, 'Failed.', true);
        activeChildProcess = null;
        activeJob = null;
        completedJobs.unshift(job);
        if (completedJobs.length > MAX_COMPLETED_JOBS) completedJobs.length = MAX_COMPLETED_JOBS;
        processQueue();
    });

    child.on('close', (code) => {
        job.finishedAt = Date.now();
        if (code === 0) {
            job.state = 'done';
            setJobProgress(job, 'done', 100, 'Completed.', false);
        } else {
            job.state = 'failed';
            job.error = job.error || `Downloader exited with code ${code}`;
            setJobProgress(job, 'failed', job.progress ? job.progress.percent : 0, 'Failed.', true);
        }
        activeChildProcess = null;
        activeJob = null;
        completedJobs.unshift(job);
        if (completedJobs.length > MAX_COMPLETED_JOBS) completedJobs.length = MAX_COMPLETED_JOBS;
        processQueue();
    });
}

function enqueueYouTubeDownload(urlValue, targetDir, targetPath) {
    const job = {
        id: nextJobId,
        url: urlValue,
        targetDir,
        targetPath,
        state: 'queued',
        progress: createJobProgress('queued', 0, 'Queued...', true),
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        error: '',
        logs: [],
        downloadPartTotal: 0,
        downloadPartSeen: 0
    };
    nextJobId += 1;

    pendingJobs.push(job);
    processQueue();
    return job;
}

async function handleApi(req, res, pathname, searchParams) {
    if (pathname === '/api/youtube/status' && req.method === 'GET') {
        sendJson(res, 200, buildStatusPayload());
        return true;
    }

    if (pathname === '/api/folder-state' && req.method === 'GET') {
        const requestedPath = searchParams.get('path') || '';
        const resolvedPath = resolveLibraryPathInsideRoot(requestedPath);
        if (!resolvedPath) {
            sendJson(res, 400, { error: 'Invalid folder path' });
            return true;
        }

        let folderStats;
        try {
            folderStats = await fsp.stat(resolvedPath.absolute);
        } catch (_) {
            folderStats = null;
        }
        if (!folderStats || !folderStats.isDirectory()) {
            sendJson(res, 404, { error: 'Folder not found' });
            return true;
        }

        let dirents = [];
        try {
            dirents = await fsp.readdir(resolvedPath.absolute, { withFileTypes: true });
        } catch (_) {
            sendJson(res, 500, { error: 'Unable to read folder' });
            return true;
        }

        const entries = dirents
            .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
            .map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? 'folder' : 'file'
            }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        sendJson(res, 200, {
            ok: true,
            path: resolvedPath.normalized,
            entries
        });
        return true;
    }

    if (pathname === '/api/youtube/download' && req.method === 'POST') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            sendJson(res, 400, { error: error.message || 'Invalid request body' });
            return true;
        }

        const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
        if (!isYouTubeUrl(rawUrl)) {
            sendJson(res, 400, { error: 'Provide a valid YouTube URL' });
            return true;
        }

        const targetDir = resolveTargetDirectory(body.targetPath);
        if (!targetDir) {
            sendJson(res, 400, { error: 'Invalid target folder' });
            return true;
        }
        let targetStats;
        try {
            targetStats = await fsp.stat(targetDir);
        } catch (_) {
            targetStats = null;
        }
        if (!targetStats || !targetStats.isDirectory()) {
            sendJson(res, 400, { error: 'Target folder does not exist' });
            return true;
        }

        const relativeTargetPath = path.relative(ROOT_DIR, targetDir).split(path.sep).join('/');
        const safeTargetPath = relativeTargetPath === '' ? '' : relativeTargetPath;

        const job = enqueueYouTubeDownload(rawUrl, targetDir, safeTargetPath);
        const isRunningNow = activeJob && activeJob.id === job.id;
        const queuePosition = isRunningNow
            ? 1
            : (pendingJobs.findIndex((item) => item.id === job.id) + 2);

        sendJson(res, 202, {
            ok: true,
            state: isRunningNow ? 'running' : 'queued',
            queuePosition,
            targetPath: safeTargetPath,
            job: summarizeJob(job)
        });
        return true;
    }

    return false;
}

function start() {
    let config;
    try {
        config = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`[server] ${error.message}`);
        usage();
        process.exit(1);
    }

    const server = http.createServer(async (req, res) => {
        const method = req.method || 'GET';
        const requestUrl = req.url || '/';
        let parsed;
        try {
            parsed = new URL(requestUrl, `http://${config.host}:${config.port}`);
        } catch (_) {
            sendText(res, 400, 'Bad Request');
            return;
        }

        try {
            if (parsed.pathname.startsWith('/api/')) {
                const handled = await handleApi(req, res, parsed.pathname, parsed.searchParams);
                if (!handled) sendText(res, 404, 'Not Found');
                return;
            }

            if (method !== 'GET' && method !== 'HEAD') {
                sendText(res, 405, 'Method Not Allowed');
                return;
            }

            await serveStatic(req, res, parsed.pathname);
        } catch (error) {
            console.error('[server] Request failed:', error);
            sendText(res, 500, 'Internal Server Error');
        }
    });

    server.listen(config.port, config.host, () => {
        console.log(`[server] Listening on http://${config.host}:${config.port}`);
    });

    const shutdown = () => {
        if (activeChildProcess && !activeChildProcess.killed) {
            activeChildProcess.kill('SIGTERM');
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start();
