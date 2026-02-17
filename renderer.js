// renderer.js — Runs in the Electron renderer process.
// Initialises Shaka Player, wires up UI controls, and
// provides a live status/log display.

/* global shaka */

// ─── Logging ──────────────────────────────────────────────────
const logPanel = document.getElementById('logPanel');

function addLog(msg, level = 'info') {
    const line = document.createElement('div');
    line.className = 'log-line ' + level;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logPanel.appendChild(line);
    logPanel.scrollTop = logPanel.scrollHeight;
    // Keep max 200 lines
    while (logPanel.childElementCount > 200) {
        logPanel.removeChild(logPanel.firstChild);
    }
}

// ─── Status helpers ───────────────────────────────────────────
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const codecInfo = document.getElementById('codecInfo');
const bufferInfo = document.getElementById('bufferInfo');
const speedInfo = document.getElementById('speedInfo');

function setStatus(state, text) {
    statusDot.className = 'dot ' + state;
    statusText.textContent = text;
}

// ─── Shaka Player Setup ──────────────────────────────────────
shaka.polyfill.installAll();

if (!shaka.Player.isBrowserSupported()) {
    addLog('Browser/Electron not supported by Shaka Player!', 'error');
}

const video = document.getElementById('video');
const player = new shaka.Player();

// attach() is async in compiled Shaka Player
let playerReady = false;
player.attach(video).then(() => {
    playerReady = true;
    addLog('Shaka Player attached to video element', 'info');
}).catch((e) => {
    addLog(`Failed to attach player: ${e}`, 'error');
});

// Configure for progressive TS streaming
player.configure({
    streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 5,
        bufferBehind: 30,
        retryParameters: {
            timeout: 0,
            stallTimeout: 0,
            maxAttempts: 5,
            baseDelay: 1000,
            backoffFactor: 2,
            fuzzFactor: 0.5,
        },
    },
});

// Hook into Shaka's log to display in our panel
const originalInfo = shaka.log.info;
const originalWarn = shaka.log.warning;
const originalError = shaka.log.error;

shaka.log.info = function (...args) {
    originalInfo.apply(shaka.log, args);
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (msg.includes('Progress')) {
        // Parse speed from progress messages
        const speedMatch = msg.match(/Speed \(Avg\):\s*([\d.]+)/);
        if (speedMatch) {
            speedInfo.textContent = `Speed: ${speedMatch[1]} MB/s`;
        }
        const bufMatch = msg.match(/Buffer:\s*(\[[\d.\-]+\])/);
        if (bufMatch) {
            bufferInfo.textContent = `Buffer: ${bufMatch[1]}`;
        }
    }
    if (msg.includes('Detected track')) {
        addLog(msg, 'info');
        codecInfo.textContent = msg.includes('video') ?
            msg.replace(/.*Mime:\s*/, 'Video: ') :
            msg.replace(/.*Mime:\s*/, 'Audio: ');
    }
};

shaka.log.warning = function (...args) {
    originalWarn.apply(shaka.log, args);
    const msg = args.map((a) => String(a)).join(' ');
    addLog(msg, 'warn');
};

shaka.log.error = function (...args) {
    originalError.apply(shaka.log, args);
    const msg = args.map((a) => String(a)).join(' ');
    addLog(msg, 'error');
};

// Error handler
player.addEventListener('error', (event) => {
    const error = event.detail;
    addLog(`Shaka Error: ${error.code} - ${error.message}`, 'error');
    setStatus('', 'Error: ' + error.code);
});

// Buffering state
player.addEventListener('buffering', (event) => {
    if (event.buffering) {
        setStatus('buffering', 'Buffering...');
        addLog('Buffering started', 'warn');
    } else {
        setStatus('playing', 'Playing');
        addLog('Buffering ended', 'info');
    }
});

// Video events
video.addEventListener('playing', () => {
    setStatus('playing', 'Playing');
});

video.addEventListener('waiting', () => {
    setStatus('buffering', 'Waiting for data...');
});

video.addEventListener('pause', () => {
    setStatus('', 'Paused');
});

// ─── Buffer monitor ──────────────────────────────────────────
setInterval(() => {
    if (video.buffered.length > 0) {
        const currentTime = video.currentTime;
        let ahead = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            if (currentTime >= video.buffered.start(i) - 0.5 &&
                currentTime <= video.buffered.end(i)) {
                ahead = video.buffered.end(i) - currentTime;
                break;
            }
        }
        bufferInfo.textContent = `Buffer: ${ahead.toFixed(1)}s ahead`;
    }
}, 1000);

// ─── UI Controls ─────────────────────────────────────────────
const channelSelect = document.getElementById('channelSelect');
const customUrlRow = document.getElementById('customUrlRow');
const customUrl = document.getElementById('customUrl');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');

channelSelect.addEventListener('change', () => {
    if (channelSelect.value === 'custom') {
        customUrlRow.classList.add('visible');
    } else {
        customUrlRow.classList.remove('visible');
    }
});

playBtn.addEventListener('click', async () => {
    let url = channelSelect.value;
    if (url === 'custom') {
        url = customUrl.value.trim();
    }
    if (!url) {
        addLog('No channel selected', 'warn');
        return;
    }
    if (!playerReady) {
        addLog('Player not ready yet, please wait...', 'warn');
        return;
    }

    addLog(`Original URL: ${url}`, 'info');
    setStatus('buffering', 'Loading...');

    try {
        // Unload any previous stream
        await player.unload();

        const urlLower = url.split('?')[0].toLowerCase();
        const isTS = urlLower.endsWith('.ts');
        const isMKV = urlLower.endsWith('.mkv');
        const isHLS = urlLower.endsWith('.m3u8');

        // For TS/MKV streams: route through FFmpeg proxy to transcode
        // AC-3/E-AC-3 → AAC (stock Chromium MSE doesn't support AC-3).
        // HLS streams are loaded directly (Shaka handles them natively).
        let loadUrl = url;
        let mimeType = null;

        if ((isTS || isMKV) && window.electronAPI) {
            addLog('TS/MKV detected → routing through FFmpeg proxy (AC-3→AAC)', 'info');
            addLog('FFmpeg: video=copy (passthrough), audio=AC-3→AAC transcode', 'info');

            const result = await window.electronAPI.startStream(url);
            loadUrl = result.proxyUrl;
            mimeType = 'video/mp2t';

            addLog(`Proxy URL: ${loadUrl}`, 'info');
        } else if (isHLS) {
            addLog('HLS stream → loading directly via Shaka', 'info');
        } else {
            addLog('Unknown format → loading directly via Shaka', 'info');
        }

        addLog('Calling player.load()...', 'info');
        if (mimeType) {
            await player.load(loadUrl, /* startTime= */ null, mimeType);
        } else {
            await player.load(loadUrl);
        }

        addLog('Stream loaded successfully!', 'info');
        setStatus('live', 'Live');

        // Auto-play
        video.play().catch((e) => {
            addLog(`Auto-play blocked: ${e.message}`, 'warn');
        });
    } catch (e) {
        const detail = e.detail || e;
        addLog(`Load failed: code=${detail.code || 'N/A'} severity=${detail.severity || 'N/A'}`, 'error');
        addLog(`  message: ${detail.message || e.message || e}`, 'error');
        if (detail.data) {
            addLog(`  data: ${JSON.stringify(detail.data)}`, 'error');
        }
        setStatus('', 'Load failed');
        console.error('Shaka load error:', e);
    }
});

stopBtn.addEventListener('click', async () => {
    try {
        await player.unload();
        // Tell main process to kill FFmpeg
        if (window.electronAPI) {
            await window.electronAPI.stopStream();
        }
        setStatus('', 'Stopped');
        addLog('Playback stopped', 'info');
        codecInfo.textContent = '—';
        bufferInfo.textContent = 'Buffer: —';
        speedInfo.textContent = 'Speed: —';
    } catch (e) {
        addLog(`Stop error: ${e}`, 'error');
    }
});

// ─── Codec support check ─────────────────────────────────────
function checkCodecSupport() {
    const codecs = {
        'H.264': 'video/mp4; codecs="avc1.64002A"',
        'HEVC': 'video/mp4; codecs="hvc1.1.6.L120.90"',
        'AC-3': 'audio/mp4; codecs="ac-3"',
        'E-AC-3': 'audio/mp4; codecs="ec-3"',
        'AAC': 'audio/mp4; codecs="mp4a.40.2"',
        'Opus': 'audio/mp4; codecs="opus"',
        'MP3': 'audio/mp4; codecs="mp3"',
    };

    addLog('── Codec Support Check ──', 'info');
    for (const [name, mime] of Object.entries(codecs)) {
        const supported = MediaSource.isTypeSupported(mime);
        addLog(`  ${name}: ${supported ? '✓ Supported' : '✗ Not supported'}`,
            supported ? 'info' : 'warn');
    }
}

// Run codec check on startup
checkCodecSupport();

// Show electron info
if (window.electronAPI && window.electronAPI.isElectron) {
    addLog(`Running in Electron on ${window.electronAPI.platform}`, 'info');

    // Listen for FFmpeg log messages from main process
    window.electronAPI.onFfmpegLog((msg) => {
        addLog(`[ffmpeg] ${msg}`, msg.startsWith('ERROR') ? 'error' : 'info');
    });
}

addLog('IPTV Player ready. Select a channel and press Play.', 'info');
addLog('TS streams are routed through FFmpeg (AC-3→AAC transcode).', 'info');
