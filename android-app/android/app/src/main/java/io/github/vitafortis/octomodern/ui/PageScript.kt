package io.github.vitafortis.octomodern.ui

/**
 * Runs at document start on the server's pages only (WebViewCompat.addDocumentStartJavaScript
 * with the server origin). It talks to the app through `OctoModernNative`, a web message
 * listener registered for that origin alone:
 *
 * - `{ type: 'signedOut' }` when the page signs out (POST /api/auth/logout), so the app
 *   revokes this device's token too;
 * - `{ type: 'download', name, data }` for `blob:` downloads (the WebView can't hand those
 *   to Android's download manager), read into a data URL.
 */
object PageScript {
    const val BRIDGE = "OctoModernNative"

    val SOURCE = """
(function () {
  if (window.__octoModernApp) return;
  window.__octoModernApp = true;
  var post = function (m) { try { window.$BRIDGE.postMessage(JSON.stringify(m)); } catch (e) {} };
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' && new URL(url, location.href).pathname === '/api/auth/logout') post({ type: 'signedOut' });
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };
  function saveBlob(href, name) {
    origFetch(href).then(function (r) { return r.blob(); }).then(function (b) {
      var fr = new FileReader();
      fr.onload = function () { post({ type: 'download', name: name || 'download', data: fr.result }); };
      fr.readAsDataURL(b);
    });
  }
  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href && this.href.indexOf('blob:') === 0) { saveBlob(this.href, this.getAttribute('download')); return; }
    return origClick.apply(this, arguments);
  };
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="blob:"]') : null;
    if (a) { e.preventDefault(); saveBlob(a.href, a.getAttribute('download')); }
  }, true);
})();
""".trimIndent()
}
