const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = '11111111-1111-1111-1111-111111111111';
let origin;
const metadataHits = [];
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/canvas/api/v1/files/')) {
    metadataHits.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    const fileId = request.url.split('/').pop();
    response.end(JSON.stringify({ display_name: fileId === '3' ? 'Unlabelled.pdf' : 'Notes.docx',
      'content-type': fileId === '3' ? 'application/pdf' : 'application/msword',
      url: origin + '/canvas/files/' + fileId + '/download?verifier=api-token' }));
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  if (request.url.includes('/courses/12/')) {
    response.end('<!doctype html><html><body class="ic-app"><div id="content"><h1>Module 2: Lectures</h1>' +
      '<h3>First lecture</h3><iframe src="/Panopto/Pages/Embed.aspx?id=' + id + '"></iframe>' +
      '<a href="/Panopto/Pages/Viewer.aspx?id=' + id + '">Same recording</a>' +
      '<a href="/custom/Panopto/Pages/Viewer.aspx?ID=' + id.toUpperCase() + '">Other installation</a>' +
      '<a href="/canvas/courses/12/files/1?wrap=1&verifier=link-token">Slides.pdf</a>' +
      '<a href="/canvas/files/1">Duplicate.pdf</a><a href="/canvas/files/2">Slides.pdf</a>' +
      '<a href="/canvas/files/3">Read the notes</a><a href="/canvas/files/4">Assignment document</a>' +
      '<a href="/assets/External.PDF?token=example">External handout</a></div></body></html>');
  } else if (request.url.includes('/courses/99/')) {
    response.end('<html><body><div id="content"><a href="/assets/example.pdf">Example.pdf</a></div></body></html>');
  } else {
    response.end('<!doctype html><html><body>Fixture</body></html>');
  }
});

function connect(browser) {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  browser.stdio[4].setEncoding('utf8');
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!frame) continue;
      const data = JSON.parse(frame);
      if (!pending.has(data.id)) continue;
      const { resolve, reject, timer } = pending.get(data.id);
      pending.delete(data.id);
      clearTimeout(timer);
      if (data.error) reject(new Error(JSON.stringify(data.error))); else resolve(data.result);
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Browser command timed out: ' + method));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  };
  return { send, session: sessionId => ({ send: (method, params) => send(method, params, sessionId) }) };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function main() {
  const browserBinary = process.env.CANVAS_TEST_BROWSER ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(browserBinary), 'Set CANVAS_TEST_BROWSER to a Chromium-based browser executable');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-detection-'));
  const log = fs.openSync(path.join(profile, 'browser.log'), 'w');
  const browser = spawn(browserBinary, [
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--user-data-dir=' + profile, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank'
  ], { stdio: ['ignore', log, log, 'pipe', 'pipe'] });
  const browserClient = connect(browser);
  try {
    await browserClient.send('Browser.getVersion');
    await browserClient.send('Extensions.loadUnpacked', { path: process.cwd() });
    await browserClient.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(profile, 'downloads') });
    async function tab(url) {
      const { targetId } = await browserClient.send('Target.createTarget', { url });
      const { sessionId } = await browserClient.send('Target.attachToTarget', { targetId, flatten: true });
      return browserClient.session(sessionId);
    }
    const canvas = await tab(origin + '/canvas/courses/12/pages/lecture');
    let count;
    for (let i = 0; i < 100; i++) {
      count = await evaluate(canvas, "document.querySelector('.jhu-dl-count')?.textContent.trim()");
      if (/2 videos,\s+4 slides/.test(count || '')) break;
      await delay(100);
    }
    assert.match(count || '', /2 videos,\s+4 slides/);
    assert.deepEqual(metadataHits.sort(), ['/canvas/api/v1/files/3', '/canvas/api/v1/files/4']);
    await evaluate(canvas, 'document.getElementById("content").insertAdjacentHTML("beforeend", ' +
      JSON.stringify('<h4>Late lecture</h4><iframe src="/Panopto/Pages/Embed.aspx?id=22222222-2222-2222-2222-222222222222"></iframe>') + ')');
    for (let i = 0; i < 50; i++) {
      count = await evaluate(canvas, "document.querySelector('.jhu-dl-count')?.textContent.trim()");
      if (/3 videos/.test(count)) break;
      await delay(100);
    }
    assert.match(count, /3 videos,\s+4 slides/);
    await delay(500);
    assert.equal(metadataHits.length, 2, 'Metadata must be cached across rescans');
    const unrelated = await tab(origin + '/courses/99/pages/not-canvas');
    await delay(1000);
    assert.equal(await evaluate(unrelated, "Boolean(document.getElementById('jhu-dl-container'))"), false);

    // An initially unmatched tab avoids mixing real extension listeners with the mock.
    const mock = await tab(origin + '/fixture');
    await delay(500);
    const markup = await evaluate(canvas, 'document.body.innerHTML');
    await evaluate(mock, 'document.body.className = "ic-app"; document.body.innerHTML = ' + JSON.stringify(markup) +
      '; document.getElementById("jhu-dl-container")?.remove(); history.pushState({}, "", "/canvas/courses/12/pages/mock")');
    await evaluate(mock, 'window.__messages = []; window.chrome = { runtime: { sendMessage: async message => { window.__messages.push(message); return message.action === "resolveStreams" ? { videos: [] } : { success: true }; } } };');
    await evaluate(mock, fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf8'));
    await delay(700);
    await evaluate(mock, "document.getElementById('jhu-dl-videos-check').checked = false; document.getElementById('jhu-dl-btn').click()");
    await delay(1800);
    const downloads = await evaluate(mock, 'window.__messages.filter(message => message.action === "downloadFile")');
    assert.equal(downloads.length, 4);
    assert.equal(downloads[0].url, origin + '/canvas/files/1/download?verifier=link-token&download_frd=1');
    assert.equal(downloads[1].url, origin + '/canvas/files/2/download?download_frd=1');
    assert.equal(downloads[2].url, origin + '/canvas/files/3/download?verifier=api-token&download_frd=1');
    assert.equal(downloads[3].url, origin + '/assets/External.PDF?token=example');
    assert.ok(downloads.every(item => item.folder === 'Module_2_Lectures'));
    console.log('PASS: custom Canvas detection, Panopto paths, IDs, deduplication, metadata, dynamic embeds, non-Canvas exclusion, and download URLs');
  } finally {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit'), delay(5000)]);
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGKILL');
      await once(browser, 'exit');
    }
    browser.stdio[3].destroy();
    browser.stdio[4].destroy();
    fs.closeSync(log);
    fs.rmSync(profile, { recursive: true, force: true });
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
