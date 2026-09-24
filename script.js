/* =========================================================
   COMPARTILHAR PROJETOS — SCRIPT.JS (v26 - Código Completo e Corrigido)
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDB, onDBChange, updateUserProfile, addProject, updateProject, addPost, addComment, addReply, addWithdrawalRequest, markNotificationRead, enviarNotificacaoPush, addPlatformReview,
  enviarMensagemSuporte, escutarChatUsuario, marcarChatLidoUser, escutarPresencaAdmin, notificarDigitacao
} from "./db-sync.js";
import { uid, nowISO } from "./seed.js";

(function () {
  "use strict";

  const WORKER_URL = "https://api.compartilhar-projetos.com.br";
  const PLANS = {
    pTeste: { id: "pTeste", name: "Plano Teste", price: 5, days: 2 },
    p4: { id: "p4", name: "Plano 4 Dias", price: 10, days: 4 },
    p7: { id: "p7", name: "Plano 7 Dias", price: 20, days: 7 },
    pMensal: { id: "pMensal", name: "Plano Mensal", price: 50, days: 30 },
  };
  const COMMISSION_RATE = 0.3;
  const MIN_WITHDRAW = 10;

  // VARIÁVEIS GLOBAIS
  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;
  let chatListenerUnsubscribe = null;
  let pendingImages = [];
  let notifBellBound = false;
  let pendingDataRender = false;
  let qrCodeLibPromise = null;
  let audioCtx = null;

  // =========================================================
  // FUNÇÕES UTILITÁRIAS E DE USUÁRIO
  // =========================================================
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
    const seconds = Math.round((new Date() - new Date(isoString)) / 1000);
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);
    if (seconds < 60) return "Agora mesmo"; if (minutes < 60) return `Há ${minutes} min`; if (hours < 24) return `Há ${hours} h`; if (days === 1) return "Ontem"; if (days < 7) return `Há ${days} dias`;
    return fmtDate(isoString);
  }

  function fmtBRL(v) { return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function initials(name) { return (name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(""); }
  
  function toast(msg, type) {
    const stack = document.getElementById("toastStack"); if (!stack) return;
    const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
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
    if (!isPlausibleContact(data.contact)) return { status: "rejected", rejectReason: "contato" };
    return { status: "pending", rejectReason: null };
  }

  function onlyDigits(str) { return (str || "").replace(/\D/g, ""); }
  function isValidDocument(str) { const digits = onlyDigits(str); return digits.length === 11 || digits.length === 14; }

  // =========================================================
  // PAGAMENTOS PIX E COMISSÕES
  // =========================================================
  function ensureQRCodeLib() {
    if (window.QRCode) return Promise.resolve();
    if (qrCodeLibPromise) return qrCodeLibPromise;
    qrCodeLibPromise = new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"; script.onload = () => resolve(); script.onerror = () => reject(new Error("Falha ao carregar gerador de QR Code")); document.head.appendChild(script); });
    return qrCodeLibPromise;
  }

  function renderQRCode(container, text) { container.innerHTML = ""; ensureQRCodeLib().then(() => { new QRCode(container, { text: text || "", width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M, }); }).catch(() => { container.innerHTML = `<span class="muted" style="font-size:12px;display:block;padding:12px">Não foi possível gerar o QR Code. Use o código copia e cola abaixo.</span>`; }); }

  async function startPixPayment(planId, documentOverride) {
    const user = currentUser(); if (!user) throw new Error("Você precisa entrar na sua conta.");
    const plan = PLANS[planId]; if (!plan) throw new Error("Plano inválido.");
    const document = documentOverride || user.document; if (!document) throw new Error("Informe seu CPF ou CNPJ antes de continuar.");
    const response = await fetch(`${WORKER_URL}/create-pix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: user.id, planId: plan.id, client: { name: user.name, email: user.email, phone: user.phone || "(11) 99999-9999", document } }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Erro ao gerar cobrança Pix"); return data;
  }

  function showDocumentModal() {
    const existing = qs(".modal-overlay"); if (existing) existing.remove();
    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div"); overlay.className = "modal-overlay open";
      overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><button type="button" class="modal-close" id="documentCancelBtn" aria-label="Fechar">×</button><h2>Falta só um passo</h2><p class="sub">Para gerar seu Pix, precisamos do seu CPF ou CNPJ (exigido pelo meio de pagamento).</p><form id="documentForm"><div class="field"><label>CPF ou CNPJ</label><input name="document" inputmode="numeric" placeholder="Somente números" required></div><div class="field-error" id="documentError" style="display:none"></div><button class="btn btn-primary btn-block" type="submit">Continuar</button></form></div>`;
      document.body.appendChild(overlay);
      const form = qs("#documentForm", overlay); const errorEl = qs("#documentError", overlay);
      form.addEventListener("submit", async (e) => {
        e.preventDefault(); const digits = onlyDigits(new FormData(form).get("document"));
        if (!isValidDocument(digits)) { errorEl.textContent = "Informe um CPF ou CNPJ válido."; errorEl.style.display = "block"; return; }
        try { await updateUserProfile(currentUser().id, { document: digits }); } catch (err) { }
        overlay.remove(); resolve(digits);
      });
      qs("#documentCancelBtn", overlay).addEventListener("click", () => { overlay.remove(); reject(new Error("cancelado")); });
    });
  }

  function showPixModal({ pix }) {
    const overlay = document.createElement("div"); overlay.className = "modal-overlay open";
    overlay.innerHTML = `
      <style>
        .modal-overlay.open { align-items: flex-start !important; overflow-y: auto !important; padding: 30px 20px !important; }
        .pix-modal-wrapper { display: block !important; margin: auto !important; max-height: none !important; }
        #pixQrCode img, #pixQrCode canvas { width: 220px !important; height: 220px !important; min-width: 220px !important; min-height: 220px !important; aspect-ratio: 1 / 1 !important; margin: 0 auto !important; }
      </style>
      <div class="modal-box pix-modal-wrapper" style="max-width:400px;text-align:center;">
        <button type="button" class="modal-close" id="pixCloseBtn" aria-label="Fechar">×</button>
        <h2>Pague com Pix para ativar sua assinatura</h2>
        <div id="pixQrCode" style="margin:16px auto; display:flex; align-items:center; justify-content:center;">
          <span class="muted" style="font-size:12px">Gerando QR Code…</span>
        </div>
        <textarea readonly style="width:100%;font-size:11px;padding:8px" rows="4">${pix.code || ""}</textarea>
        <button id="pixCopyBtn" class="btn btn-primary btn-sm mt-2">Copiar código</button>
        <p class="muted mt-2" style="font-size:13px">Assim que o pagamento for confirmado, sua assinatura ativa automaticamente — não precisa recarregar a página.</p>
      </div>`;
    document.body.appendChild(overlay); renderQRCode(qs("#pixQrCode", overlay), pix.code);
    let handled = false; let stopWatching = null;
    const unsubscribe = onDBChange(() => {
      const user = currentUser();
      if (user && isSubscriptionActive(user) && !handled) { handled = true; overlay.remove(); toast("Pagamento confirmado — assinatura ativa!", "success"); Promise.resolve().then(() => { if (typeof stopWatching === "function") stopWatching(); }); render({ navigation: true }); }
    });
    stopWatching = unsubscribe;
    qs("#pixCopyBtn", overlay).addEventListener("click", () => { navigator.clipboard.writeText(pix.code || ""); toast("Código copiado!", "success"); });
    qs("#pixCloseBtn", overlay).addEventListener("click", () => { overlay.remove(); handled = true; if (typeof stopWatching === "function") stopWatching(); });
  }

  function availableCommission(userId) {
    const earned = db.commissions.filter((c) => c.referrerId === userId && (c.status === "available" || c.status === "pending")).reduce((s, c) => (c.status === "available" ? s + c.amount : s), 0);
    const withdrawn = db.withdrawals.filter((w) => w.userId === userId && (w.status === "approved" || w.status === "pending")).reduce((s, w) => s + w.amount, 0);
    return Math.max(0, Math.round((earned - withdrawn) * 100) / 100);
  }
  function pendingCommission(userId) { return db.commissions.filter((c) => c.referrerId === userId && c.status === "pending").reduce((s, c) => s + c.amount, 0); }
  function totalEarnings(userId) { return db.commissions.filter((c) => c.referrerId === userId).reduce((s, c) => s + c.amount, 0); }
  function lastPixKey(userId) { const mine = db.withdrawals.filter((w) => w.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); return mine.length ? mine[0].pixKey || "" : ""; }

  // =========================================================
  // AÇÕES DA PLATAFORMA (PROJETOS, COMUNIDADE, SAQUE)
  // =========================================================
  async function publishProject(data) {
    const user = currentUser(); if (!user) throw new Error("Você precisa entrar na sua conta.");
    if (!canPublish(user)) throw new Error("Sua assinatura não está ativa. Assine um plano para publicar.");
    const moderation = moderateProject(data);
    const project = { id: uid("pj"), title: sanitizeText(data.title.trim()), description: sanitizeText(data.description.trim()), images: (data.images || []).slice(0, 6), categoryId: data.categoryId, link: data.link.trim(), ownerName: sanitizeText(data.ownerName.trim()), contact: sanitizeText(data.contact.trim()), ownerId: user.id, createdAt: nowISO(), status: moderation.status };
    const saved = await addProject(project);
    if (moderation.status === "rejected") { try { await fetch(`${WORKER_URL}/notify-auto-rejection`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + await auth.currentUser.getIdToken() }, body: JSON.stringify({ projectId: project.id, rejectReason: moderation.rejectReason }) }); } catch (err) {} }
    return saved;
  }

  async function resendProject(projectId, data) {
    const user = currentUser(); if (!user) throw new Error("Você precisa entrar na sua conta.");
    const existing = db.projects.find((p) => p.id === projectId); if (!existing || existing.ownerId !== user.id) throw new Error("Projeto não encontrado.");
    const moderation = moderateProject(data);
    const updates = { title: sanitizeText(data.title.trim()), description: sanitizeText(data.description.trim()), images: (data.images && data.images.length ? data.images : existing.images || []).slice(0, 6), categoryId: data.categoryId, link: data.link.trim(), ownerName: sanitizeText(data.ownerName.trim()), contact: sanitizeText(data.contact.trim()), status: moderation.status };
    const saved = await updateProject(projectId, updates);
    if (moderation.status === "rejected") { try { await fetch(`${WORKER_URL}/notify-auto-rejection`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + await auth.currentUser.getIdToken() }, body: JSON.stringify({ projectId, rejectReason: moderation.rejectReason }) }); } catch (err) {} }
    return saved;
  }

  function createPost(content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para publicar.");
    if (!content || content.trim().length < 2) throw new Error("Escreva algo antes de publicar.");
    if (containsLink(content)) throw new Error("Não é permitido incluir links nas publicações da comunidade.");
    const post = { id: uid("post"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO(), comments: [] };
    return addPost(post);
  }

  function createComment(postId, content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para comentar.");
    if (!content || !content.trim()) throw new Error("Escreva um comentário.");
    if (containsLink(content)) throw new Error("Não é permitido incluir links nos comentários.");
    const post = db.posts.find((p) => p.id === postId);
    if (!post) throw new Error("Publicação não encontrada.");
    const comment = { id: uid("cm"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO(), replies: [] };
    const resultado = addComment(postId, comment);
    if (post.authorId && post.authorId !== user.id) {
      enviarNotificacaoPush({ targetUserId: post.authorId, title: "Novo comentário", body: `${user.name} comentou na sua publicação.`, data: { tipo: "comentario", postId }, });
    }
    return resultado;
  }

  function createReply(postId, commentId, content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para responder.");
    if (!content || !content.trim()) throw new Error("Escreva uma resposta.");
    if (containsLink(content)) throw new Error("Não é permitido incluir links nas respostas.");
    const post = db.posts.find((p) => p.id === postId);
    const comment = post && post.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error("Comentário não encontrado.");
    const reply = { id: uid("rp"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO() };
    const resultado = addReply(postId, commentId, reply);
    if (comment.authorId && comment.authorId !== user.id) {
      enviarNotificacaoPush({ targetUserId: comment.authorId, title: "Nova resposta", body: `${user.name} respondeu ao seu comentário.`, data: { tipo: "resposta", postId }, });
    }
    return resultado;
  }

  function requestWithdrawal(amount, pixKey) {
    const user = currentUser(); if (!user) throw new Error("Entre na sua conta.");
    const available = availableCommission(user.id);
    if (!pixKey || !pixKey.trim()) throw new Error("Informe sua chave Pix para receber o saque.");
    if (amount < MIN_WITHDRAW) throw new Error(`O saque mínimo é ${fmtBRL(MIN_WITHDRAW)}.`);
    if (amount > available) throw new Error("Valor solicitado maior que o saldo disponível.");
    return addWithdrawalRequest({ id: uid("wd"), userId: user.id, amount, pixKey: sanitizeText(pixKey.trim()), status: "pending", createdAt: nowISO() });
  }

  function myNotifications(userId) { return db.notifications.filter((n) => n.userId === userId && !n.resolved).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  function unreadNotificationsCount(userId) { return myNotifications(userId).filter((n) => !n.read).length; }

  // =========================================================
  // UI GERAL E ROTEAMENTO
  // =========================================================
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

  function refreshHeader() {
    const user = currentUser();
    document.body.classList.toggle("is-guest", !user); document.body.classList.toggle("is-admin", !!user && user.role === "admin");
    
    const existingWidget = document.getElementById("supportWidget");
    if (user && user.role !== "admin") {
        if (!existingWidget) initSupportChatWidget(user);
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

  function currentRoute() {
    const hash = location.hash.replace(/^#/, "") || "/"; const [path, query] = hash.split("?"); const params = {};
    (query || "").split("&").forEach((pair) => { if (!pair) return; const [k, v] = pair.split("="); params[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
    return { path: path || "/", params };
  }
  function navigate(path) { location.hash = path; }

  const PROTECTED_ROUTES = ["/painel", "/perfil", "/indicacoes", "/publicar", "/avaliar"];
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
    if (path === "/" || path === "") html = viewHome();
    else if (path === "/explorar") html = viewExplore(params);
    else if (seg[0] === "projeto" && seg[1]) html = viewProjectDetail(seg[1]);
    else if (path === "/publicar") html = viewPublish(params);
    else if (path === "/comunidade") html = viewCommunity();
    else if (path === "/planos") html = viewPlans();
    else if (path === "/painel") html = viewDashboard();
    else if (path === "/perfil") html = viewProfile();
    else if (path === "/indicacoes") html = viewReferrals();
    else if (path === "/ranking") html = viewRanking();
    else if (path === "/avaliar") html = viewPlatformReview();
    else html = view404();

    app.innerHTML = html;
    if (isNavigation) { window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" }); }
    bindPageEvents(path);
    if (typeof Android !== "undefined" && Android.atualizarRota) { Android.atualizarRota(path); }
  }

  document.addEventListener("focusout", () => { if (!pendingDataRender) return; setTimeout(() => { if (!hasActiveFormField()) render({ navigation: false }); }, 0); });
  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  // =========================================================
  // CHAT FLUTUANTE DE SUPORTE
  // =========================================================
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

  function formatChatDate(isoString) {
      const date = new Date(isoString);
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);
      if (date.toDateString() === today.toDateString()) return "Hoje";
      if (date.toDateString() === yesterday.toDateString()) return "Ontem";
      return date.toLocaleDateString("pt-BR");
  }

  function playSupportSound(type) {
      try {
          if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
          osc.connect(gain); gain.connect(audioCtx.destination); osc.type = "sine";
          if (type === "send") { osc.frequency.setValueAtTime(700, audioCtx.currentTime); osc.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.08); } 
          else { osc.frequency.setValueAtTime(500, audioCtx.currentTime); osc.frequency.exponentialRampToValueAtTime(650, audioCtx.currentTime + 0.1); }
          gain.gain.setValueAtTime(0.08, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
          osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.15);
      } catch (e) {}
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
            
            #supportBody { display: flex; flex-direction: column; gap: 12px; }
            .chat-msg {
                max-width: 85%; padding: 10px 14px; border-radius: 16px;
                font-size: 13.5px; line-height: 1.45; word-break: break-word;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            .user-sent {
                background: var(--blue-600, #1a49d6); color: #ffffff;
                align-self: flex-end; border-bottom-right-radius: 4px;
            }
            .admin-received {
                background: var(--surface-alt, #f1f5fd); color: var(--ink-900, #03070f);
                border: 1px solid var(--border-color, #dde4f3);
                align-self: flex-start; border-bottom-left-radius: 4px;
            }
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
                  <!-- Mensagens entram aqui -->
              </div>
              <div class="support-restart" id="supportRestart" style="display:none; flex-direction:column; align-items:center; justify-content:center; flex:1;">
                  <h4 style="margin-bottom: 8px;">Atendimento Encerrado</h4>
                  <p class="muted text-center" style="font-size:13px; margin-bottom: 16px; padding: 0 20px;">A conversa de suporte foi encerrada. Precisa de mais ajuda?</p>
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

      escutarPresencaAdmin((isOnline) => {
          if (isOnline) {
              statusText.innerHTML = `<span class="support-status-dot" style="background:#4ade80; box-shadow: 0 0 0 2px rgba(255,255,255,.35);"></span>Online agora`;
          } else {
              statusText.innerHTML = `<span class="support-status-dot" style="background:#94a3b8; box-shadow: 0 0 0 2px rgba(255,255,255,.35);"></span>Ausente`;
          }
      });

      function applyChatState(closed) {
          if (closed) {
              body.style.display = "none"; form.style.display = "none"; restartBox.style.display = "flex";
          } else {
              body.style.display = "flex"; form.style.display = "flex"; restartBox.style.display = "none";
          }
      }
      applyChatState(isChatClosed);

      fab.addEventListener("click", () => {
          chatWin.classList.add("open"); badge.style.display = "none"; marcarChatLidoUser(user.id);
          if (!isChatClosed) setTimeout(() => input.focus(), 100);
          body.scrollTop = body.scrollHeight;
      });
      
      closeBtn.addEventListener("click", () => { chatWin.classList.remove("open"); });

      // SISTEMA DE "A DIGITAR..." PARA O UTILIZADOR
      let typingTimeout;
      input.addEventListener("input", () => {
          notificarDigitacao(user.id, "user", true);
          clearTimeout(typingTimeout);
          typingTimeout = setTimeout(() => notificarDigitacao(user.id, "user", false), 2000);
      });

      endBtnUser.addEventListener("click", async () => {
          const ok = await confirmActionUser("Sair da conversa de suporte? O chat será encerrado.", { title: "Sair do Chat", confirmLabel: "Sim, sair", neutral: true });
          if (!ok) return;
          isChatClosed = true; localStorage.setItem(hiddenKey, "1"); applyChatState(true);
          import("https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js").then(({ ref, update }) => {
              import("./firebase-config.js").then(({ rtdb }) => { update(ref(rtdb, `supportChats/${user.id}`), { status: "closed" }); });
          });
      });

      restartBtn.addEventListener("click", () => {
          isChatClosed = false; localStorage.removeItem(hiddenKey); applyChatState(false); setTimeout(() => input.focus(), 100);
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
          clearTimeout(typingTimeout); notificarDigitacao(user.id, "user", false);
          enviarMensagemSuporte(user.id, user.name, text, "user").then(() => playSupportSound("send")).catch(err => toast("Erro ao enviar: " + err.message, "error"));
      });

      let lastMsgCount = 0;
      chatListenerUnsubscribe = escutarChatUsuario(user.id, (data) => {
          if (!data) return;
          if (data.status === "closed") {
              isChatClosed = true; localStorage.setItem(hiddenKey, "1"); applyChatState(true); return;
          } else {
              isChatClosed = false; localStorage.removeItem(hiddenKey); applyChatState(false);
          }

          if (data.unreadUser && !chatWin.classList.contains("open")) { badge.style.display = "flex"; }

          // NOVO BANNER LIMPO
          body.innerHTML = `<div style="background: var(--surface-alt, #f8fafc); color: var(--ink-500, #64748b); padding: 10px 14px; font-size: 11px; text-align: center; font-weight: 500; margin: 0 -16px 16px -16px; border-bottom: 1px solid var(--border-soft, #e2e8f0); letter-spacing: 0.02em;">O atendimento é encerrado automaticamente após 5 minutos de inatividade.</div>`;
          
          if (!data.messages) {
              body.innerHTML += '<p class="muted text-center" style="font-size: 12px; margin-top: 20px;">Envie-nos uma mensagem e responderemos em breve.</p>';
          } else {
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
                      sep.textContent = dateLabel; body.appendChild(sep); lastDateLabel = dateLabel;
                  }

                  const div = document.createElement("div");
                  div.className = `chat-msg ${msg.sender === "user" ? "user-sent" : "admin-received"}`;
                  const time = new Date(msg.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                  
                  const senderName = msg.sender === "user" ? "Você" : "Suporte";
                  
                  div.innerHTML = `<div style="font-size:10.5px; font-weight:bold; margin-bottom:2px; opacity:0.8;">${senderName}</div>${escapeHtml(msg.text)} <span class="support-msg-time" style="display:block; text-align:right; font-size:10px; opacity:0.7; margin-top:4px;">${time}</span>`;
                  body.appendChild(div);
              });
          }

          // EXIBIR "O SUPORTE ESTÁ A ESCREVER..."
          if (data.typing_admin) {
              const typeDiv = document.createElement("div");
              typeDiv.innerHTML = `<div style="font-size: 11px; color: var(--ink-400); font-style: italic; padding: 4px 14px;">A digitar...</div>`;
              body.appendChild(typeDiv);
          }

          body.scrollTop = body.scrollHeight;
          if (chatWin.classList.contains("open") && data.unreadUser) { marcarChatLidoUser(user.id); }
      });
  }

  // =========================================================
  // RENDERIZAÇÃO DAS PÁGINAS (VIEWS)
  // =========================================================
  function monthRangeForBRT(date = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });
    const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const year = parseInt(parts.year, 10); const month = parseInt(parts.month, 10);
    const start = new Date(Date.UTC(year, month - 1, 1, 3, 0, 0));
    const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 3, 0, 0));
    return { start, end };
  }

  function currentMonthRanking() {
    const { start, end } = monthRangeForBRT();
    const referralCounts = {};
    db.referrals.forEach((r) => { if (r.createdAt) { const d = new Date(r.createdAt); if (d >= start && d < end) referralCounts[r.referrerId] = (referralCounts[r.referrerId] || 0) + 1; } });

    const payingSets = {};
    db.commissions.forEach((c) => { if (c.createdAt) { const d = new Date(c.createdAt); if (d >= start && d < end) { if (!payingSets[c.referrerId]) payingSets[c.referrerId] = new Set(); payingSets[c.referrerId].add(c.referredId); } } });

    const toSortedList = (map) => Object.entries(map).map(([userId, count]) => ({ user: userById(userId), count })).filter((row) => row.user).sort((a, b) => b.count - a.count).slice(0, 20);
    return { byReferrals: toSortedList(referralCounts), byPaying: toSortedList(Object.fromEntries(Object.entries(payingSets).map(([id, set]) => [id, set.size]))) };
  }

  function currentBiweeklyRanking() {
    const BIWEEKLY_EVENT_ANCHOR = "2026-08-25T03:00:00Z";
    const anchor = new Date(BIWEEKLY_EVENT_ANCHOR);
    const now = new Date();
    const daysSinceAnchor = Math.floor((now - anchor) / 86400000);
    const cycleIndex = Math.max(0, Math.floor(daysSinceAnchor / 15));
    const cycleStart = new Date(anchor.getTime() + cycleIndex * 15 * 86400000);
    const cycleEnd = new Date(cycleStart.getTime() + 15 * 86400000);

    const commissions = db.commissions.filter(c => c && c.planId === "p4" && c.createdAt && new Date(c.createdAt) >= cycleStart && new Date(c.createdAt) < cycleEnd);

    const payingSets = {};
    commissions.forEach((c) => {
      if (!payingSets[c.referrerId]) payingSets[c.referrerId] = new Set();
      payingSets[c.referrerId].add(c.referredId);
    });

    const counts = Object.entries(payingSets).map(([uid, set]) => ({ user: userById(uid), count: set.size })).filter(x => x.user).sort((a,b) => b.count - a.count);
    return { start: cycleStart, end: cycleEnd, ranking: counts };
  }

  function rankingRow(row, i) {
    const pos = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}º`;
    return `<tr><td>${pos}</td><td><span class="pc-mini-avatar" style="background:${row.user.avatarColor || "#888"}">${initials(row.user.name)}</span> ${escapeHtml(row.user.name)}</td><td>${row.count}</td></tr>`;
  }

  function pastPrizesList() { return Object.values(db.rankingPrizes || {}).sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category)).slice(0, 12); }

  function viewRanking() {
    const { byReferrals, byPaying } = currentMonthRanking();
    const monthLabel = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    const prizes = pastPrizesList();
    
    const biweekly = currentBiweeklyRanking();
    const cycleLabel = `${fmtDate(biweekly.start)} até ${fmtDate(biweekly.end)}`;

    const content = `
    <section class="section" style="padding-top:44px">
      <div class="container">
        <!-- BLOCO MENSAL -->
        <span class="tag-label">Ranking de indicações</span>
        <h2 style="margin-bottom:6px">Ranking de ${escapeHtml(monthLabel)}</h2>
        <p class="field-hint" style="margin-bottom:26px">O ranking reinicia todo mês. No fechamento, o 1º lugar de cada categoria leva o prêmio (em caso de empate, sorteio automático decide).</p>
        
        <div class="panel">
          <div class="panel-head"><h3>Mais indicações</h3></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Posição</th><th>Usuário</th><th>Indicações</th></tr></thead>
            <tbody>${byReferrals.map(rankingRow).join("") || `<tr><td colspan="3" class="muted text-center">Ninguém indicou este mês ainda.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Mais assinantes indicados</h3></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Posição</th><th>Usuário</th><th>Assinantes</th></tr></thead>
            <tbody>${byPaying.map(rankingRow).join("") || `<tr><td colspan="3" class="muted text-center">Ninguém converteu assinante este mês ainda.</td></tr>`}</tbody>
          </table></div>
        </div>
        
        <div class="panel">
          <div class="panel-head"><h3>Vencedores anteriores</h3></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Mês</th><th>Categoria</th><th>Vencedor</th><th>Pontuação</th><th>Prêmio</th></tr></thead>
            <tbody>${
              prizes.map((p) => {
                const catLabel = p.category === "indicacoes" ? "Mais indicações" : "Mais assinantes";
                return `<tr><td>${escapeHtml(p.month)}</td><td>${catLabel}</td><td>${p.winnerName ? escapeHtml(p.winnerName) : "—"}</td><td>${p.score}</td><td><span class="badge ${p.delivered ? "badge-success" : "badge-warning"}">${p.delivered ? "Entregue" : "Pendente"}</span></td></tr>`;
              }).join("") || `<tr><td colspan="5" class="muted text-center">Nenhum mês fechado ainda.</td></tr>`
            }</tbody>
          </table></div>
        </div>

        <!-- BLOCO QUINZENAL -->
        <div class="panel mt-4" style="border-color: var(--gold-400)">
          <div class="panel-head">
             <div><h3 style="color: var(--gold-600)">Evento Quinzenal 🏆</h3><p class="muted" style="font-size:13px">Ciclo atual: ${cycleLabel}</p></div>
          </div>
          <p class="field-hint" style="margin: 0 16px 16px">Quem indicar mais assinantes do <strong>Plano 4 dias</strong> bate a meta primeiro e ganha prêmios de até R$ 50 direto no Pix. Duração de 15 dias!</p>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Posição</th><th>Usuário</th><th>Planos de 4 Dias Ativos</th></tr></thead>
            <tbody>${biweekly.ranking.map(rankingRow).join("") || `<tr><td colspan="3" class="muted text-center">Ninguém pontuou neste ciclo ainda.</td></tr>`}</tbody>
          </table></div>
        </div>

      </div>
    </section>`;
    const user = currentUser();
    return user ? `<div class="dash-shell"><nav class="dash-sidebar">${sideNav("/ranking")}</nav><div class="dash-main">${content}</div></div>` : content;
  }

  function sideNav(active) {
    const items = [ ["/painel", "Visão geral"], ["/publicar", "Publicar"], ["/perfil", "Meu perfil"], ["/indicacoes", "Indicações"], ["/ranking", "Ranking"], ["/planos", "Assinatura"], ["/comunidade", "Comunidade"] ];
    return `<div class="side-title">Meu painel</div>${items.map(([p, l]) => `<a class="side-link ${p === active ? "active" : ""}" href="#${p}">${l}</a>`).join("")}`;
  }

  function viewHome() {
    const publishedProjects = db.projects.filter((p) => p.status === "published"); const featured = publishedProjects.slice(0, 4);
    return `
    <section class="hero"><div class="container hero-inner"><div><span class="eyebrow"><span class="dot"></span> Plataforma de assinatura para criadores</span><h1>Encontre projetos, <span class="accent">compartilhe</span> suas ideias e conecte-se com criadores.</h1><p class="lead">Compartilhar Projetos é onde desenvolvedores, designers e criadores publicam o que estão construindo — e descobrem o que o resto da comunidade está criando.</p><div class="hero-cta"><a href="register.html" class="btn btn-gold btn-lg">Cadastrar grátis</a><a href="#/explorar" class="btn btn-ghost btn-lg btn-ghost-hero">Explorar projetos</a></div><div class="hero-stats"><div><strong>${publishedProjects.length}+</strong><span>projetos publicados</span></div><div><strong>${db.publicProfiles.length}+</strong><span>criadores cadastrados</span></div><div><strong>${db.categories.length}</strong><span>categorias ativas</span></div></div></div><div class="hero-visual" aria-hidden="true"><div class="fan-card fan-1"><span class="fc-cat">Design</span><h5>Verso Design System</h5><p>Componentes acessíveis para B2B.</p><div class="fc-foot"><span>Marina D.</span><span class="fc-badge">PRO</span></div></div><div class="fan-card fan-2"><span class="fc-cat">Mobile</span><h5>Trilha</h5><p>Trilhas offline para exploradores.</p><div class="fc-foot"><span>Marina D.</span><span>2 dias</span></div></div><div class="fan-card fan-3"><span class="fc-cat">Web</span><h5>Nimbus</h5><p>Financeiro para freelancers.</p><div class="fc-foot"><span>Marina D.</span><span class="fc-badge">PRO</span></div></div><div class="fan-card fan-4"><span class="fc-cat">IA</span><h5>Seu projeto aqui</h5><p>Publique e alcance a comunidade.</p><div class="fc-foot"><span>Você</span><span>Hoje</span></div></div></div></div></section>
    <section class="section section-alt"><div class="container"><div class="section-head"><div><span class="tag-label">Como funciona</span><h2>Três passos para publicar seu projeto</h2></div></div><div class="steps-grid"><div class="step-card"><div class="step-num">Passo 1</div><h3>Crie sua conta grátis</h3><p>Cadastro leva menos de um minuto. Contas gratuitas já podem explorar todos os projetos publicados.</p></div><div class="step-card"><div class="step-num">Passo 2</div><h3>Assine um plano</h3><p>Escolha entre 4 ou 7 dias de publicação ativa. Pague uma vez e publique quantos projetos quiser no período.</p></div><div class="step-card"><div class="step-num">Passo 3</div><h3>Publique e conecte-se</h3><p>Adicione imagens, categoria, link e contato. Participe da comunidade e receba feedback de outros criadores.</p></div></div></div></section>
    <section class="section"><div class="container"><div class="section-head"><div><span class="tag-label">Recém-publicados</span><h2>Projetos em destaque</h2></div><a href="#/explorar" class="link">Ver todos os projetos →</a></div><div class="project-grid">${featured.map(projectCard).join("") || emptyState("Nenhum projeto publicado ainda.")}</div></div></section>
    <section class="section-tight"><div class="cta-band"><h2>Pronto para mostrar o que você está construindo?</h2><p>Assine um plano de publicação e coloque seu projeto na frente de toda a comunidade.</p><a href="#/planos" class="btn btn-gold btn-lg">Assinar para publicar</a></div></section>`;
  }

  function emptyState(msg, sub) { return `<div class="empty-state" style="grid-column:1/-1"><h3>${escapeHtml(msg)}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div>`; }

  function viewExplore(params) {
    const search = (params.q || "").toLowerCase();
    let list = db.projects.filter((p) => p.status === "published");
    if (search) list = list.filter((p) => p.title.toLowerCase().includes(search) || p.description.toLowerCase().includes(search));
    const grouped = {}; db.categories.forEach(c => grouped[c.id] = { name: c.name, projects: [] }); grouped["geral"] = { name: "Geral", projects: [] };
    list.forEach(p => { const cId = p.categoryId || "geral"; if(grouped[cId]) grouped[cId].projects.push(p); });
    const categoriesHtml = Object.values(grouped).filter(g => g.projects.length > 0).map(g => `<div class="category-section" style="margin-bottom: 48px;"><h3 style="margin-bottom: 20px; border-bottom: 2px solid var(--gold-500, #d4af37); padding-bottom: 8px; display: inline-block;">${escapeHtml(g.name)}</h3><div class="project-grid">${g.projects.map(projectCard).join("")}</div></div>`).join("");
    return `<section class="section" style="padding-top:44px"><div class="container"><div class="section-head"><div><span class="tag-label">Catálogo</span><h2>Explorar projetos</h2><p>Descubra o que criadores de todo o Brasil estão construindo agora.</p></div></div><div class="filters-bar" style="margin-bottom: 32px;"><input id="searchInput" class="search-input" type="search" placeholder="Buscar projetos por nome ou descrição…" value="${escapeHtml(params.q || "")}"></div>${categoriesHtml || emptyState("Nenhum projeto encontrado", "Tente ajustar a busca.")}</div></section>`;
  }

  function projectCard(p) {
    const img = p.images && p.images[0];
    return `<a href="#/projeto/${p.id}" class="project-card"><div class="pc-thumb">${img ? `<img src="${img}" alt="${escapeHtml(p.title)}" loading="lazy">` : ""}<span class="pc-cat">${escapeHtml(categoryName(p.categoryId))}</span></div><div class="pc-body"><h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.description)}</p><div class="pc-meta"><span class="author"><span class="pc-mini-avatar">${initials(p.ownerName)}</span>${escapeHtml(p.ownerName)}</span><span>${fmtDate(p.createdAt)}</span></div></div></a>`;
  }

  function viewProjectDetail(id) {
    const p = db.projects.find((pj) => pj.id === id); if (!p) return view404(); 
    const img = (p.images && p.images[0]) || "";
    const user = currentUser();

    const projectReviews = p.reviews || [];
    const avgRating = projectReviews.length ? (projectReviews.reduce((acc, r) => acc + r.rating, 0) / projectReviews.length).toFixed(1) : 0;
    const hasRated = user ? projectReviews.some(r => r.userId === user.id) : false;

    let starsHtml = "";
    for (let i = 1; i <= 5; i++) {
      starsHtml += getStarSvg(18, i <= Math.round(avgRating));
    }

    let reviewsListHtml = projectReviews.map(r => {
      let rStars = "";
      for (let i = 1; i <= 5; i++) {
        rStars += getStarSvg(14, i <= r.rating);
      }
      return `
      <div style="background: rgba(255,255,255,0.03); padding: 16px; border-radius: 12px; margin-bottom: 12px; border: 1px solid var(--border-color, rgba(255,255,255,0.05));">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <strong style="font-size: 14px; color: var(--text-main);">${escapeHtml(r.userName)}</strong>
          <div style="display: flex; align-items: center; gap: 2px;">${rStars}</div>
        </div>
        <p style="font-size: 14.5px; color: var(--ink-700); margin: 0; line-height: 1.5;">${escapeHtml(r.comment)}</p>
        <span style="font-size: 11px; color: var(--ink-300); display: block; margin-top: 8px;">${fmtDate(r.createdAt)}</span>
      </div>
      `;
    }).join("");

    if (projectReviews.length === 0) {
      reviewsListHtml = `<p class="muted" style="font-size: 14px; text-align: center; padding: 20px 0;">Ainda não há avaliações. Seja o primeiro a avaliar este projeto!</p>`;
    }

    const reviewLabel = projectReviews.length === 1 ? "avaliação" : "avaliações";

    let reviewFormHtml = "";
    if (!user) {
      reviewFormHtml = `<div class="panel text-center mt-3"><p class="muted">Faça login para avaliar.</p><a href="login.html?redirect=projeto/${p.id}" class="btn btn-ghost btn-sm mt-2">Entrar</a></div>`;
    } else if (hasRated) {
      reviewFormHtml = `<div class="panel text-center mt-3" style="border-color: var(--green-700);"><p style="color: var(--green-700); font-weight: 600; margin: 0;">✓ Você já avaliou este projeto.</p></div>`;
    } else if (user.id === p.ownerId) {
      reviewFormHtml = `<div class="panel text-center mt-3"><p class="muted" style="margin: 0;">Você não pode avaliar o seu próprio projeto.</p></div>`;
    } else {
      reviewFormHtml = `
        <form id="projectReviewForm" data-project="${p.id}" class="panel mt-3" style="background: var(--bg-card);">
          <h4 style="margin-bottom: 12px;">Deixe sua avaliação</h4>
          <div style="margin-bottom: 16px;">
            <label class="muted" style="font-size: 12px; display: block; margin-bottom: 4px;">Nota (Estrelas)</label>
            <div id="starRatingInput" style="display: flex; gap: 8px; cursor: pointer;">
              <span data-val="1">${getStarSvg(32, false)}</span>
              <span data-val="2">${getStarSvg(32, false)}</span>
              <span data-val="3">${getStarSvg(32, false)}</span>
              <span data-val="4">${getStarSvg(32, false)}</span>
              <span data-val="5">${getStarSvg(32, false)}</span>
            </div>
            <input type="hidden" name="rating" id="projectRatingVal" value="0" required>
          </div>
          <div class="field">
            <label>Comentário</label>
            <textarea name="comment" rows="3" required placeholder="Conte à comunidade o que achou deste projeto..."></textarea>
          </div>
          <button type="submit" class="btn btn-primary btn-block">Enviar Avaliação</button>
        </form>
      `;
    }

    return `
    <div class="project-detail container">
      <div class="breadcrumb">
        <a href="#/explorar">Explorar</a> / ${escapeHtml(categoryName(p.categoryId))} / <span class="muted">Detalhes</span>
      </div>
      
      <div style="margin-bottom: 24px; max-width: 760px;">
        <span class="pd-cat-badge">${escapeHtml(categoryName(p.categoryId))}</span>
        <div style="margin-top: 14px;">
          <span class="muted" style="font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; font-family: var(--font-mono);">Título</span>
          <h1 class="pd-title" style="margin-top: 4px; margin-bottom: 8px;">${escapeHtml(p.title)}</h1>
          
          <!-- ESTRELAS NO TOPO -->
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
            <div style="display: flex;">${starsHtml}</div>
            <span style="font-size: 14px; color: var(--ink-700); font-weight: 600;">${avgRating} <span style="font-weight: 400;">(${projectReviews.length} ${reviewLabel})</span></span>
          </div>
        </div>
      </div>

      <div class="pd-grid">
        <div class="pd-main">
          <div class="pd-gallery">${img ? `<img src="${img}" alt="${escapeHtml(p.title)}">` : `<span class="muted">Sem imagem</span>`}</div>
          ${p.images && p.images.length > 1 ? `<div class="pd-thumbs">${p.images.map((im, i) => `<img src="${im}" class="${i === 0 ? "active" : ""}" alt="">`).join("")}</div>` : ""}
          
          <div style="margin-top: 32px;">
            <span class="muted" style="font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; font-family: var(--font-mono);">Descrição</span>
            <div class="pd-desc" style="margin-top: 8px; font-size: 15.5px; line-height: 1.7;">${escapeHtml(p.description)}</div>
          </div>

          <!-- BLOCO DE AVALIAÇÕES (REVIEWS) -->
          <div style="margin-top: 48px; border-top: 1px solid var(--border-color, rgba(255,255,255,0.08)); padding-top: 32px;">
            <h3 style="margin-bottom: 20px; font-size: 20px;">Avaliações do Projeto</h3>
            <div id="reviewsContainer">
              ${reviewsListHtml}
            </div>
            ${reviewFormHtml}
          </div>
        </div>
        
        <aside class="pd-side">
          <h4>Sobre o projeto</h4>
          <div class="pd-row"><span>Responsável</span><span>${escapeHtml(p.ownerName)}</span></div>
          <div class="pd-row"><span>Contato</span><span>${escapeHtml(p.contact)}</span></div>
          <div class="pd-row"><span>Categoria</span><span>${escapeHtml(categoryName(p.categoryId))}</span></div>
          <div class="pd-row"><span>Publicado em</span><span>${fmtDate(p.createdAt)}</span></div>
          <a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-block" style="margin-top: 16px;">Acessar projeto ↗</a>
          <button type="button" class="btn btn-outline-gold btn-block" style="margin-top:8px" onclick="compartilharConteudo('${escapeHtml(p.title)}', 'Olha esse projeto na plataforma:', location.origin + '/#/projeto/' + '${p.id}')">Compartilhar projeto</button>
        </aside>
      </div>
    </div>`;
  }

  function viewPublish(params) {
    const user = currentUser();
    if (!canPublish(user)) return `<div class="auth-shell"><div class="auth-card text-center"><h2>Assinatura necessária</h2><p class="sub">Para publicar projetos na plataforma, você precisa de uma assinatura ativa.</p><a href="#/planos" class="btn btn-gold btn-block">Ver planos de assinatura</a></div></div>`;
    let editProj = null; if (params && params.edit) editProj = db.projects.find(p => p.id === params.edit && p.ownerId === user.id);
    const isEdit = !!editProj;
    const titleVal = editProj ? escapeHtml(editProj.title) : ""; const descVal = editProj ? escapeHtml(editProj.description) : ""; const linkVal = editProj ? escapeHtml(editProj.link) : ""; const catIdVal = editProj ? editProj.categoryId : ""; const ownerNameVal = editProj ? escapeHtml(editProj.ownerName) : escapeHtml(user.name); const contactVal = editProj ? escapeHtml(editProj.contact) : escapeHtml(user.email);
    return `<section class="section" style="padding-top:44px;max-width:720px;margin:0 auto"><div class="container"><span class="tag-label">${isEdit ? "Revisão de Projeto" : "Novo projeto"}</span><h2 style="margin-bottom:6px">${isEdit ? "Editar e Reenviar Projeto" : "Publicar projeto"}</h2>${user.role === "admin" ? `<p class="field-hint" style="margin-bottom:20px">Você está publicando como administrador — não é necessário ter assinatura ativa.</p>` : `<div style="margin-bottom:26px"></div>`}${isEdit ? `<div class="badge badge-warning" style="margin-bottom: 20px; display: inline-block;">Corrija as informações abaixo para reenviar seu projeto.</div>` : `<p class="field-hint" style="margin-bottom:20px">Todas as postagens passam por revisão antes de serem publicadas na vitrine.</p>`}<form id="publishForm" class="panel">${isEdit ? `<input type="hidden" name="editingProjectId" value="${escapeHtml(editProj.id)}">` : ""}<div class="field"><label>Nome do projeto</label><input name="title" required placeholder="Ex.: Nimbus — painel financeiro" value="${titleVal}"></div><div class="field"><label>Descrição</label><textarea name="description" rows="5" required placeholder="Conte o que é, para quem serve e o que torna especial.">${descVal}</textarea></div><div class="field"><label>Categoria</label><select name="categoryId" required><option value="">Selecione…</option>${db.categories.map((c) => `<option value="${c.id}" ${c.id === catIdVal ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join("")}</select></div><div class="field"><label>Link do projeto</label><input name="link" type="url" required placeholder="https://" value="${linkVal}"></div><div class="field"><label>Nome do responsável</label><input name="ownerName" required value="${ownerNameVal}"></div><div class="field"><label>Forma de contato</label><input name="contact" required placeholder="E-mail ou telefone (WhatsApp)" value="${contactVal}"></div><div class="field"><label>Imagens do projeto ${isEdit ? "(Envie as imagens novamente)" : ""}</label><input type="file" id="imageInput" accept="image/*" multiple><div class="field-hint">Envie até 4 imagens do seu projeto.</div><div class="upload-preview" id="uploadPreview"></div></div><div class="field-error" id="publishError"></div><button class="btn btn-primary btn-block" type="submit">${isEdit ? "Reenviar Projeto" : "Publicar projeto"}</button></form></div></section>`;
  }

  function viewCommunity() {
    const user = currentUser(); const posts = db.posts.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `<section class="section" style="padding-top:44px"><div class="container community-layout"><div><span class="tag-label">Comunidade</span><h2 style="margin-bottom:22px">Converse com outros criadores</h2>${user ? `<div class="composer"><textarea id="postInput" placeholder="Compartilhe uma novidade, peça feedback ou converse sobre a plataforma…"></textarea><div class="composer-foot"><span class="muted" style="font-size:12.5px">Publicando como ${escapeHtml(user.name)}</span><button class="btn btn-primary btn-sm" id="postSubmit">Publicar</button></div></div>` : `<div class="panel text-center"><p class="muted">Entre na sua conta para participar da comunidade.</p><a href="login.html?redirect=comunidade" class="btn btn-ghost btn-sm mt-2">Entrar</a></div>`}<div id="postsList">${posts.map((p) => { const author = userById(p.authorId); return `<article class="post-card" data-post="${p.id}"><div class="post-head"><div class="post-author"><span class="pc-mini-avatar" style="background:${author ? author.avatarColor : "#888"};width:34px;height:34px;font-size:13px">${initials(author ? author.name : "?")}</span><div><strong>${escapeHtml(author ? author.name : "Usuário removido")}</strong><br><span>${fmtDateTime(p.createdAt)}</span></div></div>${author && author.role === "admin" ? `<span class="badge badge-blue">Equipe</span>` : ""}</div><div class="post-body">${escapeHtml(p.content)}</div><div class="post-actions"><button class="comment-toggle" data-post="${p.id}">💬 ${p.comments.length} comentário(s)</button></div><div class="comment-section" data-post-comments="${p.id}" style="display:none"><div class="comment-list">${p.comments.map((c) => { const cAuth = userById(c.authorId); return `<div class="comment" data-comment="${c.id}"><span class="pc-mini-avatar" style="background:${cAuth ? cAuth.avatarColor : "#888"}">${initials(cAuth ? cAuth.name : "?")}</span><div style="flex:1"><div class="comment-body"><strong>${escapeHtml(cAuth ? cAuth.name : "Usuário removido")}</strong><p>${escapeHtml(c.content)}</p></div><div class="post-actions" style="border:none;padding-top:6px"><button class="reply-toggle" data-post="${p.id}" data-comment="${c.id}">Responder</button><span class="muted">${fmtDateTime(c.createdAt)}</span></div><div class="reply-list">${(c.replies || []).map((r) => { const rAuth = userById(r.authorId); return `<div class="comment"><span class="pc-mini-avatar" style="background:${rAuth ? rAuth.avatarColor : "#888"}">${initials(rAuth ? rAuth.name : "?")}</span><div class="comment-body"><strong>${escapeHtml(rAuth ? rAuth.name : "Usuário removido")}</strong><p>${escapeHtml(r.content)}</p></div></div>`; }).join("")}</div><form class="comment-reply-form" data-post="${p.id}" data-comment="${c.id}" style="display:none"><input type="text" placeholder="Escreva uma resposta…" required><button class="btn btn-sm btn-primary" type="submit">Enviar</button></form></div></div>`; }).join("")}</div><form class="comment-reply-form comment-new-form" data-post="${p.id}" style="margin-top:12px"><input type="text" placeholder="Escreva um comentário…" required><button class="btn btn-sm btn-primary" type="submit">Comentar</button></form></div></article>`; }).join("") || emptyState("Ainda não há publicações", "Seja a primeira pessoa a iniciar uma conversa.")}</div></div><aside><div class="side-card"><h4>Boas práticas</h4><p>Seja respeitoso, evite spam e mantenha o foco em projetos, feedback e aprendizado. Publicações ofensivas podem ser removidas pela moderação.</p></div><div class="side-card"><h4>Estatísticas</h4><p>${db.posts.length} publicações · ${db.publicProfiles.length} membros na comunidade.</p></div></aside></div></section>`;
  }

  function viewPlans() {
    const user = currentUser(); const active = isSubscriptionActive(user);
    return `<section class="section" style="padding-top:52px"><div class="container text-center" style="margin-bottom:44px"><span class="tag-label">Planos de assinatura</span><h2>Assine para publicar seus projetos</h2><p class="muted" style="max-width:520px;margin:12px auto 0">Contas gratuitas podem visualizar todos os projetos. Para publicar, escolha um plano abaixo.</p>${user && user.role === "admin" ? "" : active ? `<div class="badge badge-success mt-2">Assinatura ativa até ${fmtDate(user.subscription.expiresAt)}</div>` : user ? `<div class="badge badge-danger mt-2">Você ainda não tem assinatura ativa</div>` : ""}</div><div class="container"><div class="plans-grid"><div class="plan-card card-teste"><span class="plan-name">Plano Teste</span><div class="plan-price">R$ 5<span>,00</span></div><div class="plan-duration">Válido por 2 dias</div><ul class="plan-features"><li>Permite publicar projetos</li><li>Acesso à área de publicação</li><li>Expira automaticamente após 2 dias</li></ul><button class="btn btn-teste btn-block" data-plan="pTeste">Assinar plano teste</button></div><div class="plan-card card-4dias"><span class="plan-name">Plano 4 dias</span><div class="plan-price">R$ 10<span>,00</span></div><div class="plan-duration">Publicação ativa por 4 dias</div><ul class="plan-features"><li>Publique projetos ilimitados no período</li><li>Página individual para cada projeto</li><li>Participação na comunidade</li><li>Programa de indicação incluso</li></ul><button class="btn btn-4dias btn-block" data-plan="p4">Assinar plano 4 dias</button></div><div class="plan-card featured"><span class="plan-name">Plano 7 dias</span><div class="plan-price">R$ 20<span>,00</span></div><div class="plan-duration">Publicação ativa por 7 dias</div><ul class="plan-features"><li>Publique projetos ilimitados no período</li><li>Página individual para cada projeto</li><li>Participação na comunidade</li><li>Programa de indicação incluso</li><li>Mais tempo de visibilidade</li></ul><button class="btn btn-gold btn-block" data-plan="p7">Assinar plano 7 dias</button></div><div class="plan-card card-mensal"><span class="plan-name">Plano Mensal</span><div class="plan-price">R$ 50<span>,00</span></div><div class="plan-duration">Válido por 30 dias</div><ul class="plan-features"><li>Permite publicar projetos durante todo o período</li><li>Acesso completo à área de publicação</li><li>Expira automaticamente após 30 dias</li></ul><button class="btn btn-mensal btn-block" data-plan="pMensal">Assinar plano mensal</button></div></div></div></section>`;
  }

  function view404() { return `<div class="section text-center"><div class="container"><h2>Página não encontrada</h2><p class="muted mt-1">O endereço acessado não existe.</p><a href="#/" class="btn btn-primary mt-3">Voltar para o início</a></div></div>`; }

  function notificationCard(n) {
    let color = "var(--ink-700)"; let border = n.read ? "1px solid var(--ink-200)" : "1px solid var(--gold-400)"; let title = "Notificação";
    if (n.message.includes("reprovado") || n.message.includes("não foi aprovado") || n.message.includes("ATENÇÃO")) { color = "var(--red-600)"; title = "Ação Necessária"; } else if (n.message.includes("aprovado") || n.message.includes("sucesso") || n.message.includes("disponível") || n.message.includes("Parabéns")) { color = "var(--green-700)"; title = "Aprovado"; }
    let msgHtml = escapeHtml(n.message); let actionBtn = "";
    if (n.projectId && (n.message.includes("ATENÇÃO") || n.message.includes("reprovado"))) { actionBtn = `<a href="#/publicar?edit=${n.projectId}" class="btn btn-sm btn-primary mt-2" style="display:inline-block">Editar e reenviar projeto</a>`; }
    return `<div class="panel" data-notification="${n.id}" style="border:${border};padding:16px 18px;margin-bottom:10px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;"><div style="flex:1"><div style="font-weight:600;font-size:13px;color:${color};margin-bottom:4px">${title}</div><p style="font-size:13.5px;color:var(--ink-700);line-height:1.4;word-break:break-word;">${msgHtml}</p>${actionBtn}</div>${n.read ? "" : `<button class="btn btn-sm btn-ghost" data-mark-read="${n.id}" style="flex:none">Marcar lida</button>`}</div><span class="muted" style="font-size:12px;display:block;margin-top:10px" title="${fmtDateTime(n.createdAt)}">${timeAgo(n.createdAt)}</span></div>`;
  }

  function viewDashboard() {
    const user = currentUser(); const myProjects = db.projects.filter((p) => p.ownerId === user.id); const active = isSubscriptionActive(user);
    const allNotifications = myNotifications(user.id); const unreadCount = allNotifications.filter((n) => !n.read).length;
    let notifHtml = "";
    if (allNotifications.length > 0) {
       const topNotifs = allNotifications.slice(0, 5); const hasMore = allNotifications.length > 5;
       notifHtml = `<div class="panel" id="notificationsSection" style="margin-bottom:22px"><div class="panel-head"><div style="display:flex;align-items:center;gap:8px"><h3>Notificações</h3>${unreadCount > 0 ? `<span class="badge badge-danger">${unreadCount} não lida(s)</span>` : ""}</div>${unreadCount > 0 ? `<button class="btn btn-sm btn-ghost" id="markAllReadBtn">Marcar todas como lidas ✓</button>` : ""}</div><div id="notifListContainer">${topNotifs.map(notificationCard).join("")}</div>${hasMore ? `<button class="btn btn-sm btn-ghost btn-block mt-2" id="showAllNotifsBtn">Ver todas as ${allNotifications.length} notificações</button>` : ""}<div id="allNotifsContainer" style="display:none">${allNotifications.slice(5).map(notificationCard).join("")}</div></div>`;
    }
    return `<div class="dash-shell"><nav class="dash-sidebar">${sideNav("/painel")}</nav><div class="dash-main"><div class="dash-head"><div><h1 style="word-break:break-word;">Olá, ${escapeHtml(user.name.split(" ")[0])}</h1><p>Aqui está um resumo da sua conta em Compartilhar Projetos.</p></div><a href="#/publicar" class="btn btn-gold" style="white-space:nowrap">+ Publicar projeto</a></div>${notifHtml}<div class="stat-grid"><div class="stat-card"><div class="stat-label">Status da assinatura</div><div class="stat-value" style="font-size:16px">${user.role === "admin" ? `<span class="badge badge-blue">Administrador</span>` : active ? `<span class="badge badge-success">Ativa</span>` : `<span class="badge badge-danger">Expirada</span>`}</div></div><div class="stat-card"><div class="stat-label">Projetos publicados</div><div class="stat-value">${myProjects.filter((p) => p.status === "published").length}</div></div><div class="stat-card gold"><div class="stat-label">Comissões disponíveis</div><div class="stat-value">${fmtBRL(availableCommission(user.id))}</div></div><div class="stat-card"><div class="stat-label">Indicações</div><div class="stat-value">${db.referrals.filter((r) => r.referrerId === user.id).length}</div></div></div><div class="panel"><div class="panel-head"><h3>Seus projetos</h3><a href="#/publicar" class="link">Publicar novo →</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Projeto</th><th>Categoria</th><th>Status</th><th>Ações</th></tr></thead><tbody>${myProjects.map((p) => { 
      let badge = ''; let action = `<a href="#/projeto/${p.id}" class="link">Acessar ↗</a>`; 
      if (p.status === 'published') { 
        badge = '<span class="badge badge-success">Aprovado</span>'; 
        action = `<a href="#/projeto/${p.id}" class="link">Acessar ↗</a> | <a href="#/publicar?edit=${p.id}" class="link" style="color:var(--gold-500)">Editar</a>`;
      } else if (p.status === 'rejected') { 
        badge = '<span class="badge badge-danger">Rejeitado</span>'; 
        action = `<span class="muted">Veja o motivo em Notificações</span> | <a href="#/publicar?edit=${p.id}" class="link" style="color:var(--gold-500)">Editar</a>`; 
      } else { 
        badge = '<span class="badge badge-warning">Em Revisão</span>'; 
        action = `<span class="muted">Aguardando aprovação...</span>`; 
      } 
      return `<tr><td><strong>${escapeHtml(p.title)}</strong></td><td>${escapeHtml(categoryName(p.categoryId))}</td><td>${badge}</td><td>${action}</td></tr>`; 
    }).join("") || `<tr><td colspan="4" class="muted text-center">Você ainda não publicou nenhum projeto.</td></tr>`}</tbody></table></div></div>${!active && user.role !== "admin" ? `<div class="panel" style="border-color:var(--gold-400)"><div class="panel-head"><h3>Sua assinatura expirou</h3></div><p class="muted">Renove seu plano para voltar a publicar novos projetos.</p><a href="#/planos" class="btn btn-gold mt-2">Ver planos</a></div>` : ""}</div></div>`;
  }

  function viewProfile() {
    const user = currentUser();
    return `<div class="dash-shell"><nav class="dash-sidebar">${sideNav("/perfil")}</nav><div class="dash-main"><div class="dash-head"><div><h1>Meu perfil</h1><p>Gerencie suas informações pessoais.</p></div></div><div class="panel" style="max-width:560px"><form id="profileForm"><div class="field"><label>Nome completo</label><input name="name" value="${escapeHtml(user.name)}" required></div><div class="field"><label>E-mail</label><input value="${escapeHtml(user.email)}" disabled></div><div class="field"><label>CPF ou CNPJ</label><input name="document" value="${escapeHtml(user.document || "")}" placeholder="Somente números" inputmode="numeric"></div><div class="field"><label>Sobre você</label><textarea name="bio" rows="3" placeholder="Fale um pouco sobre o que você cria.">${escapeHtml(user.bio || "")}</textarea></div><button class="btn btn-primary" type="submit">Salvar alterações</button></form></div><div class="panel"><div class="panel-head"><h3>Status da conta</h3></div><div class="pd-row"><span>Papel</span><span>${user.role === "admin" ? "Administrador" : "Usuário"}</span></div><div class="pd-row"><span>Assinatura</span><span>${isSubscriptionActive(user) ? "Ativa até " + fmtDate(user.subscription.expiresAt) : "Expirada / inexistente"}</span></div><div class="pd-row"><span>Membro desde</span><span>${fmtDate(user.createdAt)}</span></div></div></div></div>`;
  }

  function viewReferrals() {
    const user = currentUser(); const link = `${location.origin}${location.pathname.replace(/index\.html$/, "")}register.html?ref=${user.refCode}`;
    const myRefs = db.referrals.filter((r) => r.referrerId === user.id); const commissions = db.commissions.filter((c) => c.referrerId === user.id);
    return `<div class="dash-shell"><nav class="dash-sidebar">${sideNav("/indicacoes")}</nav><div class="dash-main"><div class="dash-head"><div><h1>Programa de indicação</h1><p>Indique pessoas e ganhe ${Math.round(COMMISSION_RATE * 100)}% de comissão em cada assinatura realizada.</p></div></div><div class="ref-link-box mt-1" style="margin-bottom:30px"><code id="refLinkText">${link}</code><button class="btn btn-outline-gold btn-sm" id="copyRefLink" style="border-color:var(--gold-500);color:var(--gold-300,#f0d97a)">Copiar link</button></div><div class="stat-grid"><div class="stat-card"><div class="stat-label">Total de indicações</div><div class="stat-value">${myRefs.length}</div></div><div class="stat-card"><div class="stat-label">Comissões pendentes</div><div class="stat-value">${fmtBRL(pendingCommission(user.id))}</div></div><div class="stat-card gold"><div class="stat-label">Comissões disponíveis</div><div class="stat-value">${fmtBRL(availableCommission(user.id))}</div></div><div class="stat-card"><div class="stat-label">Ganhos totais</div><div class="stat-value">${fmtBRL(totalEarnings(user.id))}</div></div></div><div class="panel"><div class="panel-head"><h3>Solicitar saque</h3></div><p class="muted mt-1">Saque mínimo de ${fmtBRL(MIN_WITHDRAW)}. Saldo disponível: <strong>${fmtBRL(availableCommission(user.id))}</strong></p><form id="withdrawForm" class="mt-2" style="max-width:360px"><div class="field"><label>Valor do saque</label><input type="number" min="${MIN_WITHDRAW}" step="0.01" name="amount" placeholder="Ex.: 15,00" required></div><div class="field"><label>Chave Pix</label><input type="text" name="pixKey" placeholder="CPF, e-mail, telefone ou chave aleatória" value="${escapeHtml(lastPixKey(user.id))}" required></div><button class="btn btn-gold btn-block" type="submit">Solicitar saque</button></form></div><div class="panel"><div class="panel-head"><h3>Histórico de ganhos</h3></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Data</th><th>Indicado</th><th>Plano</th><th>Valor</th><th>Status</th></tr></thead><tbody>${commissions.map((c) => { const ref = userById(c.referredId); const label = { pending: ["badge-warning", "Pendente"], available: ["badge-success", "Disponível"], paid: ["badge-neutral", "Pago"] }[c.status]; return `<tr><td>${fmtDate(c.createdAt)}</td><td>${escapeHtml(ref ? ref.name : "—")}</td><td>${escapeHtml(PLANS[c.planId] ? PLANS[c.planId].name : "—")}</td><td>${fmtBRL(c.amount)}</td><td><span class="badge ${label[0]}">${label[1]}</span></td></tr>`; }).join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma comissão registrada ainda.</td></tr>`}</tbody></table></div></div><div class="panel"><div class="panel-head"><h3>Solicitações de saque</h3></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Data</th><th>Valor</th><th>Chave Pix</th><th>Status</th></tr></thead><tbody>${db.withdrawals.filter((w) => w.userId === user.id).map((w) => { const label = { pending: ["badge-warning", "Em análise"], approved: ["badge-success", "Aprovado"], rejected: ["badge-danger", "Recusado"] }[w.status]; return `<tr><td>${fmtDate(w.createdAt)}</td><td>${fmtBRL(w.amount)}</td><td>${escapeHtml(w.pixKey || "—")}</td><td><span class="badge ${label[0]}">${label[1]}</span></td></tr>`; }).join("") || `<tr><td colspan="4" class="muted text-center">Nenhum saque solicitado.</td></tr>`}</tbody></table></div></div></div></div>`;
  }

  function viewPlatformReview() {
    const user = currentUser();
    const platformReviews = (db && db.platformReviews) ? db.platformReviews : [];
    const userReview = user ? platformReviews.find(r => r.userId === user.id) : null;
    let contentHtml = "";

    if (!user) {
      contentHtml = `<div class="panel text-center"><p class="muted">Você precisa entrar na sua conta para avaliar a plataforma.</p><a href="login.html?redirect=avaliar" class="btn btn-gold btn-sm mt-2">Entrar na conta</a></div>`;
    } else if (userReview) {
      contentHtml = `<div class="panel text-center" style="border-color: var(--green-700); padding: 40px 20px;"><div style="font-size: 48px; margin-bottom: 16px;">🎉</div><h3 style="color: var(--text-main); margin-bottom: 8px;">Avaliação recebida!</h3><p style="color: var(--green-700); font-weight: 600; font-size: 16px; margin: 0;">✓ Você já avaliou a plataforma.</p><div style="margin-top: 16px; display: inline-flex; gap: 4px;">${getStarSvg(24, userReview.overallRating >= 1)}${getStarSvg(24, userReview.overallRating >= 2)}${getStarSvg(24, userReview.overallRating >= 3)}${getStarSvg(24, userReview.overallRating >= 4)}${getStarSvg(24, userReview.overallRating >= 5)}</div><p class="muted" style="margin-top: 24px;">Obrigado por ajudar a construir um Compartilhar Projetos melhor!</p><a href="#/" class="btn btn-primary mt-3">Voltar ao início</a></div>`;
    } else {
      contentHtml = `<form id="platformReviewForm" class="panel"><div class="field" style="margin-bottom: 32px;"><label style="font-size: 15.5px; font-weight: 600; color: var(--text-main);">1. Como você avalia sua experiência geral?</label><div id="platformRatingStars" style="display: flex; gap: 12px; cursor: pointer; margin-top: 12px;"><span data-val="1">${getStarSvg(36, false)}</span><span data-val="2">${getStarSvg(36, false)}</span><span data-val="3">${getStarSvg(36, false)}</span><span data-val="4">${getStarSvg(36, false)}</span><span data-val="5">${getStarSvg(36, false)}</span></div><input type="hidden" name="overallRating" id="overallRatingVal" value="0" required></div><div class="field" style="margin-bottom: 32px;"><label style="font-size: 15.5px; font-weight: 600; color: var(--text-main);">2. Quão fácil é publicar e explorar projetos?</label><select name="usabilityScore" required style="margin-top: 12px; width: 100%; padding: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: var(--text-main); font-size: 15px;"><option value="" style="color: #000;">Selecione...</option><option value="very_easy" style="color: #000;">Muito fácil</option><option value="easy" style="color: #000;">Fácil</option><option value="neutral" style="color: #000;">Razoável</option><option value="hard" style="color: #000;">Difícil</option><option value="very_hard" style="color: #000;">Muito difícil</option></select></div><div class="field" style="margin-bottom: 32px;"><label style="font-size: 15.5px; font-weight: 600; color: var(--text-main);">3. Você recomendaria a plataforma para outros desenvolvedores e designers?</label><div style="display: flex; flex-wrap: wrap; gap: 24px; margin-top: 16px;"><label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; color: var(--text-main); font-size: 15px;"><input type="radio" name="wouldRecommend" value="yes" required style="width: 20px; height: 20px; accent-color: var(--gold-500);"> Sim</label><label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; color: var(--text-main); font-size: 15px;"><input type="radio" name="wouldRecommend" value="maybe" style="width: 20px; height: 20px; accent-color: var(--gold-500);"> Talvez</label><label style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; color: var(--text-main); font-size: 15px;"><input type="radio" name="wouldRecommend" value="no" style="width: 20px; height: 20px; accent-color: var(--gold-500);"> Não</label></div></div><div class="field" style="margin-bottom: 32px;"><label style="font-size: 15.5px; font-weight: 600; color: var(--text-main);">4. O que podemos melhorar?</label><textarea name="feedbackText" rows="4" placeholder="Deixe sugestões de novas funcionalidades, críticas ou elogios..." style="margin-top: 12px; width: 100%; padding: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: var(--text-main); font-family: inherit; font-size: 15px; resize: vertical;"></textarea></div><div class="field-error" id="platformReviewError" style="display: none; margin-bottom: 16px;"></div><button type="submit" class="btn btn-gold btn-block" style="padding: 16px; font-size: 16px; font-weight: 600;">Enviar Avaliação</button></form>`;
    }

    return `<section class="section" style="padding-top: 52px; max-width: 680px; margin: 0 auto;"><div class="container"><span class="tag-label">Feedback</span><h2 style="margin-bottom: 6px;">Avalie a Plataforma</h2><p class="muted" style="margin-bottom: 32px;">Sua opinião ajuda a melhorar o Compartilhar Projetos para toda a comunidade de criadores.</p>${contentHtml}</div></section>`;
  }

  // =========================================================
  // EVENTOS DAS PÁGINAS
  // =========================================================
  function bindPageEvents(path) {
    qsa("[data-mark-read]").forEach((btn) => { btn.addEventListener("click", () => { const id = btn.getAttribute("data-mark-read"); btn.disabled = true; markNotificationRead(id).catch((err) => { toast(err.message || "Não foi possível marcar como lida.", "error"); btn.disabled = false; }); }); });
    const markAllBtn = qs("#markAllReadBtn"); if (markAllBtn) { markAllBtn.addEventListener("click", () => { markAllBtn.disabled = true; const unreadNotifs = myNotifications(currentUser().id).filter(n => !n.read); Promise.all(unreadNotifs.map(n => markNotificationRead(n.id))).then(() => { toast("Todas as notificações marcadas como lidas!", "success"); }).catch(err => { toast("Erro ao marcar notificações.", "error"); markAllBtn.disabled = false; }); }); }
    const showAllBtn = qs("#showAllNotifsBtn"); if (showAllBtn) { showAllBtn.addEventListener("click", () => { qs("#allNotifsContainer").style.display = "block"; showAllBtn.style.display = "none"; }); }

    const search = qs("#searchInput"); const catFilter = qs("#catFilter");
    if (search) search.addEventListener("input", debounce(() => updateExploreQuery(), 350));
    if (catFilter) catFilter.addEventListener("change", () => updateExploreQuery());

    qsa("[data-plan]").forEach((btn) => { btn.addEventListener("click", async () => { if (!currentUser()) { location.href = "login.html?redirect=planos"; return; } const planId = btn.getAttribute("data-plan"); const originalText = btn.textContent; try { btn.disabled = true; let doc = currentUser().document; if (!doc) { doc = await showDocumentModal(); } btn.textContent = "Gerando Pix..."; const result = await startPixPayment(planId, doc); showPixModal(result); } catch (err) { if (err.message !== "cancelado") toast(err.message, "error"); } finally { btn.disabled = false; btn.textContent = originalText; } }); });

    const publishForm = qs("#publishForm");
    if (publishForm) {
      const imageInput = qs("#imageInput"); pendingImages = [];
      if (imageInput) { imageInput.addEventListener("change", async () => { const files = Array.from(imageInput.files).slice(0, 4); pendingImages = []; for (const f of files) { const durl = await fileToDataURL(f); pendingImages.push(durl); } renderUploadPreview(); }); }
      publishForm.addEventListener("submit", (e) => { e.preventDefault(); const fd = new FormData(publishForm); qs("#publishError").style.display = "none"; const editingProjectId = fd.get("editingProjectId"); const payload = { title: fd.get("title"), description: fd.get("description"), categoryId: fd.get("categoryId"), link: fd.get("link"), ownerName: fd.get("ownerName"), contact: fd.get("contact"), images: pendingImages }; Promise.resolve().then(() => editingProjectId ? resendProject(editingProjectId, payload) : publishProject(payload)).then((project) => { toast(editingProjectId ? "Projeto reenviado com sucesso!" : "Projeto enviado com sucesso!", "success"); navigate("/painel"); }).catch((err) => { qs("#publishError").textContent = err.message; qs("#publishError").style.display = "block"; }); });
    }

    const postSubmit = qs("#postSubmit"); if (postSubmit) { postSubmit.addEventListener("click", () => { const input = qs("#postInput"); Promise.resolve().then(() => createPost(input.value)).then(() => { navigate("/comunidade"); }).catch((err) => toast(friendlyError(err, "Sem links na comunidade."), "error")); }); }
    qsa(".comment-toggle").forEach((btn) => { btn.addEventListener("click", () => { const sec = qs(`[data-post-comments="${btn.getAttribute("data-post")}"]`); sec.style.display = sec.style.display === "none" ? "block" : "none"; }); });
    qsa(".reply-toggle").forEach((btn) => { btn.addEventListener("click", () => { const form = qs(`.comment-reply-form[data-post="${btn.getAttribute("data-post")}"][data-comment="${btn.getAttribute("data-comment")}"]`); form.style.display = form.style.display === "none" ? "flex" : "none"; }); });
    qsa(".comment-new-form").forEach((form) => { form.addEventListener("submit", (e) => { e.preventDefault(); const input = form.querySelector("input"); Promise.resolve().then(() => createComment(form.getAttribute("data-post"), input.value)).then(() => render({ navigation: false })).catch((err) => toast(friendlyError(err, "Sem links."), "error")); }); });
    qsa(".comment-reply-form:not(.comment-new-form)").forEach((form) => { form.addEventListener("submit", (e) => { e.preventDefault(); const input = form.querySelector("input"); Promise.resolve().then(() => createReply(form.getAttribute("data-post"), form.getAttribute("data-comment"), input.value)).then(() => render({ navigation: false })).catch((err) => toast(friendlyError(err, "Sem links."), "error")); }); });

    const profileForm = qs("#profileForm");
    if (profileForm) { profileForm.addEventListener("submit", (e) => { e.preventDefault(); const fd = new FormData(profileForm); const user = currentUser(); const rawDoc = fd.get("document"); const digits = onlyDigits(rawDoc); if (digits && !isValidDocument(digits)) { toast("CPF/CNPJ inválido.", "error"); return; } updateUserProfile(user.id, { name: fd.get("name").trim() || user.name, bio: sanitizeText(fd.get("bio") || ""), document: digits || user.document || "", }).then(() => toast("Perfil atualizado!", "success")).catch((err) => toast(err.message, "error")); }); }

    const copyBtn = qs("#copyRefLink"); 
    if (copyBtn) { 
        copyBtn.addEventListener("click", () => { 
            const linkText = qs("#refLinkText").textContent;
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            
            if (isMobile && (typeof Android !== "undefined" || navigator.share)) {
                window.compartilharConteudo(
                    "Convite: Compartilhar Projetos", 
                    "Faça parte da nossa vitrine de criadores e desenvolvedores. Cadastre-se gratuitamente, publique seu portfólio e dê mais visibilidade às suas ideias!", 
                    linkText
                );
            } else {
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(linkText).then(() => toast("Link copiado!", "success")).catch(() => fallbackCopy(linkText));
                } else {
                    fallbackCopy(linkText);
                }
            }

            function fallbackCopy(text) {
                const textArea = document.createElement("textarea");
                textArea.value = text; textArea.style.position = "fixed"; textArea.style.opacity = "0";
                document.body.appendChild(textArea); textArea.focus(); textArea.select();
                try { document.execCommand('copy'); toast("Link copiado!", "success"); } catch (err) { toast("Erro ao copiar o link.", "error"); }
                document.body.removeChild(textArea);
            }
        }); 
    }
    const withdrawForm = qs("#withdrawForm"); if (withdrawForm) { withdrawForm.addEventListener("submit", (e) => { e.preventDefault(); const fd = new FormData(withdrawForm); Promise.resolve().then(() => requestWithdrawal(parseFloat(fd.get("amount")), fd.get("pixKey"))).then(() => { toast("Saque enviado!", "success"); render({ navigation: false }); }).catch((err) => toast(err.message, "error")); }); }

    const projectReviewForm = qs("#projectReviewForm");
    if (projectReviewForm) {
      const stars = qsa("#starRatingInput span");
      const ratingInput = qs("#projectRatingVal");

      stars.forEach(star => {
        star.addEventListener("click", () => {
          const val = parseInt(star.getAttribute("data-val"));
          ratingInput.value = val;
          stars.forEach(s => { const isFull = parseInt(s.getAttribute("data-val")) <= val; s.innerHTML = getStarSvg(32, isFull); });
        });
      });

      projectReviewForm.addEventListener("submit", (e) => {
        e.preventDefault(); const rating = parseInt(ratingInput.value);
        if (rating === 0) { toast("Por favor, dê uma nota em estrelas.", "error"); return; }
        const commentInput = projectReviewForm.querySelector("textarea[name='comment']").value.trim();
        const projectId = projectReviewForm.getAttribute("data-project"); const user = currentUser();
        if (!user) return; const targetProject = db.projects.find(p => p.id === projectId); if (!targetProject) return;

        const newReview = { userId: user.id, userName: user.name, rating: rating, comment: sanitizeText(commentInput), createdAt: nowISO() };
        const updatedReviews = [...(targetProject.reviews || []), newReview];
        
        const btn = projectReviewForm.querySelector("button[type='submit']");
        btn.disabled = true; btn.textContent = "Enviando...";

        updateProject(projectId, { reviews: updatedReviews }).then(() => { toast("Avaliação enviada com sucesso!", "success"); render({ navigation: false }); }).catch(err => { toast(err.message || "Erro ao enviar avaliação.", "error"); btn.disabled = false; btn.textContent = "Enviar Avaliação"; });
      });
    }

    const platformReviewForm = qs("#platformReviewForm");
    if (platformReviewForm) {
      const platformStars = qsa("#platformRatingStars span");
      const platformRatingInput = qs("#overallRatingVal");

      platformStars.forEach(star => {
        star.addEventListener("click", () => {
          const val = parseInt(star.getAttribute("data-val"));
          platformRatingInput.value = val;
          platformStars.forEach(s => { const isFull = parseInt(s.getAttribute("data-val")) <= val; s.innerHTML = getStarSvg(32, isFull); });
        });
      });

      platformReviewForm.addEventListener("submit", async (e) => {
        e.preventDefault(); const errorEl = qs("#platformReviewError"); errorEl.style.display = "none";
        const fd = new FormData(platformReviewForm); const overallRating = parseInt(fd.get("overallRating"));
        
        if (overallRating === 0) { errorEl.textContent = "Por favor, dê uma nota na primeira pergunta."; errorEl.style.display = "block"; return; }
        const user = currentUser(); if (!user) return;
        const submitBtn = platformReviewForm.querySelector("button[type='submit']"); submitBtn.disabled = true; submitBtn.textContent = "Enviando...";
        const newPlatformReview = { id: uid("prev"), userId: user.id, userName: user.name, overallRating: overallRating, usabilityScore: fd.get("usabilityScore"), wouldRecommend: fd.get("wouldRecommend"), feedbackText: sanitizeText(fd.get("feedbackText")), createdAt: nowISO() };
        try { await addPlatformReview(newPlatformReview); toast("Feedback enviado! Obrigado por ajudar.", "success"); navigate("/"); } catch (err) { errorEl.textContent = err.message || "Ocorreu um erro."; errorEl.style.display = "block"; submitBtn.disabled = false; submitBtn.textContent = "Enviar Avaliação"; }
      });
    }
  }

  function renderUploadPreview() { const box = qs("#uploadPreview"); if (!box) return; box.innerHTML = pendingImages.map((src, i) => `<div class="rm"><img src="${src}"><button type="button" data-i="${i}">×</button></div>`).join(""); qsa("#uploadPreview button").forEach((b) => b.addEventListener("click", () => { pendingImages.splice(parseInt(b.getAttribute("data-i")), 1); renderUploadPreview(); })); }
  function updateExploreQuery() { const q = qs("#searchInput") ? qs("#searchInput").value : ""; const cat = qs("#catFilter") ? qs("#catFilter").value : ""; let hash = "/explorar?"; const parts = []; if (q) parts.push("q=" + encodeURIComponent(q)); if (cat) parts.push("cat=" + encodeURIComponent(cat)); location.hash = hash + parts.join("&"); }

  // =========================================================
  // INICIALIZAÇÃO
  // =========================================================
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
