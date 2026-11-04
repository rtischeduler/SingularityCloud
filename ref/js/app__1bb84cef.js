import { WebSocketClient } from "./websocket.js";
import { MediasoupTransport } from "./mediasoup-transport.js";
import { WebRTCClient } from "./webrtc.js";
import { H264Decoder } from "./decoder.js";
import { InputCapture } from "./input.js";

class App {
  constructor() {
    /** @type {WebSocketClient|null} */
    this.ws = null;
    /** @type {MediasoupTransport|null} */
    this.transport = null;
    /** @type {WebRTCClient|null} */
    this.webrtc = null;
    /** @type {H264Decoder|null} */
    this.decoder = null;
    /** @type {InputCapture|null} */
    this.input = null;
    /** @type {HTMLVideoElement|null} */
    this.videoEl = null;
    /** @type {"phone"|"pc"|null} */
    this._deviceType = null;
    /** @type {"webrtc"|"mediasoup"|null} */
    this._transportMode = null;
    this._statusTimer = null;

    this.init();
  }

  init() {
    const params = new URLSearchParams(location.search);
    const autostart = params.get("autostart") === "true";

    if (autostart) {
      // Hide game list immediately so it never flashes on screen
      document.getElementById("screen-select").classList.remove("active");
      document.getElementById("screen-queue").classList.add("active");
    } else {
      this.refreshStatus();

      // Poll status every 8s while on select screen
      this._statusTimer = setInterval(() => {
        if (this.currentScreen() === "screen-select") this.refreshStatus();
      }, 8000);
    }

    // Play button
    document.getElementById("play-roblox").addEventListener("click", () => {
      this.selectGame("roblox");
    });

    document.getElementById("btn-leave-queue").addEventListener("click", () => {
      this.leaveQueue();
    });

    document.getElementById("btn-unblock").addEventListener("click", () => {
      this.unblock();
    });

    // Clean up WebSocket when page/iframe unloads (prevents phone stuck in-use)
    window.addEventListener("beforeunload", () => {
      this.ws?.close();
    });

    // Auto-start: begin game flow immediately
    if (autostart) {
      this.selectGame("roblox");
    }
  }

  async refreshStatus() {
    try {
      const res = await fetch("/status");
      const s = await res.json();

      document.getElementById("pill-text").textContent =
        `${s.available}/${s.total} slots free`;
      document.getElementById("phones-free").textContent = s.available;
      document.getElementById("phones-total").textContent = s.total;
    } catch {
      document.getElementById("pill-text").textContent = "Offline";
    }
  }

  /* ---- Flow ---- */
  selectGame(gameId) {
    this._t0 = performance.now();
    this._tlog = (msg) => console.log(`[App][${Math.round(performance.now() - this._t0)}ms] ${msg}`);

    // Intercept ALL console.log calls to prepend elapsed time
    if (!this._origConsoleLog) {
      this._origConsoleLog = console.log.bind(console);
      console.log = (...args) => {
        const ms = Math.round(performance.now() - this._t0);
        this._origConsoleLog(`[+${ms}ms]`, ...args);
      };
    }

    this._tlog("Play clicked");

    this.showScreen("screen-queue");

    // Start video watchdog (detects black screen / stale frames)
    this._startVideoWatchdog();

    this.ws = new WebSocketClient();

    this.ws.onQueueStatus = (position, total) => {
      document.getElementById("queue-position").textContent = position;
      document.getElementById("queue-total").textContent =
        total > 1 ? `${total} people in queue` : "You're next!";
    };

    this.ws.onQueueReady = () => {
      this._tlog("Queue ready — starting game");
      this.startGame();
    };

    // ---- mediasoup signaling (used when server is in PC/Windows mode) ----
    this.ws.onRouterRtpCapabilities = async (caps) => {
      this._tlog("Router RTP capabilities received — using mediasoup transport");
      this._transportMode = "mediasoup";
      await this.transport?.loadDevice(caps);
    };

    this.ws.onRecvTransportCreated = async (options) => {
      this._tlog("Recv transport created");
      await this.transport?.createRecvTransport(options);
    };

    this.ws.onConsumeResponse = async (params) => {
      this._tlog("Consume response received");
      await this.transport?.consume(params);
    };

    // ---- WebRTC signaling (used when server is in phone mode) ----
    this.ws.onOffer = async (sdp) => {
      this._tlog("WebRTC offer received — using WebRTC transport");
      this._transportMode = "webrtc";
      if (!this.webrtc) return;
      const answerSdp = await this.webrtc.handleOffer(sdp);
      this.ws.sendAnswer(answerSdp);
    };

    this.ws.onIceCandidate = async (candidate) => {
      await this.webrtc?.addIceCandidate(candidate);
    };

    this.ws.onError = (message) => {
      alert(`Error: ${message}`);
      this.resetToSelect();
    };

    this.ws.onSessionEnd = (reason) => {
      alert(`Session ended: ${reason}`);
      this.resetToSelect();
    };

    this.ws.onKeyboardState = (visible) => {
      this.input?.setTypeMode(visible);
    };

    this.ws.onSessionProgress = (message) => {
      this._tlog(`[Server] ${message}`);
      // Show progress on the loading overlay so user knows what's happening
      const ov = document.getElementById("game-overlay");
      if (ov) {
        const p = ov.querySelector("p");
        // Strip timestamp prefixes like "[4150ms] " or "[restart][1200ms] "
        if (p) p.textContent = message.replace(/^(\[[\w]*\])*\s*(\[\d+ms\]\s*)?/, "");
      }
    };

    this.ws.onGameReady = (deviceType) => {
      this._deviceType = deviceType;
      this._tlog(`Game ready (device=${deviceType}, transport=${this._transportMode}) — waiting for video`);

      // In direct WebRTC mode, video may already be flowing before game-ready arrives.
      // Check if frames were already decoded and hide overlay immediately.
      if (this._lastFrameTime > 0) {
        this._tlog("Video already playing — hiding overlay immediately");
        const ov = document.getElementById("game-overlay");
        if (ov) ov.classList.add("hidden");
      } else {
        this._hideOverlayOnFirstFrame = true;
      }

      // ---- Phone mode: overlay hidden on first decoded frame via decoder.onFirstFrame ----
      // ---- PC mode: poll for <video> playback ----
      if (this._transportMode === "mediasoup") {
        const overlayCheck = setInterval(() => {
          if (!this._hideOverlayOnFirstFrame) { clearInterval(overlayCheck); return; }
          if (this.videoEl && !this.videoEl.paused && this.videoEl.currentTime > 0) {
            this._hideOverlayOnFirstFrame = false;
            clearInterval(overlayCheck);
            this._tlog("Video playing — hiding overlay");
            const ov = document.getElementById("game-overlay");
            if (ov) ov.classList.add("hidden");
          }
        }, 500);

        // Fallback: hide after 30s
        setTimeout(() => {
          clearInterval(overlayCheck);
          if (this._hideOverlayOnFirstFrame) {
            this._hideOverlayOnFirstFrame = false;
            this._tlog("No video after 30s — hiding overlay anyway");
            const ov = document.getElementById("game-overlay");
            if (ov) ov.classList.add("hidden");
          }
        }, 30000);
      } else {
        // WebRTC/phone mode: decoder.onFirstFrame handles overlay hiding
        // Fallback: hide after 30s
        setTimeout(() => {
          if (this._hideOverlayOnFirstFrame) {
            this._hideOverlayOnFirstFrame = false;
            this._tlog("No video after 30s — hiding overlay anyway");
            const ov = document.getElementById("game-overlay");
            if (ov) ov.classList.add("hidden");
          }
        }, 30000);
      }

      // Set up input capture now that we know the device type
      const inputTarget = this._transportMode === "mediasoup" ? this.videoEl : this.canvas;
      if (inputTarget && !this.input) {
        if (deviceType === "pc") {
          // PC mode: direct mouse/keyboard, no joystick/calibration
          this.input = new InputCapture(inputTarget, null, { pcMode: true });
          this._tlog("Input: PC mode (direct mouse + keyboard)");
        } else {
          // Phone mode: joystick, button calibration, Android keycodes
          const keymap = {
            joystick: { x: 0.13, y: 0.75, radius: 0.07 },
            buttons: { Space: { x: 0.898, y: 0.866, label: "Jump" } },
          };
          this.input = new InputCapture(inputTarget, keymap);
          this._tlog("Input: Phone mode (joystick + touch)");
        }

        // Route input based on transport mode:
        // Phone (WebRTC): send via DataChannel for low latency
        // PC (mediasoup): send via WebSocket (no DataChannel available)
        if (this._transportMode === "webrtc") {
          this.input.onInput = (msg) => this.webrtc?.sendInput(msg);
        } else {
          this.input.onInput = (msg) => this.ws?.sendInput(msg);
        }
      }

      (inputTarget || this.videoEl)?.focus();
      this._showUnblockButton();
      this._isUnblocking = false;

      // Request keyframe
      if (this._transportMode === "webrtc") {
        this.webrtc?.sendInput({ type: "reset-video" });
      } else {
        this.ws?.sendInput({ type: "reset-video" });
      }
      this._tlog("Keyframe requested on game-ready");
      this._gameReadyAt = Date.now();
    };

    this.ws.onClose = () => {
      if (this.currentScreen() === "screen-game") this.resetToSelect();
    };

    this.ws.connect();

    const wait = setInterval(() => {
      if (!this.ws) { clearInterval(wait); return; }
      if (this.ws.connected) {
        clearInterval(wait);
        this._tlog("WebSocket connected — joining queue");
        this.ws.joinQueue(gameId);
      }
    }, 100);
  }

  startGame() {
    this.showScreen("screen-game");
    this._gameReadyAt = Date.now();

    // Failsafe: hide overlay after 60s no matter what — prevents user being
    // stuck on a loading screen if something goes wrong server-side
    this._overlayFailsafe = setTimeout(() => {
      const ov = document.getElementById("game-overlay");
      if (ov && !ov.classList.contains("hidden")) {
        this._tlog("Overlay failsafe — hiding after 60s");
        ov.classList.add("hidden");
      }
    }, 60000);

    const viewport = document.querySelector(".game-viewport");

    // ---- Set up BOTH transports; only one will be used based on server signals ----

    // 1) mediasoup transport (for PC/Windows mode)
    this.videoEl = document.createElement("video");
    this.videoEl.id = "game-video";
    this.videoEl.autoplay = true;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.videoEl.disableRemotePlayback = true;
    this.videoEl.style.width = "100%";
    this.videoEl.style.height = "100%";
    this.videoEl.style.objectFit = "contain";
    this.videoEl.style.background = "#000";
    this.videoEl.style.display = "none"; // hidden until mediasoup activates

    // Remove old video element if present
    const oldVideo = document.getElementById("game-video");
    if (oldVideo) oldVideo.remove();
    viewport.appendChild(this.videoEl);

    this.transport = new MediasoupTransport();
    this.transport.sendWs = (msg) => this.ws?.send(msg);

    this.transport.onConnected = () => {
      this._tlog("mediasoup transport connected — waiting for game-ready");
    };

    this.transport.onDisconnected = () => this.resetToSelect();

    this.transport.onVideoTrack = (track) => {
      this._tlog("mediasoup video track received");
      // Show video element, hide canvas
      this.videoEl.style.display = "";
      this.canvas = document.getElementById("game-canvas");
      if (this.canvas) this.canvas.style.display = "none";

      const stream = new MediaStream([track]);
      this.videoEl.srcObject = stream;

      // Monitor video playback for first frame
      this.videoEl.onloadeddata = () => {
        this._tlog("First video frame rendered (mediasoup)");
        this._lastFrameTime = Date.now();
        if (this._hideOverlayOnFirstFrame) {
          this._hideOverlayOnFirstFrame = false;
          const ov = document.getElementById("game-overlay");
          if (ov) ov.classList.add("hidden");
        }
      };

      // Track frames for watchdog
      this.videoEl.ontimeupdate = () => {
        this._lastFrameTime = Date.now();
      };

      // Live-edge catchup: skip to latest frame if buffered ahead
      // This prevents the <video> element from accumulating latency
      this._liveEdgeInterval = setInterval(() => {
        const v = this.videoEl;
        if (!v || v.paused || !v.buffered.length) return;
        const bufferedEnd = v.buffered.end(v.buffered.length - 1);
        const lag = bufferedEnd - v.currentTime;
        if (lag > 0.15) {
          // Skip to live edge (keep 50ms buffer for smooth playback)
          v.currentTime = bufferedEnd - 0.05;
        }
      }, 200);
    };

    // 2) WebRTC transport (for phone mode)
    this.canvas = document.getElementById("game-canvas");
    if (this.canvas) this.canvas.style.display = ""; // show canvas by default

    this.webrtc = new WebRTCClient();
    this.webrtc.init();

    this.webrtc.onIceCandidate = (candidate) => {
      this.ws?.sendIceCandidate(candidate);
    };

    this.webrtc.onConnected = () => {
      this._tlog("WebRTC data channels connected");
    };

    this.webrtc.onDisconnected = () => {
      this._tlog("WebRTC disconnected");
      this.resetToSelect();
    };

    const resetVideoFn = () => {
      if (this._transportMode === "webrtc") {
        this.webrtc?.sendInput({ type: "reset-video" });
      } else {
        this.ws?.sendInput({ type: "reset-video" });
      }
    };

    this.decoder = new H264Decoder(this.canvas, resetVideoFn);

    this.decoder.onFirstFrame = () => {
      this._tlog("First video frame rendered (WebRTC/decoder)");
      this._lastFrameTime = Date.now();
      if (this._hideOverlayOnFirstFrame) {
        this._hideOverlayOnFirstFrame = false;
        const ov = document.getElementById("game-overlay");
        if (ov) ov.classList.add("hidden");
      }
    };

    this.decoder.onVideoSizeChange = (width, height) => {
      this._tlog(`Video size: ${width}x${height}`);
      // Notify server of video dimensions (needed for input coordinate mapping)
      if (this._transportMode === "webrtc") {
        this.webrtc?.sendInput({ type: "video-size", width, height });
      } else {
        this.ws?.sendInput({ type: "video-size", width, height });
      }
    };

    this.webrtc.onVideoData = (data) => {
      this.decoder?.appendData(data);
      this._lastFrameTime = Date.now();
    };

    // Input capture is created after game-ready (we need deviceType to pick phone vs PC mode)
    this.input = null;

    this.ws.sendClientReady();
  }

  leaveQueue() {
    this.ws?.close();
    this.ws = null;
    this.showScreen("screen-select");
    this.refreshStatus();
  }

  unblock() {
    if (!this.ws || this._unblockCooldown) {
      console.log("[App] Unblock: ignored (no ws or cooldown active)");
      return;
    }
    this._tlog("Unblock clicked — requesting game restart");
    this._isUnblocking = true;

    // Show overlay while game restarts
    const overlay = document.getElementById("game-overlay");
    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.querySelector("p").textContent = "Restarting game...";
    }

    // Hide unblock button during restart
    const btn = document.getElementById("btn-unblock");
    if (btn) btn.classList.remove("visible");

    // Soft-reset decoder for phone mode so it re-accepts fresh SPS/PPS + keyframe
    if (this._transportMode === "webrtc" && this.decoder) {
      this.decoder.softReset();
    }

    // Request fresh keyframe from server
    if (this._transportMode === "webrtc") {
      this.webrtc?.sendInput({ type: "reset-video" });
    } else {
      this.ws?.sendInput({ type: "reset-video" });
    }

    // Tell server to restart the game
    this.ws.sendUnblock();

    // Overlay stays visible until server sends game-ready (handled by onGameReady).
    // Progress messages from BYOD app update the overlay text via onSessionProgress.
    // Fallback: hide after 60s if game-ready never arrives.
    setTimeout(() => {
      if (this._isUnblocking) {
        this._isUnblocking = false;
        this._tlog("Unblock timeout — hiding overlay after 60s");
        const ov = document.getElementById("game-overlay");
        if (ov) ov.classList.add("hidden");
        this._showUnblockButton();
      }
    }, 60000);

    // 150-second cooldown to prevent spam
    this._unblockCooldown = true;
    this._unblockCooldownEnd = Date.now() + 150000;
    this._unblockCooldownTimer = setTimeout(() => {
      this._unblockCooldown = false;
      console.log("[App] Unblock cooldown expired");
      this._showUnblockButton();
    }, 150000);
  }

  _showUnblockButton() {
    const btn = document.getElementById("btn-unblock");
    if (!btn) return;

    // Clear any existing countdown interval
    if (this._unblockCountdownInterval) {
      clearInterval(this._unblockCountdownInterval);
      this._unblockCountdownInterval = null;
    }

    const textEl = btn.querySelector(".btn-unblock-text");

    if (this._unblockCooldown && this._unblockCooldownEnd) {
      // Show button in disabled state with countdown
      btn.classList.add("visible");
      btn.disabled = true;

      const updateCountdown = () => {
        const remaining = Math.max(0, Math.ceil((this._unblockCooldownEnd - Date.now()) / 1000));
        if (textEl) textEl.textContent = `Unblock (${remaining}s)`;
        if (remaining <= 0) {
          clearInterval(this._unblockCountdownInterval);
          this._unblockCountdownInterval = null;
          if (textEl) textEl.textContent = "Unblock";
          btn.disabled = false;
        }
      };
      updateCountdown();
      this._unblockCountdownInterval = setInterval(updateCountdown, 1000);
    } else {
      // Normal enabled state
      btn.classList.add("visible");
      btn.disabled = false;
      if (textEl) textEl.textContent = "Unblock";
    }
  }

  _hideUnblockButton() {
    const btn = document.getElementById("btn-unblock");
    if (btn) {
      btn.classList.remove("visible");
      btn.disabled = false;
    }
    if (this._unblockCountdownInterval) {
      clearInterval(this._unblockCountdownInterval);
      this._unblockCountdownInterval = null;
    }
  }

  resetToSelect() {
    this._stopVideoWatchdog();
    this._gameReadyAt = null;
    this._isUnblocking = false;
    this._transportMode = null;
    this._deviceType = null;

    // Clean up mediasoup
    this.transport?.close();
    this.transport = null;
    if (this._liveEdgeInterval) {
      clearInterval(this._liveEdgeInterval);
      this._liveEdgeInterval = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.remove();
      this.videoEl = null;
    }

    // Clean up WebRTC + decoder
    this.webrtc?.close();
    this.webrtc = null;
    if (this.decoder) {
      this.decoder.reset();
      this.decoder = null;
    }

    // Show canvas again (hidden during mediasoup mode)
    const canvas = document.getElementById("game-canvas");
    if (canvas) canvas.style.display = "";

    this.ws?.close();
    this.ws = null;
    this.input?.destroy();
    this.input = null;

    // Clear overlay failsafe
    if (this._overlayFailsafe) {
      clearTimeout(this._overlayFailsafe);
      this._overlayFailsafe = null;
    }

    // Reset overlay text and show it
    const overlay = document.getElementById("game-overlay");
    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.querySelector("p").textContent = "Connecting...";
    }

    // Hide unblock button and clear cooldown
    this._hideUnblockButton();
    if (this._unblockCooldownTimer) {
      clearTimeout(this._unblockCooldownTimer);
      this._unblockCooldownTimer = null;
    }
    this._unblockCooldown = false;

    this.showScreen("screen-select");
    this.refreshStatus();
  }

  /* ---- Video watchdog ---- */

  /**
   * Watchdog that monitors decoded frame output.
   * If we're on the game screen and no frame renders for 3+ seconds,
   * it requests a fresh keyframe.
   * This catches intermittent black-screen issues that are hard to reproduce.
   */
  _startVideoWatchdog() {
    this._stopVideoWatchdog();
    this._videoWatchdogResetCount = 0;

    this._lastFrameTime = 0;
    this._videoWatchdog = setInterval(() => {
      if (this.currentScreen() !== "screen-game") return;

      // Need at least one transport active
      const hasTransport = this._transportMode === "webrtc"
        ? !!this.webrtc
        : !!this.transport;
      if (!hasTransport && !this.webrtc && !this.transport) return;

      // For phone mode, also check decoder.lastFrameTime (more accurate)
      const lastFrame = this._transportMode === "webrtc" && this.decoder
        ? this.decoder.lastFrameTime || this._lastFrameTime
        : this._lastFrameTime;

      if (lastFrame === 0) {
        if (!this._gameReadyAt) return;
        const waitingMs = Date.now() - this._gameReadyAt;
        if (waitingMs >= 8000) {
          this._videoWatchdogResetCount++;
          console.warn(`[Watchdog] No video after ${(waitingMs / 1000).toFixed(1)}s — requesting keyframe (attempt #${this._videoWatchdogResetCount})`);
          if (this._transportMode === "webrtc") {
            this.webrtc?.sendInput({ type: "reset-video" });
          } else {
            this.ws?.sendInput({ type: "reset-video" });
          }
          this._gameReadyAt = Date.now();
        }
        return;
      }

      const staleMs = Date.now() - lastFrame;
      if (staleMs >= 5000) {
        // Rate-limit: only send one reset per 15s to avoid disrupting the encoder
        const now = Date.now();
        const sinceLastReset = now - (this._lastResetTime || 0);
        if (sinceLastReset >= 15000) {
          this._videoWatchdogResetCount++;
          console.warn(`[Watchdog] No frame for ${(staleMs / 1000).toFixed(1)}s — requesting keyframe (attempt #${this._videoWatchdogResetCount})`);
          if (this._transportMode === "webrtc") {
            this.webrtc?.sendInput({ type: "reset-video" });
          } else {
            this.ws?.sendInput({ type: "reset-video" });
          }
          this._lastResetTime = now;
        }
      }
    }, 3000);
  }

  _stopVideoWatchdog() {
    if (this._videoWatchdog) {
      clearInterval(this._videoWatchdog);
      this._videoWatchdog = null;
    }
  }

  /* ---- Helpers ---- */
  showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
  }

  currentScreen() {
    const el = document.querySelector(".screen.active");
    return el ? el.id : null;
  }
}

new App();
