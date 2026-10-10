// ═══════════════════════════════════════════════════════════════════
// Canvas Lecture Downloader — Content Script
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const fileMetadata = new Map();
  const metadataQueue = [];
  let metadataRequests = 0;
  let downloadRunning = false;
  let scanning = false;
  let scanAgain = false;
  let lastSignature = '';
  let scanTimer;

  function isCanvasPage() {
    if (!/\/(?:courses|files)\/\d+(?:\/|$)/.test(location.pathname)) return false;
    return /(^|\.)instructure\.com$/i.test(location.hostname) ||
      document.body.classList.contains('ic-app') ||
      Boolean(document.querySelector('meta[name="generator"][content*="Canvas" i], #application.ic-app'));
  }

  function contentRoot() {
    return document.querySelector('.show-content') ||
      document.querySelector('#content') || document.body;
  }

  function safeFilename(value, fallback) {
    const cleaned = String(value || '').normalize('NFC')
      .replace(/[\x00-\x1f\x7f/\\:?%*|"<>]/g, '-')
      .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 150);
    const name = cleaned || fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
  }

  function httpUrl(value, base = location.href) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch (_) {
      return null;
    }
  }

  function panoptoVideo(value, depth = 0) {
    const url = httpUrl(value);
    if (!url) return null;
    // Match the player path, including universities with custom Panopto domains.
    const player = url.pathname.match(/^(.*\/Panopto\/Pages\/)(?:Embed|Viewer)\.aspx$/i);
    const id = [...url.searchParams].find(([key]) => /^(id|deliveryid)$/i.test(key))?.[1];
    if (player && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id || '')) {
      return { id: id.toLowerCase(), panoptoUrl: url.href,
        key: `${url.origin}${player[1].toLowerCase()}${id.toLowerCase()}` };
    }
    // Some Canvas links wrap the actual player URL in a redirect parameter.
    if (depth < 2) {
      for (const [key, nested] of url.searchParams) {
        if (/^(url|src|redirect|redirect_uri|return_url)$/i.test(key)) {
          const video = panoptoVideo(nested, depth + 1);
          if (video) return video;
        }
      }
    }
    return null;
  }

  function canvasBasePath() {
    return location.pathname.match(/^(.*?)\/(?:courses|files)\/\d+(?:\/|$)/)?.[1] || '';
  }

  function getFileMetadata(fileId) {
    if (!fileMetadata.has(fileId)) {
      fileMetadata.set(fileId, null);
      metadataQueue.push(fileId);
      fetchNextMetadata();
    }
    return fileMetadata.get(fileId);
  }

  function fetchNextMetadata() {
    // Unlabelled links should not delay the initial toolbar or flood Canvas's API.
    while (metadataRequests < 4 && metadataQueue.length > 0) {
      const fileId = metadataQueue.shift();
      metadataRequests++;
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`${canvasBasePath()}/api/v1/files/${fileId}`, {
            credentials: 'same-origin', signal: controller.signal
          });
          fileMetadata.set(fileId, response.ok ? await response.json() : null);
        } catch (_) {
          fileMetadata.set(fileId, null);
        } finally {
          clearTimeout(timeout);
          metadataRequests--;
          fetchNextMetadata();
          scheduleScan();
        }
      })();
    }
  }

  async function scanPage() {
    const root = contentRoot();
    const result = { moduleName: '', videos: [], pdfs: [] };
    const pageTitle = root.querySelector('.page-title, h1') || document.querySelector('.page-title, h1');
    const titleText = (pageTitle?.textContent || '').trim();
    const moduleMatch = titleText.match(/Module\s+\d+/i);
    result.moduleName = moduleMatch ? `${moduleMatch[0].replace(/\s+/g, '_')}_Lectures` :
      safeFilename(titleText, 'Canvas_Lectures').replace(/\s+/g, '_');

    const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const seenVideos = new Set();
    for (const element of root.querySelectorAll('iframe[src], iframe[data-src], a[href]')) {
      if (element.closest('#jhu-dl-container')) continue;
      const video = panoptoVideo(element.getAttribute('src') || element.getAttribute('data-src') || element.href);
      if (!video || seenVideos.has(video.key)) continue;
      seenVideos.add(video.key);
      const heading = headings.filter(item =>
        Boolean(item.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)).pop();
      const linkText = element.tagName === 'A' ? element.textContent.trim() : '';
      const title = linkText || heading?.textContent.trim() || element.title || `Lecture ${result.videos.length + 1}`;
      result.videos.push({ id: video.id, title, panoptoUrl: video.panoptoUrl });
    }

    const seenPdfs = new Set();
    for (const link of root.querySelectorAll('a[href]')) {
      if (link.closest('#jhu-dl-container')) continue;
      const url = httpUrl(link.href);
      if (!url) continue;
      const fileMatch = url.origin === location.origin && url.pathname.match(/\/files\/(\d+)(?:\/download)?\/?$/);
      const labels = [link.getAttribute('download'), link.textContent.trim(), link.title];
      let basename;
      try { basename = decodeURIComponent(url.pathname.split('/').pop()); } catch (_) { basename = ''; }
      let filename = [...labels, basename].find(label => /\.pdf$/i.test(label || ''));
      let metadata = null;
      if (fileMatch && !filename) {
        metadata = getFileMetadata(fileMatch[1]);
        if (metadata?.['content-type'] === 'application/pdf' || /\.pdf$/i.test(metadata?.display_name || metadata?.filename || '')) {
          filename = metadata.display_name || metadata.filename || `Slides_${fileMatch[1]}.pdf`;
          if (!/\.pdf$/i.test(filename)) filename += '.pdf';
        }
      }
      if (!filename || (!fileMatch && !/\.pdf$/i.test(basename || ''))) continue;
      let downloadUrl = url;
      if (fileMatch) {
        downloadUrl = httpUrl(metadata?.url) || new URL(`${canvasBasePath()}/files/${fileMatch[1]}/download`, location.origin);
        // Canvas API URLs may point directly to signed external storage.
        // Keep those URLs intact; only adjust links on the Canvas origin.
        if (downloadUrl.origin === url.origin) {
          for (const [key, value] of url.searchParams) {
            if (!/^(wrap|preview)$/i.test(key)) downloadUrl.searchParams.set(key, value);
          }
          downloadUrl.searchParams.set('download_frd', '1');
        }
      }
      const key = fileMatch ? `canvas:${fileMatch[1]}` : downloadUrl.href.split('#')[0];
      if (seenPdfs.has(key)) continue;
      seenPdfs.add(key);
      result.pdfs.push({ fileId: fileMatch ? fileMatch[1] : null, displayName: filename,
        filename: safeFilename(filename, 'Slides.pdf'), url: downloadUrl.href });
    }
    return result;
  }

  function createUI(data) {
    const existing = document.getElementById('jhu-dl-container');
    const wantVideos = document.getElementById('jhu-dl-videos-check')?.checked ?? true;
    const wantPdfs = document.getElementById('jhu-dl-pdfs-check')?.checked ?? true;
    if (existing) existing.remove();

    if (data.videos.length === 0 && data.pdfs.length === 0) return;

    const container = document.createElement('div');
    container.id = 'jhu-dl-container';
    container.innerHTML = `
      <div class="jhu-dl-header">
        <div class="jhu-dl-info">
          <span class="jhu-dl-icon">📥</span>
          <span class="jhu-dl-title">Lecture Downloader</span>
          <span class="jhu-dl-count">
            ${data.videos.length} video${data.videos.length !== 1 ? 's' : ''},
            ${data.pdfs.length} slide${data.pdfs.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div class="jhu-dl-actions">
          <label class="jhu-dl-checkbox-label">
            <input type="checkbox" id="jhu-dl-videos-check" checked />
            Videos
          </label>
          <label class="jhu-dl-checkbox-label">
            <input type="checkbox" id="jhu-dl-pdfs-check" checked />
            Slides
          </label>
          <button id="jhu-dl-btn" class="jhu-dl-button">Download All</button>
        </div>
      </div>
      <div id="jhu-dl-progress" class="jhu-dl-progress" style="display:none;">
        <div class="jhu-dl-progress-bar">
          <div id="jhu-dl-progress-fill" class="jhu-dl-progress-fill"></div>
        </div>
        <div id="jhu-dl-status" class="jhu-dl-status"></div>
      </div>
    `;

    const contentEl = contentRoot();
    contentEl.insertBefore(container, contentEl.firstChild);

    document.getElementById('jhu-dl-videos-check').checked = wantVideos;
    document.getElementById('jhu-dl-pdfs-check').checked = wantPdfs;
    document.getElementById('jhu-dl-btn')
      .addEventListener('click', () => startDownload(data));
  }

  function updateProgress(current, total) {
    const fill = document.getElementById('jhu-dl-progress-fill');
    if (fill) fill.style.width = Math.round((current / total) * 100) + '%';
  }

  function addStatus(msg, type = 'info') {
    const status = document.getElementById('jhu-dl-status');
    if (!status) return;
    const line = document.createElement('div');
    line.className = `jhu-dl-status-line jhu-dl-${type}`;
    line.textContent = msg;
    status.appendChild(line);
    status.scrollTop = status.scrollHeight;
  }

  async function startDownload(data) {
    const btn = document.getElementById('jhu-dl-btn');
    const progress = document.getElementById('jhu-dl-progress');
    const wantVideos = document.getElementById('jhu-dl-videos-check').checked;
    const wantPdfs = document.getElementById('jhu-dl-pdfs-check').checked;

    if (!wantVideos && !wantPdfs) {
      alert('Select at least Videos or Slides to download.');
      return;
    }

    downloadRunning = true;
    document.getElementById('jhu-dl-status').replaceChildren();
    btn.disabled = true;
    btn.textContent = '⏳ Working…';
    btn.classList.add('jhu-dl-button-disabled');
    progress.style.display = 'block';

    const folder = data.moduleName || 'Canvas_Lectures';
    const videosToGet = wantVideos ? data.videos : [];
    const pdfsToGet = wantPdfs ? data.pdfs : [];
    const totalItems = videosToGet.length + pdfsToGet.length;
    let completed = 0;

    try {
      if (videosToGet.length > 0) {
        addStatus(`🎥 Resolving ${videosToGet.length} video stream URL${videosToGet.length > 1 ? 's' : ''}…`);

        const result = await chrome.runtime.sendMessage({
          action: 'resolveStreams',
          videos: videosToGet
        });

        if (result.error) {
          addStatus(`❌ Stream resolution failed: ${result.error}`, 'error');
          throw new Error(result.error);
        }

        for (const video of result.videos) {
          if (video.streamUrl) {
            addStatus(`⬇️ Starting: ${video.filename}`);
            const dlRes = await chrome.runtime.sendMessage({
              action: 'downloadFile',
              url: video.streamUrl,
              filename: video.filename,
              folder: folder
            });

            if (dlRes && dlRes.error) {
              addStatus(`❌ Failed ${video.filename}: ${dlRes.error}`, 'error');
            } else {
              completed++;
              updateProgress(completed, totalItems);
              addStatus(`✅ Download started: ${video.filename}`, 'success');
            }
          } else {
            addStatus(`⚠️ ${video.title}: ${video.error || 'No stream found'}`, 'warn');
            completed++;
            updateProgress(completed, totalItems);
          }
          await new Promise(r => setTimeout(r, 400));
        }
      }

      if (pdfsToGet.length > 0) {
        addStatus(`📄 Downloading ${pdfsToGet.length} slide PDF${pdfsToGet.length > 1 ? 's' : ''}…`);

        for (const pdf of pdfsToGet) {
          addStatus(`⬇️ Starting: ${pdf.filename}`);
          const downloadUrl = pdf.url;
          const dlRes = await chrome.runtime.sendMessage({
            action: 'downloadFile',
            url: downloadUrl,
            filename: pdf.filename,
            folder: folder
          });

          if (dlRes && dlRes.error) {
            addStatus(`❌ Failed ${pdf.filename}: ${dlRes.error}`, 'error');
          } else {
            completed++;
            updateProgress(completed, totalItems);
            addStatus(`✅ Download started: ${pdf.filename}`, 'success');
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      addStatus(`Download requests processed. Check your browser downloads for completion (${folder}/).`, 'success');
      btn.textContent = '✅ Requests processed';
      btn.classList.remove('jhu-dl-button-disabled');
      btn.classList.add('jhu-dl-button-done');

    } catch (e) {
      addStatus(`❌ Error: ${e.message}`, 'error');
      btn.textContent = '🔄 Retry';
      btn.disabled = false;
      btn.classList.remove('jhu-dl-button-disabled');
    } finally {
      downloadRunning = false;
      scheduleScan();
    }
  }

  async function refreshUI() {
    if (downloadRunning) return;
    if (scanning) { scanAgain = true; return; }
    scanning = true;
    try {
      do {
        scanAgain = false;
        if (!isCanvasPage()) {
          document.getElementById('jhu-dl-container')?.remove();
          lastSignature = '';
          return;
        }
        const pageUrl = location.href;
        const data = await scanPage();
        if (pageUrl !== location.href) { scanAgain = true; continue; }
        const signature = JSON.stringify(data);
        if (!downloadRunning && (signature !== lastSignature ||
            (data.videos.length + data.pdfs.length > 0 &&
             document.getElementById('jhu-dl-container')?.parentElement !== contentRoot()))) {
          createUI(data);
          lastSignature = signature;
        }
      } while (scanAgain && !downloadRunning);
    } catch (error) {
      console.error('[Canvas Downloader] Page scan failed:', error);
    } finally {
      scanning = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(refreshUI, 300);
  }

  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.parentElement?.closest('#jhu-dl-container') &&
        !record.target.closest?.('#jhu-dl-container'))) scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['src', 'data-src', 'href', 'title', 'download', 'class'] });
  window.addEventListener('popstate', scheduleScan);
  scheduleScan();
})();
