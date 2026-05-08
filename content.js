(function installChaoxingPdfButtons() {
  if (window.__cxpdlContentInstalled) {
    return;
  }
  window.__cxpdlContentInstalled = true;

  const records = new Map();
  const fetchedResourceUrls = new Set();
  const timers = {
    render: 0,
    embedded: 0,
    cleanup: 0,
    context: 0
  };
  let bulkDownloadRunning = false;
  let extensionInvalidated = false;
  let activeContextKey = "";

  const IS_TOP_WINDOW = isTopWindow();
  const PANEL_UI_VERSION = "10";
  const COLLAPSED_PANEL_WIDTH = 260;
  const COLLAPSED_PANEL_HEIGHT = 38;
  const PANEL_STATE_KEY = "cxpdl-panel-state";

  const NAME_KEYS = ["filename", "fileName"];

  injectPageBridgeFallback();

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== "CXPDL_PAGE_BRIDGE" || data.type !== "network-response") {
      return;
    }

    collectRecords(data.payload, data.url).forEach(upsertRecord);
  });

  if (canUseRuntime()) {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.type !== "CXPDL_SHARED_RECORD") {
          return;
        }

        upsertRecord(message.record, {
          silent: true
        });
      });
    } catch (error) {
      markRuntimeError(error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDomWatch, { once: true });
  } else {
    startDomWatch();
  }

  function startDomWatch() {
    schedule("cleanup", cleanupLegacyInlineButtons, 150);
    schedule("embedded", scanEmbeddedPageData, 700);
    [400, 1800, 4500].forEach((delay) => setTimeout(scanPerformanceResources, delay));
    window.setInterval(scanPerformanceResources, 2500);
    schedule("context", checkCurrentContext, 250);
    window.setInterval(() => schedule("context", checkCurrentContext, 0), 1200);
    schedule("render", renderButtons, 250);

    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => isExtensionOwnedNode(mutation.target))) {
        return;
      }

      schedule("cleanup", cleanupLegacyInlineButtons, 150);
      schedule("embedded", scanEmbeddedPageData, 700);
      setTimeout(scanPerformanceResources, 800);
      schedule("context", checkCurrentContext, 300);
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function injectPageBridgeFallback() {
    const inject = () => {
      const root = document.documentElement || document.head;
      if (!root || document.getElementById("cxpdl-page-bridge-script")) {
        return false;
      }

      const script = document.createElement("script");
      const bridgeUrl = runtimeGetURL("page-bridge.js");
      if (!bridgeUrl) {
        return false;
      }

      script.id = "cxpdl-page-bridge-script";
      script.src = bridgeUrl;
      script.onload = () => script.remove();
      root.prepend(script);
      return true;
    };

    if (inject()) {
      return;
    }

    document.addEventListener("readystatechange", inject, { once: true });
    setTimeout(inject, 100);
    setTimeout(inject, 500);
  }

  function schedule(name, task, delay) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(task, delay);
  }

  function cleanupLegacyInlineButtons() {
    if (!document.body) {
      return;
    }

    document
      .querySelectorAll(".cxpdl-inline-button, [data-cxpdl-id], button, a, span")
      .forEach((node) => {
        if (node.closest("#cxpdl-panel, #cxpdl-toast")) {
          return;
        }

        const text = cleanText(node.textContent || "");
        const title = cleanText(node.getAttribute && node.getAttribute("title"));
        if (
          node.classList.contains("cxpdl-inline-button") ||
          node.hasAttribute("data-cxpdl-id") ||
          text === "下载PDF" ||
          title.startsWith("下载：")
        ) {
          node.remove();
        }
      });
  }

  function checkCurrentContext() {
    handleContextSeen(getChapterContextKey());
  }

  function handleContextSeen(contextKey) {
    if (!contextKey) {
      return;
    }

    if (activeContextKey && activeContextKey !== contextKey && shouldClearForContextChange(activeContextKey, contextKey)) {
      records.clear();
      fetchedResourceUrls.clear();
      removeFloatingPanel();
      schedule("render", renderButtons, 250);
    }

    activeContextKey = contextKey;
  }

  function shouldClearForContextChange(previous, next) {
    const previousType = contextType(previous);
    const nextType = contextType(next);
    return previousType && nextType && previousType === nextType;
  }

  function contextType(contextKey) {
    const match = String(contextKey || "").match(/^([^=]+)=/);
    return match ? match[1].toLowerCase() : "";
  }

  function collectRecords(payload, sourceUrl) {
    const result = [];
    walk(payload, sourceUrl || location.href, result, 0);
    return result;
  }

  function walk(value, sourceUrl, result, depth) {
    if (depth > 8 || value == null) {
      return;
    }

    if (typeof value === "string") {
      extractFromText(value, sourceUrl).forEach((record) => result.push(record));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, sourceUrl, result, depth + 1));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const record = recordFromObject(value, sourceUrl);
    if (record) {
      result.push(record);
    }

    Object.keys(value).forEach((key) => walk(value[key], sourceUrl, result, depth + 1));
  }

  function recordFromObject(object, sourceUrl) {
    const filename = cleanFilename(firstString(object, NAME_KEYS));
    if (!isPdfFilename(filename)) {
      return null;
    }

    const objectId = cleanText(object.objectid || object.objectId || object.fileId || object.resid || "");
    const pdfUrl = normalizeChaoxingPdfUrl(object.pdf, objectId);
    if (!isDownloadCandidate(pdfUrl, "pdf")) {
      return null;
    }

    return normalizeRecord({
      filename,
      downloadUrl: pdfUrl,
      objectId,
      sourceUrl,
      contextKey: getChapterContextKey(sourceUrl)
    });
  }

  function extractFromText(text, sourceUrl) {
    const recordsFromJson = parseTextAsJson(text, sourceUrl);
    if (recordsFromJson.length) {
      return recordsFromJson;
    }

    return extractRecordLikeText(text.replace(/\\"/g, "\"").replace(/\\\//g, "/"), sourceUrl);
  }

  function parseTextAsJson(text, sourceUrl) {
    const parsed = safeJsonParse(text);
    if (parsed) {
      return collectRecords(parsed, sourceUrl);
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const jsonp = safeJsonParse(text.slice(start, end + 1));
      if (jsonp) {
        return collectRecords(jsonp, sourceUrl);
      }
    }

    return [];
  }

  function scanEmbeddedPageData() {
    if (!document.documentElement) {
      return;
    }

    const html = document.documentElement.innerHTML || "";
    if (!/filename|fileName/i.test(html) || !/"pdf"\s*:/i.test(html) || !/\.pdf/i.test(html)) {
      return;
    }

    extractInterestingChunks(html).forEach((chunk) => {
      extractFromText(chunk, location.href).forEach(upsertRecord);
    });
  }

  function extractInterestingChunks(text) {
    const chunks = [];
    const pattern = /filename|fileName/gi;
    let match = pattern.exec(text);

    while (match && chunks.length < 20) {
      const start = Math.max(0, match.index - 5000);
      const end = Math.min(text.length, match.index + 5000);
      chunks.push(text.slice(start, end));
      match = pattern.exec(text);
    }

    return chunks;
  }

  function extractRecordLikeText(text, sourceUrl) {
    const result = [];
    const patterns = [
      /"pdf"\s*:\s*"([^"]+)"[\s\S]{0,2400}"(?:filename|fileName)"\s*:\s*"([^"]+)"/gi,
      /"(?:filename|fileName)"\s*:\s*"([^"]+)"[\s\S]{0,2400}"pdf"\s*:\s*"([^"]+)"/gi
    ];

    patterns.forEach((pattern, patternIndex) => {
      let match = pattern.exec(text);
      while (match) {
        const pdfUrl = patternIndex === 0 ? match[1] : match[2];
        const filename = patternIndex === 0 ? match[2] : match[1];
        const objectId = nearestFieldValue(text, match.index, "objectid");
        const record = normalizeRecord({
          filename: cleanFilename(filename),
          downloadUrl: normalizeChaoxingPdfUrl(pdfUrl, objectId),
          objectId,
          sourceUrl,
          contextKey: getChapterContextKey(sourceUrl)
        });

        if (record && isDownloadCandidate(record.downloadUrl, "pdf")) {
          result.push(record);
        }
        match = pattern.exec(text);
      }
    });

    return result;
  }

  function nearestFieldValue(text, index, key) {
    const start = Math.max(0, index - 1600);
    const end = Math.min(text.length, index + 1600);
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i");
    const match = text.slice(start, end).match(regex);
    return match ? decodeJsonish(match[1]) : "";
  }

  function scanPerformanceResources() {
    if (!performance || typeof performance.getEntriesByType !== "function") {
      return;
    }

    performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(isInterestingResourceUrl)
      .filter((url) => !fetchedResourceUrls.has(url))
      .slice(0, 80)
      .forEach((url) => {
        fetchedResourceUrls.add(url);
        safeSendMessage({
          type: "CXPDL_FETCH_TEXT",
          url
        }, (response, error) => {
          if (error || !response || !response.ok || !response.text) {
            return;
          }
          extractFromText(response.text, response.url || url).forEach(upsertRecord);
        });
      });
  }

  function isInterestingResourceUrl(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) {
      return false;
    }

    return /default_config|content\.json|mirrorConfig|studentstudy|courselist|marklists|read\/|[?&]flag=normal(?:&|$)|\/[0-9a-f]{32}(?:[?#]|$)/i.test(url);
  }

  function upsertRecord(record, options) {
    if (!record || !record.downloadUrl || !isPdfFilename(record.filename)) {
      return;
    }

    const contextKey = contextKeyForRecord(record);
    handleContextSeen(contextKey);

    const id = record.objectId || stableHash(`${record.downloadUrl}|${record.filename}`);
    const previous = records.get(id);
    records.set(id, {
      id,
      ...previous,
      ...record
    });

    if (!options || !options.silent) {
      safeSendMessage({
        type: "CXPDL_SHARE_RECORD",
        record: {
          id,
          filename: record.filename,
          downloadUrl: record.downloadUrl,
          objectId: record.objectId || "",
          sourceUrl: record.sourceUrl || location.href,
          contextKey: contextKey || activeContextKey || getChapterContextKey(record.sourceUrl)
        }
      });
    }

    schedule("render", renderButtons, 250);
  }

  function contextKeyForRecord(record) {
    if (IS_TOP_WINDOW) {
      return getChapterContextKey() || record.contextKey || getChapterContextKey(record.sourceUrl);
    }

    return record.contextKey || getChapterContextKey(record.sourceUrl);
  }

  function renderButtons() {
    if (!document.body) {
      return;
    }

    if (!IS_TOP_WINDOW) {
      removeFloatingPanel();
      return;
    }

    const list = Array.from(records.values());
    renderFloatingPanel(list);
  }

  function renderFloatingPanel(list) {
    let existing = document.getElementById("cxpdl-panel");
    if (existing && existing.dataset.cxpdlUiVersion !== PANEL_UI_VERSION) {
      existing.remove();
      existing = null;
    }

    const signature = list.length
      ? list.map((record) => `${record.id}:${record.filename}:${record.downloadUrl}`).join("|")
      : "empty";
    if (existing && existing.dataset.cxpdlSignature === signature) {
      return;
    }

    const panel = existing || createFloatingPanel();
    panel.dataset.cxpdlUiVersion = PANEL_UI_VERSION;
    panel.dataset.cxpdlSignature = signature;
    updatePanelHeader(panel, list.length);

    const body = panel.querySelector(".cxpdl-panel-body");
    body.textContent = "";

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "cxpdl-panel-empty";
      empty.textContent = "等待学习通 PDF 配置加载";
      body.append(empty);
    }

    list.slice(0, 20).forEach((record) => {
      const item = document.createElement("div");
      item.className = "cxpdl-panel-item";

      const name = document.createElement("span");
      name.className = "cxpdl-panel-name";
      name.title = record.filename;
      name.textContent = record.filename;

      item.append(name, createDownloadButton(record));
      body.append(item);
    });

    if (!existing) {
      document.body.append(panel);
    }
  }

  function createFloatingPanel() {
    const panel = document.createElement("div");
    panel.id = "cxpdl-panel";
    panel.className = "cxpdl-panel";
    panel.dataset.cxpdlUiVersion = PANEL_UI_VERSION;
    applySavedPanelLayout(panel);

    const header = document.createElement("div");
    header.className = "cxpdl-panel-header";

    const title = document.createElement("span");
    title.className = "cxpdl-panel-title";
    title.textContent = "学习通PDF";

    const actions = document.createElement("div");
    actions.className = "cxpdl-panel-actions";

    const downloadAll = document.createElement("button");
    downloadAll.className = "cxpdl-panel-download-all";
    downloadAll.type = "button";
    downloadAll.textContent = "全部下载";
    downloadAll.title = "下载当前发现的全部 PDF";
    downloadAll.addEventListener("click", () => downloadAllRecords(downloadAll));

    const close = document.createElement("button");
    close.className = "cxpdl-panel-close";
    close.type = "button";
    close.textContent = "−";
    close.title = "收起/展开";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPanelCollapsed(panel, !panel.classList.contains("cxpdl-panel-collapsed"));
    });

    const body = document.createElement("div");
    body.className = "cxpdl-panel-body";

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "cxpdl-panel-resize";
    resizeHandle.title = "拖动调整大小";

    actions.append(downloadAll, close);
    header.append(title, actions);
    panel.append(header, body, resizeHandle);
    installPanelInteractions(panel, header, resizeHandle);
    return panel;
  }

  function removeFloatingPanel() {
    const panel = document.getElementById("cxpdl-panel");
    if (panel) {
      panel.remove();
    }
  }

  function updatePanelHeader(panel, count) {
    const title = panel.querySelector(".cxpdl-panel-title");
    if (title) {
      title.textContent = `学习通PDF (${count})`;
    }

    const downloadAll = panel.querySelector(".cxpdl-panel-download-all");
    if (downloadAll) {
      downloadAll.disabled = !count || bulkDownloadRunning;
    }

    const close = panel.querySelector(".cxpdl-panel-close");
    if (close) {
      close.textContent = panel.classList.contains("cxpdl-panel-collapsed") ? "+" : "−";
    }
  }

  function setPanelCollapsed(panel, collapsed) {
    if (!panel) {
      return;
    }

    if (collapsed) {
      if (!panel.classList.contains("cxpdl-panel-collapsed")) {
        const expandedRect = panel.getBoundingClientRect();
        rememberExpandedPanelSize(panel, expandedRect.width, expandedRect.height);
      }

      const rect = panel.getBoundingClientRect();
      setImportantStyle(panel, "left", `${rect.left}px`);
      setImportantStyle(panel, "top", `${rect.top}px`);
      setImportantStyle(panel, "right", "auto");
      setImportantStyle(panel, "bottom", "auto");
      panel.style.setProperty("--cxpdl-panel-collapsed-height", `${COLLAPSED_PANEL_HEIGHT}px`);
      setPanelSize(panel, COLLAPSED_PANEL_WIDTH, COLLAPSED_PANEL_HEIGHT, {
        minWidth: COLLAPSED_PANEL_WIDTH,
        minHeight: COLLAPSED_PANEL_HEIGHT
      });
      panel.classList.add("cxpdl-panel-collapsed");
      clampPanelToViewport(panel);
    } else {
      const expandedSize = getExpandedPanelSize(panel);
      panel.classList.remove("cxpdl-panel-collapsed");
      setPanelSize(panel, expandedSize.width, expandedSize.height);
      clampPanelToViewport(panel);
    }

    const button = panel.querySelector(".cxpdl-panel-close");
    if (button) {
      button.textContent = collapsed ? "+" : "−";
    }
  }

  function createDownloadButton(record) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cxpdl-panel-button";
    button.dataset.cxpdlId = record.id;
    button.title = `下载：${record.filename}`;
    button.textContent = "下载PDF";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      downloadRecord(record, button);
    });
    return button;
  }

  function downloadRecord(record, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "下载中";

    requestDownload(record)
      .then(() => showToast("已开始下载"))
      .catch((error) => showToast(error.message || "下载失败", true))
      .finally(() => {
        button.disabled = false;
        button.textContent = originalText;
      });
  }

  function requestDownload(record) {
    return new Promise((resolve, reject) => {
      safeSendMessage({
        type: "CXPDL_DOWNLOAD",
        url: record.downloadUrl,
        filename: record.filename
      }, (response, error) => {
        if (error || !response || !response.ok) {
          reject(new Error((error && error.message) || (response && response.error) || "下载失败"));
          return;
        }

        resolve(response);
      });
    });
  }

  async function downloadAllRecords(button) {
    const list = Array.from(records.values()).filter((record) => record && record.downloadUrl && isPdfFilename(record.filename));
    if (!list.length || bulkDownloadRunning) {
      return;
    }

    bulkDownloadRunning = true;
    const originalText = button.textContent;
    button.disabled = true;

    let successCount = 0;
    let failCount = 0;

    for (let index = 0; index < list.length; index += 1) {
      button.textContent = `${index + 1}/${list.length}`;
      try {
        await requestDownload(list[index]);
        successCount += 1;
      } catch (_error) {
        failCount += 1;
      }

      if (index < list.length - 1) {
        await wait(500);
      }
    }

    bulkDownloadRunning = false;
    button.disabled = false;
    button.textContent = originalText;

    const panel = document.getElementById("cxpdl-panel");
    if (panel) {
      updatePanelHeader(panel, list.length);
    }

    if (failCount) {
      showToast(`已开始 ${successCount} 个，失败 ${failCount} 个`, true);
    } else {
      showToast(`已开始下载 ${successCount} 个 PDF`);
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function createToast() {
    const toast = document.createElement("div");
    toast.id = "cxpdl-toast";
    toast.className = "cxpdl-toast";
    document.body.append(toast);
    return toast;
  }

  function showToast(message, isError) {
    const toast = document.getElementById("cxpdl-toast") || createToast();
    toast.textContent = message;
    toast.classList.toggle("cxpdl-toast-error", Boolean(isError));
    toast.classList.add("cxpdl-toast-visible");

    clearTimeout(toast.__cxpdlTimer);
    toast.__cxpdlTimer = setTimeout(() => {
      toast.classList.remove("cxpdl-toast-visible");
    }, 2400);
  }

  function canUseRuntime() {
    if (extensionInvalidated || typeof chrome === "undefined" || !chrome.runtime) {
      return false;
    }

    try {
      return Boolean(chrome.runtime.id);
    } catch (error) {
      markRuntimeError(error);
      return false;
    }
  }

  function runtimeGetURL(path) {
    if (!canUseRuntime()) {
      return "";
    }

    try {
      return chrome.runtime.getURL(path);
    } catch (error) {
      markRuntimeError(error);
      return "";
    }
  }

  function safeSendMessage(message, callback) {
    if (!canUseRuntime()) {
      if (callback) {
        callback(null, new Error("扩展上下文已失效，请刷新页面"));
      }
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = runtimeLastError();
        if (error) {
          markRuntimeError(error);
        }
        if (callback) {
          callback(response, error);
        }
      });
    } catch (error) {
      markRuntimeError(error);
      if (callback) {
        callback(null, error);
      }
    }
  }

  function runtimeLastError() {
    try {
      return chrome.runtime.lastError || null;
    } catch (error) {
      markRuntimeError(error);
      return error;
    }
  }

  function markRuntimeError(error) {
    const message = error && error.message ? error.message : String(error || "");
    if (/context invalidated|Extension context invalidated/i.test(message)) {
      extensionInvalidated = true;
    }
  }

  function isTopWindow() {
    try {
      return window.top === window;
    } catch (_error) {
      return false;
    }
  }

  function firstString(object, keys) {
    for (const key of keys) {
      if (typeof object[key] === "string" && object[key].trim()) {
        return object[key];
      }
    }
    return "";
  }

  function isDownloadCandidate(url, key) {
    const value = String(url || "");
    if (!isProbablyUrl(value) || /\/thumb\//i.test(value)) {
      return false;
    }

    return String(key || "") === "pdf" && /\/pdf\/[^/?#]+\.pdf(?:[?#].*)?$/i.test(value);
  }

  function isExtensionOwnedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    return Boolean(node.closest("#cxpdl-panel, #cxpdl-toast"));
  }

  function isProbablyUrl(value) {
    return /^(https?:)?\/\//i.test(String(value || ""));
  }

  function getChapterContextKey(sourceUrl) {
    return pickBestChapterContext([
      extractChapterContextFromUrl(sourceUrl),
      extractChapterContextFromUrl(location.href),
      extractChapterContextFromUrl(document.referrer),
      extractChapterContextFromFrames()
    ]);
  }

  function extractChapterContextFromFrames() {
    if (!document.querySelectorAll) {
      return "";
    }

    const frames = document.querySelectorAll("iframe[src], frame[src]");
    for (const frame of frames) {
      const contextKey = extractChapterContextFromUrl(frame.getAttribute("src"));
      if (contextKey) {
        return contextKey;
      }
    }

    return "";
  }

  function extractChapterContextFromUrl(url) {
    if (!url || typeof url !== "string") {
      return "";
    }

    const decoded = decodeJsonish(url);
    try {
      const parsed = new URL(decoded, location.href);
      const keys = [
        "knowledgeid",
        "knowledgeId",
        "chapterid",
        "chapterId",
        "jobid",
        "jobId",
        "nodeid",
        "nodeId",
        "enc"
      ];

      for (const key of keys) {
        const value = parsed.searchParams.get(key);
        if (value) {
          return `${key.toLowerCase()}=${value}`;
        }
      }

      const hashContext = extractChapterContextFromQueryText(parsed.hash);
      if (hashContext) {
        return hashContext;
      }
    } catch (_error) {
      return extractChapterContextFromQueryText(decoded);
    }

    return "";
  }

  function extractChapterContextFromQueryText(text) {
    const match = String(text || "").match(/(knowledgeid|knowledgeId|chapterid|chapterId|jobid|jobId|nodeid|nodeId|enc)[=:]([A-Za-z0-9_-]+)/);
    return match ? `${match[1].toLowerCase()}=${match[2]}` : "";
  }

  function pickBestChapterContext(candidates) {
    const list = candidates.filter(Boolean);
    if (!list.length) {
      return "";
    }

    return list.sort((left, right) => contextPriority(left) - contextPriority(right))[0];
  }

  function contextPriority(contextKey) {
    const key = String(contextKey || "").toLowerCase();
    if (key.startsWith("chapterid=")) {
      return 0;
    }
    if (key.startsWith("knowledgeid=")) {
      return 1;
    }
    if (key.startsWith("nodeid=")) {
      return 2;
    }
    if (key.startsWith("jobid=")) {
      return 3;
    }
    if (key.startsWith("enc=")) {
      return 9;
    }
    return 5;
  }

  function absolutize(url) {
    if (!url) {
      return "";
    }

    const value = decodeJsonish(String(url).trim());
    if (value.startsWith("//")) {
      return `${location.protocol}${value}`;
    }

    try {
      return new URL(value, location.href).href;
    } catch (_error) {
      return value;
    }
  }

  function normalizeChaoxingPdfUrl(url, objectId) {
    const absoluteUrl = absolutize(url);
    if (!absoluteUrl || /\/thumb\//i.test(absoluteUrl)) {
      return "";
    }

    const cleanObjectId = cleanText(objectId).replace(/\.pdf$/i, "");

    try {
      const parsed = new URL(absoluteUrl);
      parsed.hash = "";

      let pathname = parsed.pathname;
      if (/\/pdf\/[^/]+\.pdf$/i.test(pathname)) {
        return parsed.href;
      }

      if (/\/pdf\/?$/i.test(pathname) && cleanObjectId) {
        pathname = pathname.replace(/\/?$/i, `/${cleanObjectId}.pdf`);
      } else if (/\/pdf\/[^/.]+$/i.test(pathname)) {
        pathname = `${pathname}.pdf`;
      } else {
        return "";
      }

      parsed.pathname = pathname.replace(/\/{2,}/g, "/");
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  function applySavedPanelLayout(panel) {
    const state = readSavedPanelState();
    if (!state) {
      return;
    }

    const width = clamp(state.width, 260, Math.max(260, window.innerWidth - 36));
    const height = clamp(state.height, 170, Math.max(170, window.innerHeight - 36));
    const left = clamp(state.left, 8, Math.max(8, window.innerWidth - width - 8));
    const top = clamp(state.top, 8, Math.max(8, window.innerHeight - height - 8));

    rememberExpandedPanelSize(panel, width, height);
    setPanelSize(panel, width, height);
    setImportantStyle(panel, "left", `${left}px`);
    setImportantStyle(panel, "top", `${top}px`);
    setImportantStyle(panel, "right", "auto");
    setImportantStyle(panel, "bottom", "auto");
  }

  function installPanelInteractions(panel, header, resizeHandle) {
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) {
        return;
      }
      beginPanelDrag(event, panel);
    });

    resizeHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      beginPanelResize(event, panel);
    });

    window.addEventListener("resize", () => clampPanelToViewport(panel));
  }

  function beginPanelDrag(event, panel) {
    event.preventDefault();
    capturePointer(event);
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    let animationFrame = 0;
    let pendingLeft = startLeft;
    let pendingTop = startTop;

    setImportantStyle(panel, "left", `${startLeft}px`);
    setImportantStyle(panel, "top", `${startTop}px`);
    setImportantStyle(panel, "right", "auto");
    setImportantStyle(panel, "bottom", "auto");
    panel.classList.add("cxpdl-panel-moving");

    const onMove = (moveEvent) => {
      pendingLeft = clamp(startLeft + moveEvent.clientX - startX, 8, Math.max(8, window.innerWidth - rect.width - 8));
      pendingTop = clamp(startTop + moveEvent.clientY - startY, 8, Math.max(8, window.innerHeight - rect.height - 8));

      if (!animationFrame) {
        animationFrame = requestAnimationFrame(() => {
          animationFrame = 0;
          setImportantStyle(panel, "left", `${pendingLeft}px`);
          setImportantStyle(panel, "top", `${pendingTop}px`);
        });
      }
    };

    const onEnd = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        setImportantStyle(panel, "left", `${pendingLeft}px`);
        setImportantStyle(panel, "top", `${pendingTop}px`);
      }
      panel.classList.remove("cxpdl-panel-moving");
      savePanelState(panel);
      releasePointer(event);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onEnd, true);
      document.removeEventListener("pointercancel", onEnd, true);
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onEnd, true);
    document.addEventListener("pointercancel", onEnd, true);
  }

  function beginPanelResize(event, panel) {
    if (panel.classList.contains("cxpdl-panel-collapsed")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    capturePointer(event);

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    let animationFrame = 0;
    let pendingWidth = startWidth;
    let pendingHeight = startHeight;

    setImportantStyle(panel, "left", `${rect.left}px`);
    setImportantStyle(panel, "top", `${rect.top}px`);
    setImportantStyle(panel, "right", "auto");
    setImportantStyle(panel, "bottom", "auto");
    panel.classList.add("cxpdl-panel-resizing");

    const onMove = (moveEvent) => {
      const maxWidth = Math.max(260, window.innerWidth - rect.left - 8);
      const maxHeight = Math.max(170, window.innerHeight - rect.top - 8);
      pendingWidth = clamp(startWidth + moveEvent.clientX - startX, 260, maxWidth);
      pendingHeight = clamp(startHeight + moveEvent.clientY - startY, 170, maxHeight);

      if (!animationFrame) {
        animationFrame = requestAnimationFrame(() => {
          animationFrame = 0;
          setPanelSize(panel, pendingWidth, pendingHeight);
        });
      }
    };

    const onEnd = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        setPanelSize(panel, pendingWidth, pendingHeight);
      }
      panel.classList.remove("cxpdl-panel-resizing");
      savePanelState(panel);
      releasePointer(event);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onEnd, true);
      document.removeEventListener("pointercancel", onEnd, true);
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onEnd, true);
    document.addEventListener("pointercancel", onEnd, true);
  }

  function clampPanelToViewport(panel) {
    if (!panel) {
      return;
    }

    const isCollapsed = panel.classList.contains("cxpdl-panel-collapsed");
    const rect = panel.getBoundingClientRect();
    const minWidth = isCollapsed ? COLLAPSED_PANEL_WIDTH : 260;
    const minHeight = isCollapsed ? COLLAPSED_PANEL_HEIGHT : 170;
    const width = isCollapsed
      ? COLLAPSED_PANEL_WIDTH
      : clamp(rect.width, minWidth, Math.max(minWidth, window.innerWidth - 16));
    const height = isCollapsed
      ? COLLAPSED_PANEL_HEIGHT
      : clamp(rect.height, minHeight, Math.max(minHeight, window.innerHeight - 16));
    const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8));
    const top = clamp(rect.top, 8, Math.max(8, window.innerHeight - height - 8));

    if (isCollapsed) {
      setPanelSize(panel, width, height, {
        minWidth,
        minHeight
      });
    } else {
      setPanelSize(panel, width, height);
      rememberExpandedPanelSize(panel, width, height);
    }

    setImportantStyle(panel, "left", `${left}px`);
    setImportantStyle(panel, "top", `${top}px`);
    setImportantStyle(panel, "right", "auto");
    setImportantStyle(panel, "bottom", "auto");
    savePanelState(panel);
  }

  function readSavedPanelState() {
    try {
      const state = safeJsonParse(localStorage.getItem(PANEL_STATE_KEY));
      return state && Number.isFinite(state.left) && Number.isFinite(state.top) &&
        Number.isFinite(state.width) && Number.isFinite(state.height)
        ? state
        : null;
    } catch (_error) {
      return null;
    }
  }

  function savePanelState(panel) {
    const rect = panel.getBoundingClientRect();
    const isCollapsed = panel.classList.contains("cxpdl-panel-collapsed");
    if (!isCollapsed) {
      rememberExpandedPanelSize(panel, rect.width, rect.height);
    }

    const expandedSize = getExpandedPanelSize(panel);
    try {
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(isCollapsed ? expandedSize.width : rect.width),
        height: Math.round(isCollapsed ? expandedSize.height : rect.height)
      }));
    } catch (_error) {
      // Storage can be unavailable in some embedded frames.
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || min, min), max);
  }

  function setImportantStyle(element, property, value) {
    element.style.setProperty(property, value, "important");
  }

  function rememberExpandedPanelSize(panel, width, height) {
    const nextWidth = clamp(width, 260, Math.max(260, window.innerWidth - 16));
    const nextHeight = clamp(height, 170, Math.max(170, window.innerHeight - 16));
    panel.dataset.cxpdlExpandedWidth = `${Math.round(nextWidth)}`;
    panel.dataset.cxpdlExpandedHeight = `${Math.round(nextHeight)}`;
  }

  function getExpandedPanelSize(panel) {
    const previous = readSavedPanelState() || {};
    const rect = panel.getBoundingClientRect();
    return {
      width: clamp(
        Number(panel.dataset.cxpdlExpandedWidth || previous.width || rect.width || 280),
        260,
        Math.max(260, window.innerWidth - 16)
      ),
      height: clamp(
        Number(panel.dataset.cxpdlExpandedHeight || previous.height || rect.height || 360),
        170,
        Math.max(170, window.innerHeight - 16)
      )
    };
  }

  function setPanelSize(panel, width, height, options = {}) {
    const minWidth = options.minWidth || 260;
    const minHeight = options.minHeight || 170;
    const nextWidth = clamp(width, minWidth, Math.max(minWidth, window.innerWidth - 16));
    const nextHeight = clamp(height, minHeight, Math.max(minHeight, window.innerHeight - 16));
    panel.style.setProperty("--cxpdl-panel-width", `${Math.round(nextWidth)}px`);
    panel.style.setProperty("--cxpdl-panel-height", `${Math.round(nextHeight)}px`);
  }

  function capturePointer(event) {
    try {
      if (event.currentTarget && event.currentTarget.setPointerCapture) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    } catch (_error) {
      // Some embedded frames reject pointer capture; document listeners still handle the drag.
    }
  }

  function releasePointer(event) {
    try {
      if (event.currentTarget && event.currentTarget.releasePointerCapture) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch (_error) {
      // Pointer may already be released.
    }
  }

  function normalizeRecord(record) {
    const filename = cleanFilename(record.filename);
    if (!isPdfFilename(filename)) {
      return null;
    }

    const downloadUrl = normalizeChaoxingPdfUrl(record.downloadUrl, record.objectId);
    if (!downloadUrl) {
      return null;
    }

    return {
      ...record,
      filename,
      downloadUrl,
      objectId: cleanText(record.objectId || "")
    };
  }

  function cleanFilename(filename) {
    return decodeJsonish(String(filename || ""))
      .replace(/^[\\/]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanText(text) {
    return decodeJsonish(String(text || ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPdfFilename(filename) {
    return /\.pdf$/i.test(cleanFilename(filename));
  }

  function decodeJsonish(value) {
    return String(value || "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\"/g, "\"")
      .replace(/&amp;/gi, "&")
      .replace(/&#38;/g, "&")
      .replace(/&#x26;/gi, "&")
      .replace(/&quot;/gi, "\"");
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function stableHash(input) {
    let hash = 0;
    const text = String(input || "");
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return `h${Math.abs(hash)}`;
  }
})();
