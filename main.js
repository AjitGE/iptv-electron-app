// main.js — Electron main process
// Sets up the BrowserWindow with TiviMate User-Agent,
// codec flags, and an FFmpeg transcoding proxy that converts
// AC-3/E-AC-3 audio to AAC so Chromium MSE can play it.

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ─── User-Agent ──────────────────────────────────────────────
const TIVIMATE_USER_AGENT =
    'TiviMate/4.7.0 (Linux; Android 12; SHIELD Android TV) ' +
    'ExoPlayerLib/2.19.1';

// ─── Chromium flags for codec support ────────────────────────
app.commandLine.appendSwitch('enable-features',
    'PlatformHEVCDecoderSupport,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-features', 'AllowAllCodecs');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ─── FFmpeg Transcoding Proxy ────────────────────────────────
// Spawns FFmpeg to transcode AC-3/E-AC-3 audio → AAC while
// passing video through untouched.  Serves the result on a
// local HTTP port so the renderer can load it via Shaka Player.
const PROXY_PORT = 9876;
let ffmpegProcess = null;
let proxyServer = null;
let currentStreamUrl = null;

function killFfmpeg() {
    if (ffmpegProcess) {
        try {
            ffmpegProcess.kill('SIGKILL');
        } catch (_) { /* already dead */ }
        ffmpegProcess = null;
    }
}

function startProxy() {
    proxyServer = http.createServer((req, res) => {
        // Only serve /stream.ts
        if (req.url !== '/stream.ts' || !currentStreamUrl) {
            res.writeHead(404);
            res.end('No stream');
            return;
        }

        console.log('[proxy] Streaming:', currentStreamUrl);

        // Kill any existing FFmpeg process
        killFfmpeg();

        // Spawn FFmpeg:
        //   - Input: the CDN stream URL
        //   - Video: copy (passthrough, no re-encoding)
        //   - Audio: transcode to AAC (stereo, 192k)
        //   - Output: MPEG-TS on stdout
        //   - User-Agent: TiviMate
        ffmpegProcess = spawn('ffmpeg', [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', TIVIMATE_USER_AGENT,
            '-i', currentStreamUrl,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ac', '2',
            '-b:a', '192k',
            '-f', 'mpegts',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            'pipe:1',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'keep-alive',
        });

        ffmpegProcess.stdout.pipe(res);

        ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                console.log('[ffmpeg]', msg);
                // Forward FFmpeg logs to renderer
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('ffmpeg-log', msg);
                }
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error('[ffmpeg] spawn error:', err.message);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ffmpeg-log',
                    `ERROR: FFmpeg spawn failed: ${err.message}`);
            }
        });

        ffmpegProcess.on('close', (code) => {
            console.log('[ffmpeg] exited with code:', code);
            ffmpegProcess = null;
        });

        // If the HTTP connection is closed (player stopped), kill FFmpeg
        req.on('close', () => {
            killFfmpeg();
        });
    });

    proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
        console.log(`[proxy] FFmpeg transcoding proxy on http://127.0.0.1:${PROXY_PORT}`);
    });
}

// ─── IPC Handlers ────────────────────────────────────────────
// Renderer tells us which stream to proxy
ipcMain.handle('start-stream', async (_event, url) => {
    killFfmpeg();
    currentStreamUrl = url;
    console.log('[ipc] Stream URL set:', url);
    return { proxyUrl: `http://127.0.0.1:${PROXY_PORT}/stream.ts` };
});

ipcMain.handle('stop-stream', async () => {
    killFfmpeg();
    currentStreamUrl = null;
    console.log('[ipc] Stream stopped');
    return { ok: true };
});

// ─── Window ──────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: 'IPTV Player',
        backgroundColor: '#000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false,
        },
    });

    // Apply TiviMate User-Agent to all HTTP requests
    session.defaultSession.webRequest.onBeforeSendHeaders(
        (details, callback) => {
            details.requestHeaders['User-Agent'] = TIVIMATE_USER_AGENT;
            callback({ requestHeaders: details.requestHeaders });
        },
    );

    const isDev = process.argv.includes('--dev');
    if (isDev) {
        mainWindow.loadURL('http://localhost:8000/demo/');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
    }

    mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Override User-Agent:', TIVIMATE_USER_AGENT);
    });

    mainWindow.on('closed', () => {
        killFfmpeg();
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    app.userAgentFallback = TIVIMATE_USER_AGENT;
    startProxy();
    createWindow();
});

app.on('window-all-closed', () => {
    killFfmpeg();
    if (proxyServer) proxyServer.close();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});
