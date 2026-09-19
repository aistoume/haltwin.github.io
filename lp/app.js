/* LP 页面只请求账户、签纯文本、查询后端;绝不调用交易或授权方法。 */
(function () {
  "use strict";
  const API = "https://api.sterlingai.net";
  const POOL = "0xec879367c3a1c1ae721079e65dfbc4972ccf16ab";
  const $ = id => document.getElementById(id);
  let eth, account = null, epoch = 0, query = 0, connection = 0;
  let connecting = false, signing = false, loading = false, enrolled = false;
  const fields = ["ptsTotal", "ptsLp", "ptsShare", "ptsToday", "ptsSince", "ptsSnap"];

  function address(value) {
    return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
  }
  function firstAccount(accounts) {
    return Array.isArray(accounts) ? address(accounts[0]) : null;
  }
  function message(id, text = "", kind = "") {
    $(id).textContent = text;
    $(id).className = "msg" + (kind ? " " + kind : "");
  }
  function controls() {
    $("wbtn").disabled = $("connectBtn").disabled = connecting;
    $("signBtn").disabled = !account || signing || enrolled;
    $("refreshBtn").disabled = !account || loading;
    $("s2").classList.toggle("off", !account);
    $("s3").classList.toggle("off", !account);
  }
  function clearPoints() {
    $("mine").classList.remove("show");
    fields.forEach(id => { $(id).textContent = "—"; });
  }
  function setAccount(value) {
    // 账户代次隔离所有异步结果,防 A 的签名/积分在切换到 B 后继续显示。
    account = address(value);
    epoch++; query++;
    signing = loading = enrolled = false;
    clearPoints();
    message("s2msg"); message("s3msg");
    $("addrOut").textContent = account || "";
    $("wbtn").textContent = account ? account.slice(0, 6) + "…" + account.slice(-4) : "Connect Wallet";
    $("wbtn").classList.toggle("on", !!account);
    message("s1msg", account ? "Connected." : "Wallet disconnected.", account ? "ok" : "");
    controls();
    if (account) void refresh();
  }
  function provider() {
    if (eth) return eth;
    eth = window.ethereum || window.okxwallet;
    if (!eth || typeof eth.request !== "function") {
      eth = null;
      throw new Error("No EVM wallet found. Open in OKX Wallet or install an EVM wallet.");
    }
    if (eth.on) {
      eth.on("accountsChanged", accounts => {
        connection++; connecting = false;
        setAccount(firstAccount(accounts));
      });
      eth.on("disconnect", () => {
        connection++; connecting = false;
        setAccount(null);
      });
    }
    return eth;
  }
  async function connect() {
    if (connecting) return;
    const request = ++connection;
    connecting = true; controls();
    try {
      const accounts = await provider().request({ method: "eth_requestAccounts" });
      if (request === connection) setAccount(firstAccount(accounts));
    } catch (error) {
      if (request === connection) message("s1msg", error.code === 4001 ? "Connection rejected. You can retry." : error.message, "err");
    } finally {
      if (request === connection) { connecting = false; controls(); }
    }
  }
  async function requestJSON(path, options = {}) {
    // 计时器覆盖响应体解析,避免收到 headers 后正文挂起导致按钮永久锁住。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(API + path, { ...options, signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        if (response.status === 503) throw new Error("Service temporarily unavailable. Please retry.");
        if (response.status === 400) throw new Error("Request rejected. Reconnect and sign a new message if enrolling.");
        throw new Error("Service error (" + response.status + "). Please retry.");
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Request timed out. Please retry.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  function buildMessage(owner, nonce, issued) {
    // 必须与 backend/verify.py 的整文模板一致,不接受其他站点/池子的签名。
    return [
      "Sterling LP Rewards — enrollment", "",
      "I control this wallet and am providing liquidity to the STERLING/wNVDAx pool",
      "on Uniswap V2 (X Layer). This signature enrolls me to earn STERLING points by",
      "my hourly LP share. It authorizes no transaction, transfer, or token approval.", "",
      "Domain: sterlingai.net", "Chain ID: 196", "Address: " + owner,
      "Pool: " + POOL, "Nonce: " + nonce, "Issued: " + issued,
    ].join("\n");
  }
  async function sameWallet(owner, version) {
    const current = firstAccount(await eth.request({ method: "eth_accounts" }));
    if (version !== epoch) return false;
    if (current !== owner) { setAccount(current); return false; }
    return true;
  }
  async function enroll() {
    if (!account || signing || enrolled) return;
    const owner = account, version = epoch;
    signing = true; controls();
    message("s2msg", "Sign the message in your wallet.");
    try {
      if (!window.crypto || !window.crypto.getRandomValues) throw new Error("Secure randomness unavailable. Use an HTTPS page.");
      if (!await sameWallet(owner, version)) return;
      const nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
      const text = buildMessage(owner, nonce, new Date().toISOString());
      // personal_sign 使用 UTF-8 hex,兼容 OKX/MetaMask;不是 eth_sign 或交易签名。
      const hex = "0x" + Array.from(new TextEncoder().encode(text), n => n.toString(16).padStart(2, "0")).join("");
      const signature = await eth.request({ method: "personal_sign", params: [hex, owner] });
      if (!await sameWallet(owner, version)) return;
      message("s2msg", "Submitting…");
      const result = await requestJSON("/lp/enroll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: owner, message: text, signature, nonce }),
      });
      if (version !== epoch) return;
      if (!result || result.ok !== true || address(result.enrolled) !== owner) throw new Error("Invalid enrollment response.");
      enrolled = true;
      message("s2msg", "Enrolled. Points show after the next hourly settlement.", "ok");
      await refresh();
    } catch (error) {
      if (version === epoch) message("s2msg", error.code === 4001 ? "Signature rejected. You can retry." : "Enroll failed: " + error.message, "err");
    } finally {
      if (version === epoch) { signing = false; controls(); }
    }
  }
  function number(value) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) throw new Error("Invalid numeric response.");
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0) throw new Error("Invalid numeric response.");
    return result;
  }
  function lpBalance(value) {
    // LP 为 18 位最小单位,不经 Number 转换以免大整数丢精度。
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid LP balance.");
    const raw = BigInt(value).toString().padStart(19, "0");
    const whole = BigInt(raw.slice(0, -18)).toLocaleString("en-US");
    const fraction = raw.slice(-18).replace(/0+$/, "");
    return whole + (fraction ? "." + fraction : "");
  }
  function validatePoints(data, owner) {
    if (!data || address(data.address) !== owner || typeof data.enrolled !== "boolean") throw new Error("Invalid points response.");
    if (!data.enrolled) return null;
    const total = number(data.points), today = number(data.points_today);
    const since = Date.parse(data.enrolled_at), snap = data.last_settled_at === null ? null : Date.parse(data.last_settled_at);
    if (!Number.isFinite(since) || (snap !== null && !Number.isFinite(snap))) throw new Error("Invalid settlement date.");
    const share = data.share_pct === null ? null : number(data.share_pct);
    if (share !== null && share > 100) throw new Error("Invalid LP share.");
    const lp = data.lp_balance === null ? "—" : lpBalance(data.lp_balance);
    return { total, today, since, snap, share, lp };
  }
  async function refresh() {
    if (!account) return;
    const owner = account, version = epoch, request = ++query;
    loading = true; controls(); clearPoints();
    message("s3msg", "Loading…");
    try {
      const data = await requestJSON("/lp/points?address=" + encodeURIComponent(owner));
      if (version !== epoch || request !== query) return;
      const points = validatePoints(data, owner);
      enrolled = !!points;
      if (!points) { message("s3msg", "This wallet is not enrolled. Sign above."); return; }
      if (!signing) message("s2msg", "Already enrolled.", "ok");
      const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      $("ptsTotal").textContent = fmt(points.total);
      $("ptsToday").textContent = fmt(points.today);
      $("ptsLp").textContent = points.lp;
      $("ptsShare").textContent = points.share === null ? "—" : points.share.toFixed(2) + "%";
      $("ptsSince").textContent = new Date(points.since).toLocaleString();
      $("ptsSnap").textContent = points.snap === null ? "Pending" : new Date(points.snap).toLocaleString();
      $("mine").classList.add("show");
      message("s3msg", points.snap === null ? "Enrolled. First settlement pending." : "Figures are from the last settlement, not your live balance.");
    } catch (error) {
      if (version === epoch && request === query) { clearPoints(); message("s3msg", "Could not load points. " + error.message, "err"); }
    } finally {
      if (version === epoch && request === query) { loading = false; controls(); }
    }
  }
  $("wbtn").addEventListener("click", connect);
  $("connectBtn").addEventListener("click", connect);
  $("signBtn").addEventListener("click", enroll);
  $("refreshBtn").addEventListener("click", refresh);
  $("poolTag").textContent = POOL;
  controls();
})();
