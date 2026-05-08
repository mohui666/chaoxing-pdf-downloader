chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "CXPDL_DOWNLOAD") {
    startDownload(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      });

    return true;
  }

  if (message.type === "CXPDL_FETCH_TEXT") {
    fetchText(message.url)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      });

    return true;
  }

  if (message.type === "CXPDL_SHARE_RECORD") {
    shareRecordToTab(sender, message.record);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startDownload(message) {
  const url = normalizeUrl(message.url);
  if (!url) {
    throw new Error("没有找到可下载链接");
  }

  const filename = sanitizeFilename(message.filename);
  if (!/\.pdf$/i.test(filename)) {
    throw new Error("接口 filename 不是 PDF 文件名，已阻止下载");
  }

  const downloadId = await downloadPdfByFetch(url, filename);

  return {
    ok: true,
    downloadId
  };
}

async function downloadPdfByFetch(url, filename) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`下载接口返回 ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/pdf";
  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    throw new Error("下载接口返回空文件");
  }

  if (!isPdfResponse(contentType, arrayBuffer)) {
    throw new Error("下载接口返回的不是 PDF，已阻止保存为 htm/json");
  }

  const mime = /pdf/i.test(contentType) ? contentType.split(";")[0] : "application/pdf";
  const dataUrl = `data:${mime};base64,${arrayBufferToBase64(arrayBuffer)}`;

  return download({
    url: dataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

function download(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function shareRecordToTab(sender, record) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number" || !record) {
    return;
  }

  chrome.tabs.sendMessage(sender.tab.id, {
    type: "CXPDL_SHARED_RECORD",
    record
  }, {
    frameId: 0
  }, () => {
    // Ignore tabs without an active matching content script.
    void chrome.runtime.lastError;
  });
}

async function fetchText(url) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error("接口地址无效");
  }

  const response = await fetch(normalizedUrl, {
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`接口返回 ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/json|text|javascript|octet-stream/i.test(contentType)) {
    return {
      ok: false,
      ignored: true,
      reason: `忽略非文本响应：${contentType}`
    };
  }

  const text = await response.text();
  return {
    ok: true,
    url: response.url || normalizedUrl,
    text: text.slice(0, 2 * 1024 * 1024)
  };
}

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return "";
  }

  const trimmed = url.trim();
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  return trimmed;
}

function sanitizeFilename(filename) {
  const cleaned = String(filename)
    .replace(/^[\\/]+/, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "学习通文档.pdf";
}

function isPdfResponse(contentType, arrayBuffer) {
  if (/application\/pdf/i.test(contentType)) {
    return true;
  }

  const header = new Uint8Array(arrayBuffer.slice(0, 1024));
  let text = "";
  for (let index = 0; index < header.length; index += 1) {
    text += String.fromCharCode(header[index]);
  }
  return text.includes("%PDF-");
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}
