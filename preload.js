// preload.js — Runs in a privileged context before the renderer.
// Exposes a safe API to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    isElectron: true,

    // Ask the main process to start proxying a stream URL through FFmpeg
    // (transcodes AC-3/E-AC-3 → AAC).  Returns { proxyUrl: string }.
    startStream: (url) => ipcRenderer.invoke('start-stream', url),

    // Stop the current FFmpeg transcode process
    stopStream: () => ipcRenderer.invoke('stop-stream'),

    // Listen for FFmpeg log messages from main process
    onFfmpegLog: (callback) => {
        ipcRenderer.on('ffmpeg-log', (_event, msg) => callback(msg));
    },
});
