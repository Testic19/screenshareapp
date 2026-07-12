const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');

// Expose real local IPs as ICE host candidates (Chromium hides them behind
// mDNS .local by default). Needed so a Tailscale/ZeroTier virtual-LAN address
// (100.x.x.x) is used → direct full-quality P2P over the virtual network.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// TURBO paket:
// - ignore-gpu-blocklist: unlock hardware encode on GPUs Chromium blocklists
// - QualityScaling/Disabled: encoder may NOT silently downscale resolution
// - FlexFEC: forward error correction — lost packets get reconstructed from
//   parity data instead of waiting for a retransmit (fewer visible glitches)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch(
  'force-fieldtrials',
  'WebRTC-Video-QualityScaling/Disabled/WebRTC-FlexFEC-03/Enabled/WebRTC-FlexFEC-03-Advertised/Enabled/'
);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0e0f13',
    title: 'ScreenShareP2P',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Return a list of capturable screens/windows with thumbnail previews.
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null
  }));
});

app.whenReady().then(() => {
  // Enable getDisplayMedia fallback path if ever used by the renderer.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        callback({ video: sources[0] });
      });
    },
    { useSystemPicker: false }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
