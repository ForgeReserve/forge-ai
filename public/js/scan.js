/* Camera scanning, adapted from the cashucard.org/fund donations kit (scan.js). Reads the eCash QR
   code a wallet shows and hands back the token string:
   - a static cashuA/cashuB code (with or without the "cashu:" prefix),
   - a NUT-16 animated code: ur:bytes parts with fountain codes, decoded by vendor/bcur.js,
   - a Forge balance key (sk-forge-...), so a key saved as a QR code can be loaded too,
   - with opts.accept, any code accept(text) takes: the v2 app's eCash box passes its Fedimint notes
     reader (public/v2/core/fedinote.js), so a still code of Fedimint notes is read too.
   The kit's animated Fedimint (qrloop) path is left out.
   jsQR (Apache-2.0) decodes camera frames where the browser has no BarcodeDetector.
   Loaded on demand; exposes window.ForgeScan. */
(function () {
  "use strict";
  var VENDOR = "/vendor/";

  function loadScript(name) {
    return new Promise(function (resolve, reject) {
      if (name === "jsqr.js" && window.jsQR) return resolve();
      if (name === "bcur.js" && window.BCUR) return resolve();
      var s = document.createElement("script");
      s.src = VENDOR + name;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load the scanner.")); };
      document.head.appendChild(s);
    });
  }

  /* Feeds scanned texts; result() once done() is true. any: every code counts, for a caller that reads
     the text itself (an invite code, an event link, a till's pairing code). */
  function Assembler(any, accept) { this.kind = null; this.inner = null; this.value = null; this.any = !!any; this.accept = typeof accept === "function" ? accept : null; }
  Assembler.prototype.add = function (raw) {
    var text = String(raw || "").trim();
    if (!text) return;
    var plain = text.replace(/^cashu:(?=cashu)/i, "");
    if (/^cashu[AB][A-Za-z0-9+/_=-]{20,}$/.test(plain)) { this.kind = "cashu"; this.value = plain; return; }
    if (/^sk-forge-[A-Za-z0-9_-]{24,64}$/.test(text)) { this.kind = "key"; this.value = text; return; }
    if (this.accept && this.accept(text)) { this.kind = "accepted"; this.value = text; return; }
    if (/^ur:/i.test(text)) {
      if (!window.BCUR) throw new Error("ur decoder not loaded");
      if (this.kind !== "ur") { this.kind = "ur"; this.inner = window.BCUR.decoder(); }
      this.inner.add(text);
    } else if (this.any) {
      this.kind = "text"; this.value = text;
    }
  };
  Assembler.prototype.progress = function () { return this.value ? 1 : this.inner ? this.inner.progress() : 0; };
  Assembler.prototype.done = function () { return !!this.value || !!(this.inner && this.inner.done()); };
  Assembler.prototype.result = function () { return this.value || this.inner.result(); };

  /* Camera loop: open the rear camera into `video`, decode frames, call onProgress(0..1), and
     resolve with the scanned string. Returns {promise, stop}. */
  function scan(video, onProgress, opts) {
    var stopped = false, stream = null, asm = new Assembler(opts && opts.any, opts && opts.accept), last = "", raf = 0;
    var canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    var detector = null;
    var promise = new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        reject(new Error("This browser cannot use the camera here. Paste the code instead."));
        return;
      }
      var ready = ("BarcodeDetector" in window)
        ? window.BarcodeDetector.getSupportedFormats().then(function (f) {
            if (f.indexOf("qr_code") >= 0) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
            return detector ? null : loadScript("jsqr.js");
          }).catch(function () { return loadScript("jsqr.js"); })
        : loadScript("jsqr.js");
      Promise.all([ready, navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })])
        .then(function (r) {
          stream = r[1];
          if (stopped) { stop(); return; }
          video.srcObject = stream;
          video.setAttribute("playsinline", "");
          video.muted = true;
          return video.play().then(tick);
        })
        .catch(function (e) {
          stop();
          reject(new Error(e && e.name === "NotAllowedError"
            ? "Camera access was refused. Allow the camera for this site, or paste the code instead."
            : (e && e.message) || "The camera did not start."));
        });

      var busy = false, lastAt = 0;
      function tick(ts) {
        if (stopped) return;
        raf = requestAnimationFrame(tick);
        if (busy || (ts && ts - lastAt < 60) || video.readyState < 2) return;
        lastAt = ts || 0;
        busy = true;
        decode().then(function (text) {
          busy = false;
          if (!text || text === last) return;
          last = text;
          var needUR = /^ur:/i.test(text) && !window.BCUR;
          (needUR ? loadScript("bcur.js") : Promise.resolve()).then(function () {
            try { asm.add(text); } catch (e) { return; }
            if (onProgress) onProgress(asm.progress());
            if (asm.done()) {
              var out;
              try { out = asm.result(); } catch (e) { stop(); reject(new Error("The code was read but could not be put back together. Try again.")); return; }
              stop();
              resolve(out);
            }
          });
        }, function () { busy = false; });
      }
      function decode() {
        if (detector) {
          return detector.detect(video).then(function (codes) { return codes.length ? codes[0].rawValue : ""; });
        }
        var w = video.videoWidth, h = video.videoHeight, scale = Math.min(1, 720 / Math.max(w, h));
        canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        return Promise.resolve(code ? code.data : "");
      }
    });
    function stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      try { video.srcObject = null; } catch (e) { /* ignore */ }
    }
    return { promise: promise, stop: stop };
  }

  window.ForgeScan = { scan: scan, Assembler: Assembler };
})();
