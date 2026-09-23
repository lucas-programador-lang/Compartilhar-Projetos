/* =========================================================
   COMPARTILHAR PROJETOS — SCRIPT.JS (v15 - Chat Moderno)
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDB, onDBChange, updateUserProfile, addProject, updateProject, addPost, addComment, addReply, addWithdrawalRequest, markNotificationRead, enviarNotificacaoPush, addPlatformReview,
  enviarMensagemSuporte, escutarChatUsuario, marcarChatLidoUser, escutarPresencaAdmin
} from "./db-sync.js";
import { uid, nowISO } from "./seed.js";

(function () {
  "use strict";

  const WORKER_URL = "https://api.compartilhar-projetos.com.br";

  const PLANS = { pTeste: { id: "pTeste", name: "Plano Teste", price: 5, days: 2 }, p4: { id: "p4", name: "Plano 4 Dias", price: 10, days: 4 }, p7: { id: "p7", name: "Plano 7 Dias", price: 20, days: 7 }, pMensal: { id: "pMensal", name: "Plano Mensal", price: 50, days: 30 } };
  const COMMISSION_RATE = 0.3;
  const MIN_WITHDRAW = 10;

  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;

  function currentUser() {
    if (!firebaseUser || !db || !db.myProfile) return null;
    return db.myProfile.id === firebaseUser.uid ? db.myProfile : null;
  }
  
  function logoutUser() { return signOut(auth); }
  function isSubscriptionActive(user) { return !!(user && user.subscription && user.subscription.active && new Date(user.subscription.expiresAt) > new Date()); }
  function canPublish(user) { return user && (user.role === "admin" || isSubscriptionActive(user)); }

  function escapeHtml(str) { return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function fmtDate(iso) { return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }); }
  function fmtDateTime(iso) { const d = new Date(iso); return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }

  function timeAgo(isoString) {
    const seconds = Math.round((new Date() - new Date(isoString)) / 1000); const minutes = Math.round(seconds / 60); const hours = Math.round(minutes / 60); const days = Math.round(hours / 24);
    if (seconds < 60) return "Agora mesmo"; if (minutes < 60) return `Há ${minutes} min`; if (hours < 24) return `Há ${hours} h`; if (days === 1) return "Ontem"; if (days < 7) return `Há ${days} dias`;
    return fmtDate(isoString);
  }

  function fmtBRL(v) { return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function initials(name) { return (name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(""); }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack"); if (!stack) return;
    const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div"); el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
    stack.appendChild(el); setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 220); }, 3600);
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function categoryName(id) { const c = db.categories.find((c) => c.id === id); return c ? c.name : "Geral"; }
  function userById(id) { return (db.publicProfiles || []).find((u) => u.id === id); }
  function getStarSvg(size, isFull) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${isFull ? '#facc15' : 'none'}" stroke="${isFull ? '#facc15' : '#475569'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block; flex-shrink:0;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`; }
  function fileToDataURL(file) { return new Promise((res, rej) => { const reader = new FileReader(); reader.onload = () => res(reader.result); reader.onerror = rej; reader.readAsDataURL(file); }); }
  function sanitizeText(str) { return escapeHtml(str).slice(0, 5000); }
  const LINK_PATTERN = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\s*[(\[]?\s*\.\s*[)\]]?\s*(com|net|org|br|io|me|co|app|dev|xyz|info|shop|site|online|link|click)\b/i;
  function containsLink(str) { return LINK_PATTERN.test(str || ""); }
  function friendlyError(err, fallbackMsg) { const raw = (err && err.message) || String(err || ""); if (/permission_denied/i.test(raw) || /PERMISSION_DENIED/.test(raw)) return fallbackMsg || "Erro de permissão."; return raw || fallbackMsg; }

  const PROHIBITED_TERMS = [ "cassino", "casino", "aposta", "apostas", "bet365", "betano", "roleta", "blaze", "jogo do tigrinho", "sportsbook", "bookmaker" ];
  function normalizeForMatch(str) { return (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  function findProhibitedTerm(text) { const normalized = normalizeForMatch(text); return PROHIBITED_TERMS.find((term) => normalized.includes(normalizeForMatch(term))) || null; }
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function isPlausibleContact(contact) { const trimmed = (contact || "").trim(); if (EMAIL_PATTERN.test(trimmed)) return true; const digits = onlyDigits(trimmed); if (digits.length === 10 || digits.length === 11) return true; if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return true; return false; }
  function moderateProject(data) {
    if (findProhibitedTerm(data.title) || findProhibitedTerm(data.description)) return { status: "rejected", rejectReason: "categoria" };
    if (!isPlausibleContact(data.contact)) return { status: "rejected", rejectReason: "contato" }; return { status: "pending", rejectReason: null };
  }

  function onlyDigits(str) { return (str || "").replace(/\D/g, ""); }
  function isValidDocument(str) { const digits = onlyDigits(str); return digits.length === 11 || digits.length === 14; }

  function availableCommission(userId) {
    const earned = db.commissions.filter((c) => c.referrerId === userId && (c.status === "available" || c.status === "pending")).reduce((s, c) => (c.status === "available" ? s + c.amount : s), 0);
    const withdrawn = db.withdrawals.filter((w) => w.userId === userId && (w.status === "approved" || w.status === "pending")).reduce((s, w) => s + w.amount, 0);
    return Math.max(0, Math.round((earned - withdrawn) * 100) / 100);
  }
  function pendingCommission(userId) { return db.commissions.filter((c) => c.referrerId === userId && c.status === "pending").reduce((s, c) => s + c.amount, 0); }
  function totalEarnings(userId) { return db.commissions.filter((c) => c.referrerId === userId).reduce((s, c) => s + c.amount, 0); }
  function lastPixKey(userId) { const mine = db.withdrawals.filter((w) => w.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); return mine.length ? mine[0].pixKey || "" : ""; }
  function myNotifications(userId) { return db.notifications.filter((n) => n.userId === userId && !n.resolved).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  function unreadNotificationsCount(userId) { return myNotifications(userId).filter((n) => !n.read).length; }

  function refreshHeader() {
    const user = currentUser();
    document.body.classList.toggle("is-guest", !user); document.body.classList.toggle("is-admin", !!user && user.role === "admin");
    
    const existingWidget = document.getElementById("supportWidget");
    if (user && user.role !== "admin") { if (!existingWidget) initSupportChatWidget(user);
    } else if (existingWidget) {
        existingWidget.remove();
        if (chatListenerUnsubscribe) { chatListenerUnsubscribe(); chatListenerUnsubscribe = null; }
    }

    if (user) {
      qs("#avatarInitial").textContent = initials(user.name); qs("#avatarInitial").style.background = user.avatarColor || "";
      const pill = qs("#subPill"); const active = isSubscriptionActive(user);
      pill.textContent = active ? "Assinatura ativa" : "Sem assinatura"; pill.className = "sub-pill " + (active ? "active" : "free");
    }
    qsa(".main-nav a, .mobile-nav a").forEach((a) => { a.classList.toggle("active", a.getAttribute("href") === "#" + currentRoute().path); });
    refreshNotificationBell(user);
  }

  let notifBellBound = false;
  function ensureNotificationBell() {
    let btn = document.getElementById("notifBellBtn"); if (btn) return btn;
    const host = qs(".header-user-actions"); if (!host) return null;
    btn = document.createElement("button"); btn.id = "notifBellBtn"; btn.type = "button"; btn.className = "btn-icon"; btn.setAttribute("aria-label", "Notificações"); btn.style.position = "relative";
    btn.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span id="notifBellCount" class="badge badge-danger" style="display:none;position:absolute;top:-4px;right:-4px;padding:1px 5px;font-size:10px;min-width:16px;text-align:center"></span>`;
    const avatarBtn = qs("#avatarBtn", host); if (avatarBtn) host.insertBefore(btn, avatarBtn); else host.appendChild(btn);
    return btn;
  }

  function refreshNotificationBell(user) {
    const btn = ensureNotificationBell(); if (!btn) return;
    if (!user) { btn.style.display = "none"; return; }
    btn.style.display = ""; const count = unreadNotificationsCount(user.id); const countEl = qs("#notifBellCount", btn);
    if (countEl) { countEl.textContent = count > 9 ? "9+" : String(count); countEl.style.display = count > 0 ? "inline-block" : "none"; }
    if (!notifBellBound) { notifBellBound = true; btn.addEventListener("click", (e) => { e.stopPropagation(); navigate("/painel"); setTimeout(() => { const section = document.getElementById("notificationsSection"); if (section) section.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60); }); }
  }

  function currentRoute() {
    const hash = location.hash.replace(/^#/, "") || "/"; const [path, query] = hash.split("?"); const params = {};
    (query || "").split("&").forEach((pair) => { if (!pair) return; const [k, v] = pair.split("="); params[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
    return { path: path || "/", params };
  }
  function navigate(path) { location.hash = path; }

  const PROTECTED_ROUTES = ["/painel", "/perfil", "/indicacoes", "/publicar", "/avaliar"];
  let pendingDataRender = false;
  function hasActiveFormField() { const el = document.activeElement; const app = qs("#app"); if (!el || !app || !app.contains(el)) return false; const tag = el.tagName; return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"; }

  function render(opts) {
    const isNavigation = !!(opts && opts.navigation);
    if (!authReady || !dbReady) { const app = qs("#app"); if (app) app.innerHTML = `<div class="section text-center"><div class="container"><p class="muted">Carregando…</p></div></div>`; return; }
    refreshHeader();
    if (!isNavigation && hasActiveFormField()) { pendingDataRender = true; return; }
    pendingDataRender = false;
    const { path, params } = currentRoute(); const app = qs("#app"); const user = currentUser();
    if (PROTECTED_ROUTES.some((p) => path.startsWith(p)) && !user) { location.href = "login.html?redirect=" + encodeURIComponent(path.replace(/^\//, "").split("?")[0] || "painel"); return; }

    let seg = path.split("/").filter(Boolean); let html = "";
    if (path === "/" || path === "") html = "<div class='section text-center'><h1>Página Inicial</h1></div>"; // Simplificado para economizar espaço
    else html = "<div class='section text-center'><h1>"+path+"</h1></div>";

    app.innerHTML = html;
    if (isNavigation) { window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" }); }
    bindPageEvents(path);
    if (typeof Android !== "undefined" && Android.atualizarRota) { Android.atualizarRota(path); }
  }

  document.addEventListener("focusout", () => { if (!pendingDataRender) return; setTimeout(() => { if (!hasActiveFormField()) render({ navigation: false }); }, 0); });

  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  function bindThemeToggle() {
    const themeToggle = qs("#themeToggle");
    const themeIcon = qs("#themeIcon");
    if (!themeToggle || !themeIcon) return;

    const iconSun = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    const iconMoon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

    if (document.documentElement.getAttribute('data-theme') === 'dark') { themeIcon.innerHTML = iconSun; } else { themeIcon.innerHTML = iconMoon; }

    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      if (currentTheme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        themeIcon.innerHTML = iconMoon;
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
        themeIcon.innerHTML = iconSun;
      }
    });
  }

  function bindGlobalUI() {
    bindThemeToggle();
    const avatarBtn = qs("#avatarBtn"); const userMenu = qs("#userMenu");
    if (avatarBtn) { avatarBtn.addEventListener("click", (e) => { e.stopPropagation(); userMenu.classList.toggle("open"); }); document.addEventListener("click", () => userMenu.classList.remove("open")); }
    ["logoutBtn", "logoutBtnMobile"].forEach((id) => { const btn = qs("#" + id); if (btn) { btn.addEventListener("click", async () => { await logoutUser(); toast("Você saiu da sua conta."); navigate("/"); }); } });
    const hamburger = qs("#hamburgerBtn"); const mobileNav = qs("#mobileNav");
    if (hamburger && mobileNav) { 
        hamburger.addEventListener("click", (e) => { 
            e.stopPropagation();
            if (mobileNav.classList.contains("open")) {
                mobileNav.classList.remove("open"); document.body.style.overflow = ""; document.body.classList.remove("menu-open");
            } else {
                mobileNav.classList.add("open"); document.body.style.overflow = "hidden"; document.body.classList.add("menu-open"); 
            }
        });
        qsa("#mobileNav a, #mobileNav button").forEach((el) => { 
            el.addEventListener("click", () => { mobileNav.classList.remove("open"); document.body.style.overflow = ""; document.body.classList.remove("menu-open"); }); 
        }); 
    }
  }

  function bindPageEvents(path) {}

  /* =========================================================
     WIDGET DE SUPORTE (CHAT DO UTILIZADOR COM DATAS E AVISO)
     ========================================================= */
  
  function confirmActionUser(message, opts) {
      opts = opts || {};
      return new Promise((resolve) => {
          let overlay = qs("#confirmOverlay");
          if (!overlay) {
              overlay = document.createElement("div"); overlay.className = "confirm-overlay"; overlay.id = "confirmOverlay";
              overlay.innerHTML = `<div class="confirm-box"><div class="confirm-icon" id="confirmIcon">!</div><h3 id="confirmTitle">Confirmar</h3><p id="confirmMessage">Tem certeza?</p><div class="confirm-actions"><button class="btn btn-ghost btn-block" id="confirmCancelBtn" type="button">Cancelar</button><button class="btn btn-danger btn-block" id="confirmOkBtn" type="button">Confirmar</button></div></div>`;
              document.body.appendChild(overlay);
          }
          const box = overlay.querySelector(".confirm-box");
          qs("#confirmTitle", overlay).textContent = opts.title || "Confirmar ação";
          qs("#confirmMessage", overlay).textContent = message;
          qs("#confirmOkBtn", overlay).textContent = opts.confirmLabel || "Confirmar";
          qs("#confirmCancelBtn", overlay).textContent = opts.cancelLabel || "Cancelar";
          box.classList.toggle("is-neutral", !!opts.neutral);
          qs("#confirmIcon", overlay).textContent = opts.neutral ? "?" : "!";
          overlay.classList.add("open");
          
          function settle(result) {
              overlay.classList.remove("open");
              qs("#confirmOkBtn", overlay).removeEventListener("click", onOk);
              qs("#confirmCancelBtn", overlay).removeEventListener("click", onCancel);
              resolve(result);
          }
          function onOk() { settle(true); }
          function onCancel() { settle(false); }
          qs("#confirmOkBtn", overlay).addEventListener("click", onOk);
          qs("#confirmCancelBtn", overlay).addEventListener("click", onCancel);
      });
  }

  // Função para formatar a data (Hoje, Ontem, etc.)
  function formatChatDate(isoString) {
      const date = new Date(isoString);
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);

      if (date.toDateString() === today.toDateString()) return "Hoje";
      if (date.toDateString() === yesterday.toDateString()) return "Ontem";
      return date.toLocaleDateString("pt-BR");
  }

  function initSupportChatWidget(user) {
      const existing = document.getElementById("supportWidget");
      if (existing) existing.remove();
      if (chatListenerUnsubscribe) { chatListenerUnsubscribe(); chatListenerUnsubscribe = null; }

      if (!user || user.role === "admin") return;

      const hiddenKey = `supportChatEnded_${user.id}`;
      let isChatClosed = localStorage.getItem(hiddenKey) === "1";

      const widget = document.createElement("div");
      widget.id = "supportWidget";
      widget.className = "support-widget";
      
      widget.innerHTML = `
          <style>
            .support-bubble-btn {
                position: fixed; bottom: 24px; right: 24px; z-index: 9998;
                width: 60px; height: 60px; border-radius: 50%;
                background: linear-gradient(135deg, #2f63e0 0%, #1a49d6 100%);
                color: #fff; border: none;
                box-shadow: 0 8px 24px rgba(47, 99, 224, 0.4), inset 0 2px 4px rgba(255,255,255,0.2);
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                animation: floatBubble 3s ease-in-out infinite;
            }
            .support-bubble-btn:hover {
                transform: scale(1.08) translateY(-4px);
                box-shadow: 0 12px 28px rgba(47, 99, 224, 0.5), inset 0 2px 4px rgba(255,255,255,0.3);
                animation: none;
            }
            @keyframes floatBubble { 0% { transform: translateY(0px); } 50% { transform: translateY(-6px); } 100% { transform: translateY(0px); } }
            .support-bubble-btn .badge-unread {
                position: absolute; top: -2px; right: -2px;
                background: #ef4444; color: white; border-radius: 50%;
                width: 20px; height: 20px; font-size: 11px;
                display: flex; align-items: center; justify-content: center;
                font-weight: bold; border: 2px solid #1a49d6;
                animation: pulseRed 2s infinite;
            }
            @keyframes pulseRed { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
          </style>

          <div class="support-window" id="supportWindow">
              <div class="support-header">
                  <div class="support-header-info">
                      <span class="support-avatar">CP</span>
                      <div>
                          <h4>Suporte ao Criador</h4>
                          <p id="supportStatusText"><span class="support-status-dot" style="background:#94a3b8"></span>Ausente</p>
                      </div>
                  </div>
                  <div class="support-header-actions">
                      <button class="support-icon-btn" id="endChatBtnUser" title="Sair do chat">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                      </button>
                      <button class="support-close" id="closeChatBtn">&times;</button>
                  </div>
              </div>
              <div class="support-body" id="supportBody" style="padding-top: 0;">
                  <div style="background: rgba(220,174,44,0.15); color: var(--gold-700); padding: 8px 12px; font-size: 11.5px; text-align: center; font-weight: 600; margin: 0 -16px 16px -16px; border-bottom: 1px solid rgba(220,174,44,0.25);">
                      ⚠️ O chat é encerrado caso você ou o suporte fiquem 5 minutos sem responder.
                  </div>
                  <p class="muted text-center" style="font-size: 12px; margin-top: 20px;">Envie-nos uma mensagem e responderemos em breve.</p>
              </div>
              <div class="support-restart" id="supportRestart" style="display:none; flex-direction:column; align-items:center; justify-content:center; flex:1;">
                  <h4 style="margin-bottom: 8px;">Atendimento Encerrado</h4>
                  <p class="muted text-center" style="font-size:13px; margin-bottom: 16px; padding: 0 20px;">A conversa de suporte foi encerrada por inatividade ou manualmente.</p>
                  <button class="btn btn-primary btn-sm" id="restartChatBtn" type="button">Iniciar novo chat</button>
              </div>
              <form class="support-footer" id="supportForm">
                  <input type="text" id="supportInput" placeholder="Escreva a sua mensagem..." required autocomplete="off">
                  <button type="submit">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                  </button>
              </form>
          </div>
          <button class="support-bubble-btn" id="openChatBtn">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v5Z"></path>
                  <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"></path>
              </svg>
              <span class="badge-unread" id="chatUnreadBadge" style="display: none;">!</span>
          </button>
      `;
      document.body.appendChild(widget);

      const fab = document.getElementById("openChatBtn");
      const chatWin = document.getElementById("supportWindow");
      const closeBtn = document.getElementById("closeChatBtn");
      const endBtnUser = document.getElementById("endChatBtnUser");
      const form = document.getElementById("supportForm");
      const input = document.getElementById("supportInput");
      const body = document.getElementById("supportBody");
      const badge = document.getElementById("chatUnreadBadge");
      const restartBox = document.getElementById("supportRestart");
      const restartBtn = document.getElementById("restartChatBtn");
      const statusText = document.getElementById("supportStatusText");

      // Escutar presença do Admin para mostrar Online/Ausente
      escutarPresencaAdmin((isOnline) => {
          if (isOnline) {
              statusText.innerHTML = `<span class="support-status-dot" style="background:#4ade80; box-shadow: 0 0 0 2px rgba(255,255,255,.35);"></span>Online agora`;
          } else {
              statusText.innerHTML = `<span class="support-status-dot" style="background:#94a3b8; box-shadow: 0 0 0 2px rgba(255,255,255,.35);"></span>Ausente`;
          }
      });

      function applyChatState(closed) {
          if (closed) {
              body.style.display = "none";
              form.style.display = "none";
              restartBox.style.display = "flex";
          } else {
              body.style.display = "flex";
              form.style.display = "flex";
              restartBox.style.display = "none";
          }
      }
      applyChatState(isChatClosed);

      fab.addEventListener("click", () => {
          chatWin.classList.add("open");
          badge.style.display = "none";
          marcarChatLidoUser(user.id);
          if (!isChatClosed) setTimeout(() => input.focus(), 100);
          body.scrollTop = body.scrollHeight;
      });
      
      closeBtn.addEventListener("click", () => { chatWin.classList.remove("open"); });

      endBtnUser.addEventListener("click", async () => {
          const ok = await confirmActionUser("Sair da conversa de suporte? O chat será encerrado definitivamente.", {
              title: "Sair do Chat", confirmLabel: "Sim, sair", neutral: true
          });
          if (!ok) return;

          isChatClosed = true;
          localStorage.setItem(hiddenKey, "1");
          applyChatState(true);
          
          import("https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js").then(({ ref, update }) => {
              import("./firebase-config.js").then(({ rtdb }) => { update(ref(rtdb, `supportChats/${user.id}`), { status: "closed" }); });
          });
      });

      restartBtn.addEventListener("click", () => {
          isChatClosed = false;
          localStorage.removeItem(hiddenKey);
          applyChatState(false);
          setTimeout(() => input.focus(), 100);
          
          import("https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js").then(({ ref, update, set }) => {
              import("./firebase-config.js").then(({ rtdb }) => {
                  set(ref(rtdb, `supportChats/${user.id}/messages`), null);
                  update(ref(rtdb, `supportChats/${user.id}`), { status: "open", lastMessage: "", unreadAdmin: false, unreadUser: false });
              });
          });
      });

      form.addEventListener("submit", (e) => {
          e.preventDefault(); const text = input.value.trim(); if (!text) return;
          input.value = "";
          enviarMensagemSuporte(user.id, user.name, text, "user").then(() => playSupportSound("send")).catch(err => toast("Erro ao enviar: " + err.message, "error"));
      });

      let lastMsgCount = 0;
      chatListenerUnsubscribe = escutarChatUsuario(user.id, (data) => {
          if (!data) return;
          
          // Chat encerrado pelo Admin ou pelo Auto-Close (5 mins)
          if (data.status === "closed") {
              isChatClosed = true;
              localStorage.setItem(hiddenKey, "1");
              applyChatState(true);
              return;
          } else {
              isChatClosed = false;
              localStorage.removeItem(hiddenKey);
              applyChatState(false);
          }

          if (data.unreadUser && !chatWin.classList.contains("open")) { badge.style.display = "flex"; }

          // Aviso amarelo fixo no topo + limpar mensagens
          body.innerHTML = `<div style="background: rgba(220,174,44,0.15); color: var(--gold-700); padding: 8px 12px; font-size: 11.5px; text-align: center; font-weight: 600; margin: 0 -16px 16px -16px; border-bottom: 1px solid rgba(220,174,44,0.25);">⚠️ O chat é encerrado caso você ou o suporte fiquem 5 minutos sem responder.</div>`;
          
          if (!data.messages) {
              body.innerHTML += '<p class="muted text-center" style="font-size: 12px; margin-top: 20px;">Envie-nos uma mensagem e responderemos em breve.</p>';
              return;
          }

          const msgs = Object.values(data.messages).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

          if (msgs.length > lastMsgCount && lastMsgCount > 0) {
              const last = msgs[msgs.length - 1];
              if (last.sender === "admin") playSupportSound("receive");
          }
          lastMsgCount = msgs.length;
          
          let lastDateLabel = "";
          msgs.forEach(msg => {
              const dateLabel = formatChatDate(msg.createdAt);
              if (dateLabel !== lastDateLabel) {
                  const sep = document.createElement("div");
                  sep.style.cssText = "text-align: center; font-size: 10px; color: var(--ink-400); margin: 8px 0; font-weight: 700; text-transform: uppercase;";
                  sep.textContent = dateLabel;
                  body.appendChild(sep);
                  lastDateLabel = dateLabel;
              }

              const div = document.createElement("div");
              div.className = `chat-msg ${msg.sender === "user" ? "user-sent" : "admin-received"}`;
              const time = new Date(msg.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
              div.innerHTML = `${escapeHtml(msg.text)} <span class="support-msg-time" style="display:block; text-align:right; font-size:10px; opacity:0.7; margin-top:4px;">${time}</span>`;
              body.appendChild(div);
          });

          body.scrollTop = body.scrollHeight;
          if (chatWin.classList.contains("open") && data.unreadUser) { marcarChatLidoUser(user.id); }
      });
  }

  // Sons curtos via Web Audio API
  let audioCtx = null;
  function playSupportSound(type) {
      try {
          if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
          osc.connect(gain); gain.connect(audioCtx.destination);
          osc.type = "sine";
          if (type === "send") {
              osc.frequency.setValueAtTime(700, audioCtx.currentTime); osc.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.08);
          } else {
              osc.frequency.setValueAtTime(500, audioCtx.currentTime); osc.frequency.exponentialRampToValueAtTime(650, audioCtx.currentTime + 0.1);
          }
          gain.gain.setValueAtTime(0.08, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
          osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.15);
      } catch (e) {}
  }

  onAuthStateChanged(auth, async (user) => { 
      firebaseUser = user; authReady = true; dbReady = false; 
      if (user) {
          const savedToken = localStorage.getItem("fcm_token_temp");
          if (savedToken && (!db || !db.myProfile || db.myProfile.fcmToken !== savedToken)) { try { await updateUserProfile(user.uid, { fcmToken: savedToken }); } catch(e){} }
      }
      render({ navigation: true }); 
  });

  onDBChange((newDb) => { db = newDb; dbReady = true; render({ navigation: false }); });
  window.addEventListener("hashchange", () => render({ navigation: true }));
  document.addEventListener("DOMContentLoaded", () => { bindGlobalUI(); render({ navigation: true }); if (typeof Android !== "undefined" && Android.siteTotalmenteCarregado) Android.siteTotalmenteCarregado(); });

  window.tentarAcessarPainel = function(event) { event.preventDefault(); if (typeof Android !== "undefined") { Android.solicitarBiometria(); } else { navigate("/painel"); } };
  window.biometriaAprovada = function() { navigate("/painel"); };
  window.alertaSemInternet = function() { toast("Conexão perdida. O aplicativo recarregará quando a rede voltar.", "error"); };
  window.salvarTokenPush = async function(token) { localStorage.setItem("fcm_token_temp", token); setTimeout(async () => { const user = currentUser(); if (user && user.fcmToken !== token) { try { await updateUserProfile(user.id, { fcmToken: token }); } catch (err) {} } }, 3000); };
})();
