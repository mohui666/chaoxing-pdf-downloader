(function installChaoxingPdfBridge() {
  if (window.__cxpdlBridgeInstalled) {
    return;
  }
  window.__cxpdlBridgeInstalled = true;

  const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
  const INTERESTING_TEXT = /(download|filename|fileName|pdf|cldisk|objectid|\.pdf)/i;
  const INTERESTING_URL = /(default_config|download|pdf|cldisk|ananas|studentstudy|courselist|course|read|flag=normal|\/[0-9a-f]{32}(?:[?#]|$))/i;

  const nativeJsonParse = JSON.parse;
  JSON.parse = function wrappedJsonParse(text, reviver) {
    const parsed = nativeJsonParse.apply(this, arguments);
    try {
      if (typeof text === "string" && text.length <= MAX_TEXT_LENGTH && INTERESTING_TEXT.test(text)) {
        postPayload(location.href, parsed);
      }
    } catch (_error) {
      // Keep JSON.parse behavior unchanged for the page.
    }
    return parsed;
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function wrappedFetch() {
      const args = arguments;
      return nativeFetch.apply(this, args).then((response) => {
        inspectFetchResponse(response, args[0]);
        return response;
      });
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function wrappedOpen(method, url) {
    try {
      this.__cxpdlUrl = new URL(url, location.href).href;
    } catch (_error) {
      this.__cxpdlUrl = String(url || "");
    }
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function wrappedSend() {
    this.addEventListener("load", function onLoad() {
      const responseType = this.responseType || "text";
      if (responseType !== "text" && responseType !== "json" && responseType !== "") {
        return;
      }

      let text = "";
      if (responseType === "json") {
        postPayload(this.__cxpdlUrl || this.responseURL, this.response);
        return;
      }

      try {
        text = this.responseText || "";
      } catch (_error) {
        return;
      }

      inspectText(this.__cxpdlUrl || this.responseURL, text);
    });

    return nativeSend.apply(this, arguments);
  };

  function inspectFetchResponse(response, requestInfo) {
    const url = response.url || requestUrl(requestInfo);
    const contentType = response.headers && response.headers.get
      ? response.headers.get("content-type") || ""
      : "";

    if (!INTERESTING_URL.test(url) && !/json|text|javascript/i.test(contentType)) {
      return;
    }

    response.clone().text()
      .then((text) => inspectText(url, text))
      .catch(() => {});
  }

  function inspectText(url, text) {
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return;
    }

    if (!INTERESTING_URL.test(url || "") && !INTERESTING_TEXT.test(text)) {
      return;
    }

    postPayload(url, parseText(text));
  }

  function postPayload(url, payload) {
    if (!payload) {
      return;
    }

    window.postMessage({
      source: "CXPDL_PAGE_BRIDGE",
      type: "network-response",
      url,
      payload
    }, "*");
  }

  function parseText(text) {
    const trimmed = text.trim();
    const parsed = tryParseJson(trimmed);
    if (parsed) {
      return parsed;
    }

    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonpParsed = tryParseJson(trimmed.slice(jsonStart, jsonEnd + 1));
      if (jsonpParsed) {
        return jsonpParsed;
      }
    }

    return {
      __text: trimmed.slice(0, 200000)
    };
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function requestUrl(requestInfo) {
    if (!requestInfo) {
      return "";
    }
    if (typeof requestInfo === "string") {
      return requestInfo;
    }
    if (requestInfo.url) {
      return requestInfo.url;
    }
    return String(requestInfo);
  }
})();
