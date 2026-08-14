/* =========================================================
   COMPARTILHAR PROJETOS — SCRIPT.JS
   SPA leve, sincronizada com o Firebase Realtime Database.
   Autenticação via Firebase Auth. Pagamento de assinatura via
   Pix (VizzionPay), processado por um Cloudflare Worker que
   confirma o pagamento e ativa a assinatura direto no Firebase.

   v2: render() agora distingue NAVEGAÇÃO (troca de rota, login,
   logout) de ATUALIZAÇÃO DE DADO (qualquer onDBChange vindo do
   Firebase, que pode disparar a qualquer momento e para qualquer
   usuário conectado, sem relação com o que ele está fazendo).
   Só a navegação força scroll ao topo. Atualizações de dado que
   chegam enquanto o usuário está digitando em um campo dentro de
   #app são adiadas até ele sair do campo, para não apagar o que
   está sendo escrito.

   v3: CORREÇÃO — onAuthStateChanged agora reseta dbReady sempre
   que o estado de login muda. Antes, quando o login acontecia,
   o render({navigation:true}) disparado pelo onAuthStateChanged
   podia rodar ANTES do db-sync.js terminar de recarregar os nós
   protegidos (users, referrals, etc.) para o novo usuário logado
   — nesse instante db.users ainda estava vazio/desatualizado, o
   guard de rota concluía (errado) que ninguém estava logado, e
   redirecionava via location.href para login.html?redirect=... ,
   cancelando a navegação antes dos dados corretos chegarem.
   Resetar dbReady força a tela de "Carregando…" nesse intervalo
   em vez de redirecionar precocemente.

   NOTA: o bug de comentários virarem "Usuário removido" / "Invalid
   Date" (ver histórico) não estava neste arquivo — script.js já
   usava sempre os IDs de negócio (post.id, comment.id) corretamente.
   A causa era em db-sync.js (addComment/addReply escrevendo no
   índice do array em vez da chave real do Firebase). Este arquivo
   segue sem alterações.
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDB,
  onDBChange,
  updateUserProfile,
  addProject,
  addPost,
  addComment,
  addReply,
  addWithdrawalRequest,
} from "./db-sync.js";
import { uid, nowISO } from "./seed.js";

(function () {
  "use strict";

  // Troque pela URL real do seu Worker publicado na Cloudflare
  const WORKER_URL = "https://apidocompartilharprojetos.lucas-dev-programador.workers.dev";

  const PLANS = {
    pTeste: { id: "pTeste", name: "Plano Teste", price: 5, days: 2 },
    p4: { id: "p4", name: "Plano 4 Dias", price: 10, days: 4 },
    p7: { id: "p7", name: "Plano 7 Dias", price: 20, days: 7 },
    pMensal: { id: "pMensal", name: "Plano Mensal", price: 50, days: 30 },
  };
  const COMMISSION_RATE = 0.3; // 30% para quem indicou
  const MIN_WITHDRAW = 10;

  // estado local — populado pelos listeners do Firebase
  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;

  /* ---------------------------------------------------------
     SESSÃO
  --------------------------------------------------------- */
  function currentUser() {
    if (!db || !firebaseUser) return null;
    return db.users.find((u) => u.id === firebaseUser.uid) || null;
  }
  function logoutUser() {
    return signOut(auth);
  }
  function isSubscriptionActive(user) {
    if (!user || !user.subscription || !user.subscription.active) return false;
    return new Date(user.subscription.expiresAt) > new Date();
  }
  // Administradores podem publicar projetos mesmo sem assinatura ativa.
  function canPublish(user) {
    if (!user) return false;
    return user.role === "admin" || isSubscriptionActive(user);
  }

  /* ---------------------------------------------------------
     UTILITÁRIOS
  --------------------------------------------------------- */
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function fmtBRL(v) {
    return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function initials(name) {
    return (name || "?")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("");
  }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
    stack.appendChild(el);
    const dismiss = () => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(dismiss, 3600);
  }
  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }
  function categoryName(id) {
    const c = db.categories.find((c) => c.id === id);
    return c ? c.name : "Geral";
  }
  function userById(id) {
    return db.users.find((u) => u.id === id);
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  // sanitiza texto de publicações (proteção básica contra conteúdo malicioso / HTML injetado)
  function sanitizeText(str) {
    return escapeHtml(str).slice(0, 5000);
  }
  function isValidUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }
  // Detecta links em texto livre (posts/comentários/respostas da comunidade).
  // Cobre: http(s)://, www., domínio.tld (ex.: meusite.com), e variações com
  // espaços/parênteses em volta do ponto (ex.: "meusite . com", "meusite(.)com"),
  // que é um contorno comum de filtros simples. Não é infalível — ver aviso
  // ao usuário sobre reforçar isso no servidor também.
  const LINK_PATTERN = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\s*[(\[]?\s*\.\s*[)\]]?\s*(com|net|org|br|io|me|co|app|dev|xyz|info|shop|site|online|link|click)\b/i;
  function containsLink(str) {
    return LINK_PATTERN.test(str || "");
  }

  /* ---------------------------------------------------------
     GERAÇÃO DE QR CODE (no navegador)
     A VizzionPay não garante mais o campo pix.image (é opcional)
     e pix.base64 está deprecated (sempre retorna vazio agora).
     O único dado garantido é pix.code (o código copia-e-cola),
     então geramos o QR Code no próprio navegador a partir dele,
     usando a lib qrcodejs carregada via CDN.
  --------------------------------------------------------- */
  let qrCodeLibPromise = null;
  function ensureQRCodeLib() {
    if (window.QRCode) return Promise.resolve();
    if (qrCodeLibPromise) return qrCodeLibPromise;
    qrCodeLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Falha ao carregar gerador de QR Code"));
      document.head.appendChild(script);
    });
    return qrCodeLibPromise;
  }
  function renderQRCode(container, text) {
    container.innerHTML = "";
    ensureQRCodeLib()
      .then(() => {
        // eslint-disable-next-line no-undef
        new QRCode(container, {
          text: text || "",
          width: 220,
          height: 220,
          correctLevel: window.QRCode.CorrectLevel.M,
        });
      })
      .catch((err) => {
        console.error(err);
        container.innerHTML = `<span class="muted" style="font-size:12px;display:block;padding:12px">Não foi possível gerar o QR Code. Use o código copia e cola abaixo.</span>`;
      });
  }

  /* ---------------------------------------------------------
     PAGAMENTO — Pix via VizzionPay (processado pelo Worker)
  --------------------------------------------------------- */
  async function startPixPayment(planId, documentOverride) {
    const user = currentUser();
    if (!user) throw new Error("Você precisa entrar na sua conta.");
    const plan = PLANS[planId];
    if (!plan) throw new Error("Plano inválido.");

    const document = documentOverride || user.document;
    if (!document) throw new Error("Informe seu CPF ou CNPJ antes de continuar.");

    const response = await fetch(`${WORKER_URL}/create-pix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        planId: plan.id,
        client: {
          name: user.name,
          email: user.email,
          phone: user.phone || "(11) 99999-9999", // ajuste se o cadastro tiver telefone próprio
          document,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Erro ao gerar cobrança Pix");
    return data; // { transactionId, status, pix: { code, image } }
  }

  // Remove tudo que não for dígito — CPF (11) ou CNPJ (14)
  function onlyDigits(str) {
    return (str || "").replace(/\D/g, "");
  }
  function isValidDocument(str) {
    const digits = onlyDigits(str);
    return digits.length === 11 || digits.length === 14;
  }

  // Pede CPF/CNPJ antes de gerar o Pix, caso o usuário ainda não tenha cadastrado.
  // Salva no perfil (updateUserProfile) para não precisar pedir de novo.
  function showDocumentModal() {
    // Evita abrir dois modais sobrepostos (ex.: double-tap no mobile disparando dois cliques)
    const existing = qs(".modal-overlay");
    if (existing) existing.remove();

    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay open";
      overlay.innerHTML = `
        <div class="modal-box" style="max-width:400px">
          <button type="button" class="modal-close" id="documentCancelBtn" aria-label="Fechar">×</button>
          <h2>Falta só um passo</h2>
          <p class="sub">Para gerar seu Pix, precisamos do seu CPF ou CNPJ (exigido pelo meio de pagamento).</p>
          <form id="documentForm">
            <div class="field"><label>CPF ou CNPJ</label><input name="document" inputmode="numeric" placeholder="Somente números" required></div>
            <div class="field-error" id="documentError" style="display:none"></div>
            <button class="btn btn-primary btn-block" type="submit">Continuar</button>
          </form>
        </div>`;
      document.body.appendChild(overlay);

      const form = qs("#documentForm", overlay);
      const errorEl = qs("#documentError", overlay);

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const raw = new FormData(form).get("document");
        const digits = onlyDigits(raw);
        if (!isValidDocument(digits)) {
          errorEl.textContent = "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.";
          errorEl.style.display = "block";
          return;
        }
        const user = currentUser();
        try {
          await updateUserProfile(user.id, { document: digits });
        } catch (err) {
          // mesmo se falhar salvar no perfil, seguimos com o pagamento usando o valor digitado
          console.error("Falha ao salvar document no perfil:", err);
        }
        overlay.remove();
        resolve(digits);
      });

      qs("#documentCancelBtn", overlay).addEventListener("click", () => {
        overlay.remove();
        reject(new Error("cancelado"));
      });
    });
  }

  function showPixModal({ pix }) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:400px;text-align:center">
        <button type="button" class="modal-close" id="pixCloseBtn" aria-label="Fechar">×</button>
        <h2>Pague com Pix para ativar sua assinatura</h2>
        <div id="pixQrCode" class="pix-qr" style="width:220px;height:220px;margin:16px auto;display:flex;align-items:center;justify-content:center">
          <span class="muted" style="font-size:12px">Gerando QR Code…</span>
        </div>
        <textarea readonly style="width:100%;font-size:11px;padding:8px" rows="4">${pix.code || ""}</textarea>
        <button id="pixCopyBtn" class="btn btn-primary btn-sm mt-2">Copiar código</button>
        <p class="muted mt-2" style="font-size:13px">Assim que o pagamento for confirmado, sua assinatura ativa automaticamente — não precisa recarregar a página.</p>
      </div>`;
    document.body.appendChild(overlay);

    renderQRCode(qs("#pixQrCode", overlay), pix.code);

    let handled = false;
    let stopWatching = null;
    const unsubscribe = onDBChange(() => {
      const user = currentUser();
      if (user && isSubscriptionActive(user) && !handled) {
        handled = true;
        overlay.remove();
        toast("Pagamento confirmado — assinatura ativa!", "success");
        // onDBChange pode disparar este callback de forma síncrona (se a assinatura
        // já estiver ativa no cache local), antes de "stopWatching" terminar de ser
        // atribuído. Adiar para o próximo microtask garante que a variável já exista.
        Promise.resolve().then(() => {
          if (typeof stopWatching === "function") stopWatching();
        });
        render({ navigation: true }); // assinatura mudou de estado — vale a pena voltar ao topo
      }
    });
    stopWatching = unsubscribe;

    qs("#pixCopyBtn", overlay).addEventListener("click", () => {
      navigator.clipboard.writeText(pix.code || "");
      toast("Código copiado!", "success");
    });
    qs("#pixCloseBtn", overlay).addEventListener("click", () => {
      overlay.remove();
      handled = true;
      if (typeof stopWatching === "function") stopWatching();
    });
  }

  /* ---------------------------------------------------------
     AÇÕES DE NEGÓCIO
     (login e cadastro ficam em auth.js — login.html / register.html)
  --------------------------------------------------------- */
  function publishProject(data) {
    const user = currentUser();
    if (!user) throw new Error("Você precisa entrar na sua conta.");
    if (!canPublish(user)) throw new Error("Sua assinatura não está ativa. Assine um plano para publicar.");
    if (!data.title || data.title.trim().length < 3) throw new Error("Informe um título para o projeto.");
    if (!data.description || data.description.trim().length < 10) throw new Error("Descreva melhor o seu projeto.");
    if (!data.categoryId) throw new Error("Selecione uma categoria.");
    if (!data.link || !isValidUrl(data.link)) throw new Error("Informe um link válido (começando com http:// ou https://).");
    if (!data.ownerName) throw new Error("Informe o nome do responsável.");
    if (!data.contact) throw new Error("Informe uma forma de contato.");

    const project = {
      id: uid("pj"),
      title: sanitizeText(data.title.trim()),
      description: sanitizeText(data.description.trim()),
      images: (data.images || []).slice(0, 6),
      categoryId: data.categoryId,
      link: data.link.trim(),
      ownerName: sanitizeText(data.ownerName.trim()),
      contact: sanitizeText(data.contact.trim()),
      ownerId: user.id,
      createdAt: nowISO(),
      status: "published",
    };
    return addProject(project);
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
    return addComment(postId, comment);
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
    return addReply(postId, commentId, reply);
  }

  function requestWithdrawal(amount, pixKey) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta.");
    const available = availableCommission(user.id);
    if (!pixKey || !pixKey.trim()) throw new Error("Informe sua chave Pix para receber o saque.");
    if (amount < MIN_WITHDRAW) throw new Error(`O saque mínimo é ${fmtBRL(MIN_WITHDRAW)}.`);
    if (amount > available) throw new Error("Valor solicitado maior que o saldo disponível.");
    return addWithdrawalRequest({
      id: uid("wd"),
      userId: user.id,
      amount,
      pixKey: sanitizeText(pixKey.trim()),
      status: "pending",
      createdAt: nowISO(),
    });
  }

  function availableCommission(userId) {
    const earned = db.commissions
      .filter((c) => c.referrerId === userId && (c.status === "available" || c.status === "pending"))
      .reduce((s, c) => (c.status === "available" ? s + c.amount : s), 0);
    const withdrawn = db.withdrawals
      .filter((w) => w.userId === userId && (w.status === "approved" || w.status === "pending"))
      .reduce((s, w) => s + w.amount, 0);
    return Math.max(0, Math.round((earned - withdrawn) * 100) / 100);
  }
  function lastPixKey(userId) {
    const mine = db.withdrawals.filter((w) => w.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return mine.length ? mine[0].pixKey || "" : "";
  }
  function pendingCommission(userId) {
    return db.commissions.filter((c) => c.referrerId === userId && c.status === "pending").reduce((s, c) => s + c.amount, 0);
  }
  function totalEarnings(userId) {
    return db.commissions.filter((c) => c.referrerId === userId).reduce((s, c) => s + c.amount, 0);
  }

  // Observação: a antiga função maturateCommissions() foi removida.
  // O Worker agora cria a comissão já como "available" no momento em que
  // confirma o pagamento via webhook, então não há mais etapa de maturação
  // a ser feita pelo cliente.

  /* ---------------------------------------------------------
     HEADER / ESTADO GLOBAL
  --------------------------------------------------------- */
  function refreshHeader() {
    const user = currentUser();
    document.body.classList.toggle("is-guest", !user);
    document.body.classList.toggle("is-admin", !!user && user.role === "admin");
    if (user) {
      qs("#avatarInitial").textContent = initials(user.name);
      qs("#avatarInitial").style.background = user.avatarColor || "";
      const pill = qs("#subPill");
      const active = isSubscriptionActive(user);
      pill.textContent = active ? "Assinatura ativa" : "Sem assinatura";
      pill.className = "sub-pill " + (active ? "active" : "free");
    }
    qsa(".main-nav a, .mobile-nav a").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("href") === "#" + currentRoute().path);
    });
  }

  /* ---------------------------------------------------------
     ROTEADOR
  --------------------------------------------------------- */
  function currentRoute() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, query] = hash.split("?");
    const params = {};
    (query || "").split("&").forEach((pair) => {
      if (!pair) return;
      const [k, v] = pair.split("=");
      params[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
    return { path: path || "/", params };
  }

  function navigate(path) {
    location.hash = path;
  }

  const PROTECTED_ROUTES = ["/painel", "/perfil", "/indicacoes", "/publicar"];

  /* ---------------------------------------------------------
     RENDER
     -----------------------------------------------------------
     render({ navigation }) — navigation=true é usado só quando a
     rota realmente mudou (hashchange) ou quando o estado de auth
     muda (login/logout). Só esses casos fazem sentido "resetar" a
     tela para o usuário: forçam scroll ao topo.

     navigation=false (padrão) é usado nas atualizações de dado
     vindas do Firebase (onDBChange), que podem chegar a qualquer
     momento e não têm relação com o que o usuário está fazendo —
     por isso NÃO mexem no scroll. Se o usuário estiver digitando
     em um campo dentro de #app nesse momento, o render é adiado
     até ele sair do campo, para não apagar o que foi digitado.
  --------------------------------------------------------- */
  let pendingDataRender = false;

  function hasActiveFormField() {
    const el = document.activeElement;
    const app = qs("#app");
    if (!el || !app || !app.contains(el)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function render(opts) {
    const isNavigation = !!(opts && opts.navigation);

    // ainda carregando dados do Firebase (auth e/ou banco) — mostra um loading simples
    if (!authReady || !dbReady) {
      const app = qs("#app");
      if (app) app.innerHTML = `<div class="section text-center"><div class="container"><p class="muted">Carregando…</p></div></div>`;
      return;
    }

    // Atualização de dado chegando enquanto o usuário digita algo dentro
    // de #app: adia o re-render em vez de apagar o campo. É retomado no
    // listener de "focusout" logo abaixo, assim que o campo perde o foco.
    if (!isNavigation && hasActiveFormField()) {
      pendingDataRender = true;
      return;
    }
    pendingDataRender = false;

    const { path, params } = currentRoute();
    const app = qs("#app");
    const user = currentUser();

    if (PROTECTED_ROUTES.some((p) => path.startsWith(p)) && !user) {
      const dest = path.replace(/^\//, "").split("?")[0] || "painel";
      location.href = "login.html?redirect=" + encodeURIComponent(dest);
      return;
    }

    let seg = path.split("/").filter(Boolean);
    let html = "";

    if (path === "/" || path === "") html = viewHome();
    else if (path === "/explorar") html = viewExplore(params);
    else if (seg[0] === "projeto" && seg[1]) html = viewProjectDetail(seg[1]);
    else if (path === "/publicar") html = viewPublish();
    else if (path === "/comunidade") html = viewCommunity();
    else if (path === "/planos") html = viewPlans();
    else if (path === "/painel") html = viewDashboard();
    else if (path === "/perfil") html = viewProfile();
    else if (path === "/indicacoes") html = viewReferrals();
    else html = view404();

    app.innerHTML = html;
    // Só reseta o scroll quando é de fato uma navegação — atualizações de
    // dado que chegam em segundo plano não devem mexer na posição da tela.
    if (isNavigation) {
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    }
    refreshHeader();
    bindPageEvents(path);
  }

  // Retoma um render de dado que ficou pendente assim que o usuário sai
  // do campo em que estava digitando.
  document.addEventListener("focusout", () => {
    if (!pendingDataRender) return;
    setTimeout(() => {
      if (!hasActiveFormField()) render({ navigation: false });
    }, 0);
  });

  /* ---------------------------------------------------------
     VIEWS (HTML)
  --------------------------------------------------------- */
  function projectCard(p) {
    const img = p.images && p.images[0];
    return `
    <a href="#/projeto/${p.id}" class="project-card">
      <div class="pc-thumb">
        ${img ? `<img src="${img}" alt="${escapeHtml(p.title)}" loading="lazy">` : ""}
        <span class="pc-cat">${escapeHtml(categoryName(p.categoryId))}</span>
      </div>
      <div class="pc-body">
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.description)}</p>
        <div class="pc-meta">
          <span class="author"><span class="pc-mini-avatar">${initials(p.ownerName)}</span>${escapeHtml(p.ownerName)}</span>
          <span>${fmtDate(p.createdAt)}</span>
        </div>
      </div>
    </a>`;
  }

  function viewHome() {
    const featured = db.projects.slice(0, 4);
    return `
    <section class="hero">
      <div class="container hero-inner">
        <div>
          <span class="eyebrow"><span class="dot"></span> Plataforma de assinatura para criadores</span>
          <h1>Encontre projetos, <span class="accent">compartilhe</span> suas ideias e conecte-se com criadores.</h1>
          <p class="lead">Compartilhar Projetos é onde desenvolvedores, designers e criadores publicam o que estão construindo — e descobrem o que o resto da comunidade está criando.</p>
          <div class="hero-cta">
            <a href="register.html" class="btn btn-gold btn-lg">Cadastrar grátis</a>
            <a href="#/explorar" class="btn btn-ghost btn-lg" style="border-color:rgba(255,255,255,.35);color:#fff">Explorar projetos</a>
          </div>
          <div class="hero-stats">
            <div><strong>${db.projects.length}+</strong><span>projetos publicados</span></div>
            <div><strong>${db.users.length}+</strong><span>criadores cadastrados</span></div>
            <div><strong>${db.categories.length}</strong><span>categorias ativas</span></div>
          </div>
        </div>
        <div class="hero-visual" aria-hidden="true">
          <div class="fan-card fan-1"><span class="fc-cat">Design</span><h5>Verso Design System</h5><p>Componentes acessíveis para B2B.</p><div class="fc-foot"><span>Marina D.</span><span class="fc-badge">PRO</span></div></div>
          <div class="fan-card fan-2"><span class="fc-cat">Mobile</span><h5>Trilha</h5><p>Trilhas offline para exploradores.</p><div class="fc-foot"><span>Marina D.</span><span>2 dias</span></div></div>
          <div class="fan-card fan-3"><span class="fc-cat">Web</span><h5>Nimbus</h5><p>Financeiro para freelancers.</p><div class="fc-foot"><span>Marina D.</span><span class="fc-badge">PRO</span></div></div>
          <div class="fan-card fan-4"><span class="fc-cat">IA</span><h5>Seu projeto aqui</h5><p>Publique e alcance a comunidade.</p><div class="fc-foot"><span>Você</span><span>Hoje</span></div></div>
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="container">
        <div class="section-head">
          <div><span class="tag-label">Como funciona</span><h2>Três passos para publicar seu projeto</h2></div>
        </div>
        <div class="steps-grid">
          <div class="step-card"><div class="step-num">Passo 1</div><h3>Crie sua conta grátis</h3><p>Cadastro leva menos de um minuto. Contas gratuitas já podem explorar todos os projetos publicados.</p></div>
          <div class="step-card"><div class="step-num">Passo 2</div><h3>Assine um plano</h3><p>Escolha entre 4 ou 7 dias de publicação ativa. Pague uma vez e publique quantos projetos quiser no período.</p></div>
          <div class="step-card"><div class="step-num">Passo 3</div><h3>Publique e conecte-se</h3><p>Adicione imagens, categoria, link e contato. Participe da comunidade e receba feedback de outros criadores.</p></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head">
          <div><span class="tag-label">Recém-publicados</span><h2>Projetos em destaque</h2></div>
          <a href="#/explorar" class="link">Ver todos os projetos →</a>
        </div>
        <div class="project-grid">${featured.map(projectCard).join("") || emptyState("Nenhum projeto publicado ainda.")}</div>
      </div>
    </section>

    <section class="section-tight">
      <div class="cta-band">
        <h2>Pronto para mostrar o que você está construindo?</h2>
        <p>Assine um plano de publicação e coloque seu projeto na frente de toda a comunidade.</p>
        <a href="#/planos" class="btn btn-gold btn-lg">Assinar para publicar</a>
      </div>
    </section>`;
  }

  function emptyState(msg, sub) {
    return `<div class="empty-state" style="grid-column:1/-1"><h3>${escapeHtml(msg)}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div>`;
  }

  function viewExplore(params) {
    const search = (params.q || "").toLowerCase();
    const cat = params.cat || "";
    let list = db.projects.filter((p) => p.status === "published");
    if (search) list = list.filter((p) => p.title.toLowerCase().includes(search) || p.description.toLowerCase().includes(search));
    if (cat) list = list.filter((p) => p.categoryId === cat);

    return `
    <section class="section" style="padding-top:44px">
      <div class="container">
        <div class="section-head">
          <div><span class="tag-label">Catálogo</span><h2>Explorar projetos</h2><p>Descubra o que criadores de todo o Brasil estão construindo agora.</p></div>
        </div>
        <div class="filters-bar">
          <input id="searchInput" class="search-input" type="search" placeholder="Buscar projetos por nome ou descrição…" value="${escapeHtml(params.q || "")}">
          <select id="catFilter" class="select-input">
            <option value="">Todas as categorias</option>
            ${db.categories.map((c) => `<option value="${c.id}" ${c.id === cat ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="project-grid">
          ${list.map(projectCard).join("") || emptyState("Nenhum projeto encontrado", "Tente ajustar a busca ou explorar outra categoria.")}
        </div>
      </div>
    </section>`;
  }

  function viewProjectDetail(id) {
    const p = db.projects.find((pj) => pj.id === id);
    if (!p) return view404();
    const img = (p.images && p.images[0]) || "";
    return `
    <div class="project-detail container">
      <div class="breadcrumb"><a href="#/explorar">Explorar</a> / ${escapeHtml(categoryName(p.categoryId))} / <span>${escapeHtml(p.title)}</span></div>
      <div class="pd-grid">
        <div>
          <div class="pd-gallery">${img ? `<img src="${img}" alt="${escapeHtml(p.title)}">` : `<span class="muted">Sem imagem</span>`}</div>
          ${
            p.images && p.images.length > 1
              ? `<div class="pd-thumbs">${p.images.map((im, i) => `<img src="${im}" class="${i === 0 ? "active" : ""}" alt="">`).join("")}</div>`
              : ""
          }
        </div>
        <aside class="pd-side">
          <h4>Sobre o projeto</h4>
          <div class="pd-row"><span>Responsável</span><span>${escapeHtml(p.ownerName)}</span></div>
          <div class="pd-row"><span>Contato</span><span>${escapeHtml(p.contact)}</span></div>
          <div class="pd-row"><span>Categoria</span><span>${escapeHtml(categoryName(p.categoryId))}</span></div>
          <div class="pd-row"><span>Publicado em</span><span>${fmtDate(p.createdAt)}</span></div>
          <a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-block">Acessar projeto ↗</a>
        </aside>
      </div>
      <div style="margin-top:36px;max-width:760px">
        <span class="pd-cat-badge">${escapeHtml(categoryName(p.categoryId))}</span>
        <h1 class="pd-title">${escapeHtml(p.title)}</h1>
        <div class="pd-desc">${escapeHtml(p.description)}</div>
      </div>
    </div>`;
  }

  function viewPublish() {
    const user = currentUser();
    if (!canPublish(user)) {
      return `
      <div class="auth-shell">
        <div class="auth-card text-center">
          <h2>Assinatura necessária</h2>
          <p class="sub">Para publicar projetos na plataforma, você precisa de uma assinatura ativa.</p>
          <a href="#/planos" class="btn btn-gold btn-block">Ver planos de assinatura</a>
        </div>
      </div>`;
    }
    return `
    <section class="section" style="padding-top:44px;max-width:720px;margin:0 auto">
      <div class="container">
        <span class="tag-label">Novo projeto</span>
        <h2 style="margin-bottom:6px">Publicar projeto</h2>
        ${user.role === "admin" ? `<p class="field-hint" style="margin-bottom:20px">Você está publicando como administrador — não é necessário ter assinatura ativa.</p>` : `<div style="margin-bottom:26px"></div>`}
        <form id="publishForm" class="panel">
          <div class="field"><label>Nome do projeto</label><input name="title" required placeholder="Ex.: Nimbus — painel financeiro"></div>
          <div class="field"><label>Descrição</label><textarea name="description" rows="5" required placeholder="Conte o que é, para quem serve e o que torna especial."></textarea></div>
          <div class="field"><label>Categoria</label>
            <select name="categoryId" required>
              <option value="">Selecione…</option>
              ${db.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Link do projeto</label><input name="link" type="url" required placeholder="https://"></div>
          <div class="field"><label>Nome do responsável</label><input name="ownerName" required value="${escapeHtml(user.name)}"></div>
          <div class="field"><label>Forma de contato</label><input name="contact" required placeholder="E-mail, WhatsApp ou @usuário" value="${escapeHtml(user.email)}"></div>
          <div class="field">
            <label>Imagens do projeto</label>
            <input type="file" id="imageInput" accept="image/*" multiple>
            <div class="field-hint">Envie até 4 imagens do seu projeto.</div>
            <div class="upload-preview" id="uploadPreview"></div>
          </div>
          <div class="field-error" id="publishError"></div>
          <button class="btn btn-primary btn-block" type="submit">Publicar projeto</button>
        </form>
      </div>
    </section>`;
  }

  function viewCommunity() {
    const user = currentUser();
    const posts = db.posts.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `
    <section class="section" style="padding-top:44px">
      <div class="container community-layout">
        <div>
          <span class="tag-label">Comunidade</span>
          <h2 style="margin-bottom:22px">Converse com outros criadores</h2>
          ${
            user
              ? `<div class="composer">
                  <textarea id="postInput" placeholder="Compartilhe uma novidade, peça feedback ou converse sobre a plataforma…"></textarea>
                  <div class="composer-foot"><span class="muted" style="font-size:12.5px">Publicando como ${escapeHtml(user.name)}</span><button class="btn btn-primary btn-sm" id="postSubmit">Publicar</button></div>
                </div>`
              : `<div class="panel text-center"><p class="muted">Entre na sua conta para participar da comunidade.</p><a href="login.html?redirect=comunidade" class="btn btn-ghost btn-sm mt-2">Entrar</a></div>`
          }
          <div id="postsList">${posts.map(postCard).join("") || emptyState("Ainda não há publicações", "Seja a primeira pessoa a iniciar uma conversa.")}</div>
        </div>
        <aside>
          <div class="side-card"><h4>Boas práticas</h4><p>Seja respeitoso, evite spam e mantenha o foco em projetos, feedback e aprendizado. Publicações ofensivas podem ser removidas pela moderação.</p></div>
          <div class="side-card"><h4>Estatísticas</h4><p>${db.posts.length} publicações · ${db.users.length} membros na comunidade.</p></div>
        </aside>
      </div>
    </section>`;
  }

  function commentCard(postId, c) {
    const author = userById(c.authorId);
    return `
    <div class="comment" data-comment="${c.id}">
      <span class="pc-mini-avatar" style="background:${author ? author.avatarColor : "#888"}">${initials(author ? author.name : "?")}</span>
      <div style="flex:1">
        <div class="comment-body"><strong>${escapeHtml(author ? author.name : "Usuário removido")}</strong><p>${escapeHtml(c.content)}</p></div>
        <div class="post-actions" style="border:none;padding-top:6px">
          <button class="reply-toggle" data-post="${postId}" data-comment="${c.id}">Responder</button>
          <span class="muted">${fmtDateTime(c.createdAt)}</span>
        </div>
        <div class="reply-list">${(c.replies || []).map((r) => replyRow(r)).join("")}</div>
        <form class="comment-reply-form" data-post="${postId}" data-comment="${c.id}" style="display:none">
          <input type="text" placeholder="Escreva uma resposta…" required>
          <button class="btn btn-sm btn-primary" type="submit">Enviar</button>
        </form>
      </div>
    </div>`;
  }
  function replyRow(r) {
    const author = userById(r.authorId);
    return `<div class="comment"><span class="pc-mini-avatar" style="background:${author ? author.avatarColor : "#888"}">${initials(author ? author.name : "?")}</span>
      <div class="comment-body"><strong>${escapeHtml(author ? author.name : "Usuário removido")}</strong><p>${escapeHtml(r.content)}</p></div></div>`;
  }

  function postCard(p) {
    const author = userById(p.authorId);
    return `
    <article class="post-card" data-post="${p.id}">
      <div class="post-head">
        <div class="post-author">
          <span class="pc-mini-avatar" style="background:${author ? author.avatarColor : "#888"};width:34px;height:34px;font-size:13px">${initials(author ? author.name : "?")}</span>
          <div><strong>${escapeHtml(author ? author.name : "Usuário removido")}</strong><br><span>${fmtDateTime(p.createdAt)}</span></div>
        </div>
        ${author && author.role === "admin" ? `<span class="badge badge-blue">Equipe</span>` : ""}
      </div>
      <div class="post-body">${escapeHtml(p.content)}</div>
      <div class="post-actions">
        <button class="comment-toggle" data-post="${p.id}">💬 ${p.comments.length} comentário(s)</button>
      </div>
      <div class="comment-section" data-post-comments="${p.id}" style="display:none">
        <div class="comment-list">${p.comments.map((c) => commentCard(p.id, c)).join("")}</div>
        <form class="comment-reply-form comment-new-form" data-post="${p.id}" style="margin-top:12px">
          <input type="text" placeholder="Escreva um comentário…" required>
          <button class="btn btn-sm btn-primary" type="submit">Comentar</button>
        </form>
      </div>
    </article>`;
  }

  function viewPlans() {
    const user = currentUser();
    const active = isSubscriptionActive(user);
    return `
    <section class="section" style="padding-top:52px">
      <div class="container text-center" style="margin-bottom:44px">
        <span class="tag-label">Planos de assinatura</span>
        <h2>Assine para publicar seus projetos</h2>
        <p class="muted" style="max-width:520px;margin:12px auto 0">Contas gratuitas podem visualizar todos os projetos. Para publicar, escolha um plano abaixo.</p>
        ${
          user && user.role === "admin"
            ? ""
            : active
            ? `<div class="badge badge-success mt-2">Assinatura ativa até ${fmtDate(user.subscription.expiresAt)}</div>`
            : user
            ? `<div class="badge badge-danger mt-2">Você ainda não tem assinatura ativa</div>`
            : ""
        }
      </div>
      <div class="container">
        <div class="plans-grid">
          <div class="plan-card">
            <span class="plan-name">Plano Teste</span>
            <div class="plan-price">R$ 5<span>,00</span></div>
            <div class="plan-duration">Válido por 2 dias</div>
            <ul class="plan-features">
              <li>Permite publicar projetos</li>
              <li>Acesso à área de publicação</li>
              <li>Expira automaticamente após 2 dias</li>
            </ul>
            <button class="btn btn-ghost btn-block" data-plan="pTeste">Assinar plano teste</button>
          </div>
          <div class="plan-card">
            <span class="plan-name">Plano 4 dias</span>
            <div class="plan-price">R$ 10<span>,00</span></div>
            <div class="plan-duration">Publicação ativa por 4 dias</div>
            <ul class="plan-features">
              <li>Publique projetos ilimitados no período</li>
              <li>Página individual para cada projeto</li>
              <li>Participação na comunidade</li>
              <li>Programa de indicação incluso</li>
            </ul>
            <button class="btn btn-ghost btn-block" data-plan="p4">Assinar plano 4 dias</button>
          </div>
          <div class="plan-card featured">
            <span class="plan-name">Plano 7 dias</span>
            <div class="plan-price">R$ 20<span>,00</span></div>
            <div class="plan-duration">Publicação ativa por 7 dias</div>
            <ul class="plan-features">
              <li>Publique projetos ilimitados no período</li>
              <li>Página individual para cada projeto</li>
              <li>Participação na comunidade</li>
              <li>Programa de indicação incluso</li>
              <li>Mais tempo de visibilidade</li>
            </ul>
            <button class="btn btn-gold btn-block" data-plan="p7">Assinar plano 7 dias</button>
          </div>
          <div class="plan-card">
            <span class="plan-name">Plano Mensal</span>
            <div class="plan-price">R$ 50<span>,00</span></div>
            <div class="plan-duration">Válido por 30 dias</div>
            <ul class="plan-features">
              <li>Permite publicar projetos durante todo o período</li>
              <li>Acesso completo à área de publicação</li>
              <li>Expira automaticamente após 30 dias</li>
            </ul>
            <button class="btn btn-ghost btn-block" data-plan="pMensal">Assinar plano mensal</button>
          </div>
        </div>
      </div>
    </section>`;
  }

  function view404() {
    return `<div class="section text-center"><div class="container"><h2>Página não encontrada</h2><p class="muted mt-1">O endereço acessado não existe.</p><a href="#/" class="btn btn-primary mt-3">Voltar para o início</a></div></div>`;
  }

  /* ---------------- DASHBOARD / PERFIL / INDICAÇÕES ---------------- */
  function sideNav(active) {
    const items = [
      ["/painel", "Visão geral"],
      ["/publicar", "Publicar projeto"],
      ["/perfil", "Meu perfil"],
      ["/indicacoes", "Indicações"],
      ["/planos", "Assinatura"],
      ["/comunidade", "Comunidade"],
    ];
    return `<div class="side-title">Meu painel</div>${items
      .map(([p, l]) => `<a class="side-link ${p === active ? "active" : ""}" href="#${p}">${l}</a>`)
      .join("")}`;
  }

  function viewDashboard() {
    const user = currentUser();
    const myProjects = db.projects.filter((p) => p.ownerId === user.id);
    const active = isSubscriptionActive(user);
    return `
    <div class="dash-shell">
      <nav class="dash-sidebar">${sideNav("/painel")}</nav>
      <div class="dash-main">
        <div class="dash-head">
          <div><h1>Olá, ${escapeHtml(user.name.split(" ")[0])} 👋</h1><p>Aqui está um resumo da sua conta em Compartilhar Projetos.</p></div>
          <a href="#/publicar" class="btn btn-gold">+ Publicar projeto</a>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-label">Status da assinatura</div><div class="stat-value" style="font-size:16px">${
            user.role === "admin"
              ? `<span class="badge badge-blue">Administrador</span>`
              : active
              ? `<span class="badge badge-success">Ativa</span>`
              : `<span class="badge badge-danger">Expirada</span>`
          }</div></div>
          <div class="stat-card"><div class="stat-label">Projetos publicados</div><div class="stat-value">${myProjects.length}</div></div>
          <div class="stat-card gold"><div class="stat-label">Comissões disponíveis</div><div class="stat-value">${fmtBRL(availableCommission(user.id))}</div></div>
          <div class="stat-card"><div class="stat-label">Indicações</div><div class="stat-value">${db.referrals.filter((r) => r.referrerId === user.id).length}</div></div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Seus projetos</h3><a href="#/publicar" class="link">Publicar novo →</a></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Projeto</th><th>Categoria</th><th>Publicado em</th><th>Link</th></tr></thead>
              <tbody>
                ${
                  myProjects
                    .map(
                      (p) => `<tr>
                    <td><a href="#/projeto/${p.id}" class="link">${escapeHtml(p.title)}</a></td>
                    <td>${escapeHtml(categoryName(p.categoryId))}</td>
                    <td>${fmtDate(p.createdAt)}</td>
                    <td><a href="${escapeHtml(p.link)}" target="_blank" rel="noopener" class="link">Acessar ↗</a></td>
                  </tr>`
                    )
                    .join("") || `<tr><td colspan="4" class="muted text-center">Você ainda não publicou nenhum projeto.</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>

        ${
          !active && user.role !== "admin"
            ? `<div class="panel" style="border-color:var(--gold-400)"><div class="panel-head"><h3>Sua assinatura expirou</h3></div><p class="muted">Renove seu plano para voltar a publicar novos projetos.</p><a href="#/planos" class="btn btn-gold mt-2">Ver planos</a></div>`
            : ""
        }
      </div>
    </div>`;
  }

  function viewProfile() {
    const user = currentUser();
    return `
    <div class="dash-shell">
      <nav class="dash-sidebar">${sideNav("/perfil")}</nav>
      <div class="dash-main">
        <div class="dash-head"><div><h1>Meu perfil</h1><p>Gerencie suas informações pessoais.</p></div></div>
        <div class="panel" style="max-width:560px">
          <form id="profileForm">
            <div class="field"><label>Nome completo</label><input name="name" value="${escapeHtml(user.name)}" required></div>
            <div class="field"><label>E-mail</label><input value="${escapeHtml(user.email)}" disabled></div>
            <div class="field"><label>CPF ou CNPJ</label><input name="document" value="${escapeHtml(user.document || "")}" placeholder="Somente números" inputmode="numeric"></div>
            <div class="field"><label>Sobre você</label><textarea name="bio" rows="3" placeholder="Fale um pouco sobre o que você cria.">${escapeHtml(user.bio || "")}</textarea></div>
            <button class="btn btn-primary" type="submit">Salvar alterações</button>
          </form>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Status da conta</h3></div>
          <div class="pd-row"><span>Papel</span><span>${user.role === "admin" ? "Administrador" : "Usuário"}</span></div>
          <div class="pd-row"><span>Assinatura</span><span>${isSubscriptionActive(user) ? "Ativa até " + fmtDate(user.subscription.expiresAt) : "Expirada / inexistente"}</span></div>
          <div class="pd-row"><span>Membro desde</span><span>${fmtDate(user.createdAt)}</span></div>
        </div>
      </div>
    </div>`;
  }

  function viewReferrals() {
    const user = currentUser();
    const link = `${location.origin}${location.pathname.replace(/index\.html$/, "")}register.html?ref=${user.refCode}`;
    const myRefs = db.referrals.filter((r) => r.referrerId === user.id);
    const commissions = db.commissions.filter((c) => c.referrerId === user.id);
    return `
    <div class="dash-shell">
      <nav class="dash-sidebar">${sideNav("/indicacoes")}</nav>
      <div class="dash-main">
        <div class="dash-head"><div><h1>Programa de indicação</h1><p>Indique pessoas e ganhe ${Math.round(COMMISSION_RATE * 100)}% de comissão em cada assinatura realizada.</p></div></div>

        <div class="ref-link-box mt-1" style="margin-bottom:30px">
          <code id="refLinkText">${link}</code>
          <button class="btn btn-outline-gold btn-sm" id="copyRefLink" style="border-color:var(--gold-500);color:var(--gold-300,#f0d97a)">Copiar link</button>
        </div>

        <div class="stat-grid">
          <div class="stat-card"><div class="stat-label">Total de indicações</div><div class="stat-value">${myRefs.length}</div></div>
          <div class="stat-card"><div class="stat-label">Comissões pendentes</div><div class="stat-value">${fmtBRL(pendingCommission(user.id))}</div></div>
          <div class="stat-card gold"><div class="stat-label">Comissões disponíveis</div><div class="stat-value">${fmtBRL(availableCommission(user.id))}</div></div>
          <div class="stat-card"><div class="stat-label">Ganhos totais</div><div class="stat-value">${fmtBRL(totalEarnings(user.id))}</div></div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Solicitar saque</h3></div>
          <p class="muted mt-1">Saque mínimo de ${fmtBRL(MIN_WITHDRAW)}. Saldo disponível: <strong>${fmtBRL(availableCommission(user.id))}</strong></p>
          <form id="withdrawForm" class="mt-2" style="max-width:360px">
            <div class="field"><label>Valor do saque</label><input type="number" min="${MIN_WITHDRAW}" step="0.01" name="amount" placeholder="Ex.: 15,00" required></div>
            <div class="field"><label>Chave Pix</label><input type="text" name="pixKey" placeholder="CPF, e-mail, telefone ou chave aleatória" value="${escapeHtml(lastPixKey(user.id))}" required></div>
            <button class="btn btn-gold btn-block" type="submit">Solicitar saque</button>
          </form>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Histórico de ganhos</h3></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Data</th><th>Indicado</th><th>Plano</th><th>Valor</th><th>Status</th></tr></thead>
              <tbody>
                ${
                  commissions
                    .map((c) => {
                      const ref = userById(c.referredId);
                      const label = { pending: ["badge-warning", "Pendente"], available: ["badge-success", "Disponível"], paid: ["badge-neutral", "Pago"] }[c.status];
                      return `<tr><td>${fmtDate(c.createdAt)}</td><td>${escapeHtml(ref ? ref.name : "—")}</td><td>${escapeHtml(PLANS[c.planId] ? PLANS[c.planId].name : "—")}</td><td>${fmtBRL(c.amount)}</td><td><span class="badge ${label[0]}">${label[1]}</span></td></tr>`;
                    })
                    .join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma comissão registrada ainda.</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Solicitações de saque</h3></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Data</th><th>Valor</th><th>Chave Pix</th><th>Status</th></tr></thead>
              <tbody>
                ${
                  db.withdrawals
                    .filter((w) => w.userId === user.id)
                    .map((w) => {
                      const label = { pending: ["badge-warning", "Em análise"], approved: ["badge-success", "Aprovado"], rejected: ["badge-danger", "Recusado"] }[w.status];
                      return `<tr><td>${fmtDate(w.createdAt)}</td><td>${fmtBRL(w.amount)}</td><td>${escapeHtml(w.pixKey || "—")}</td><td><span class="badge ${label[0]}">${label[1]}</span></td></tr>`;
                    })
                    .join("") || `<tr><td colspan="4" class="muted text-center">Nenhum saque solicitado.</td></tr>`
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------
     EVENTOS POR PÁGINA
  --------------------------------------------------------- */
  let pendingImages = [];

  function bindPageEvents(path) {
    const search = qs("#searchInput");
    const catFilter = qs("#catFilter");
    if (search) {
      search.addEventListener("input", debounce(() => updateExploreQuery(), 350));
    }
    if (catFilter) {
      catFilter.addEventListener("change", () => updateExploreQuery());
    }

    // Botões de plano — geram cobrança Pix. Se o usuário ainda não tem
    // CPF/CNPJ cadastrado, pedimos antes de chamar o Worker (exigido pela VizzionPay).
    qsa("[data-plan]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!currentUser()) {
          location.href = "login.html?redirect=planos";
          return;
        }
        const planId = btn.getAttribute("data-plan");
        const originalText = btn.textContent;
        try {
          btn.disabled = true;
          let doc = currentUser().document;
          if (!doc) {
            doc = await showDocumentModal(); // pode rejeitar se o usuário cancelar
          }
          btn.textContent = "Gerando Pix...";
          const result = await startPixPayment(planId, doc);
          showPixModal(result);
        } catch (err) {
          if (err.message !== "cancelado") toast(err.message, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    const publishForm = qs("#publishForm");
    if (publishForm) {
      const imageInput = qs("#imageInput");
      pendingImages = [];
      if (imageInput) {
        imageInput.addEventListener("change", async () => {
          const files = Array.from(imageInput.files).slice(0, 4);
          pendingImages = [];
          for (const f of files) {
            const durl = await fileToDataURL(f);
            pendingImages.push(durl);
          }
          renderUploadPreview();
        });
      }
      publishForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(publishForm);
        qs("#publishError").style.display = "none";
        Promise.resolve()
          .then(() =>
            publishProject({
              title: fd.get("title"),
              description: fd.get("description"),
              categoryId: fd.get("categoryId"),
              link: fd.get("link"),
              ownerName: fd.get("ownerName"),
              contact: fd.get("contact"),
              images: pendingImages,
            })
          )
          .then((project) => {
            toast("Projeto publicado com sucesso!", "success");
            navigate("/projeto/" + project.id);
          })
          .catch((err) => {
            qs("#publishError").textContent = err.message;
            qs("#publishError").style.display = "block";
          });
      });
    }

    const postSubmit = qs("#postSubmit");
    if (postSubmit) {
      postSubmit.addEventListener("click", () => {
        const input = qs("#postInput");
        Promise.resolve()
          .then(() => createPost(input.value))
          .then(() => {
            navigate("/comunidade");
          })
          .catch((err) => toast(err.message, "error"));
      });
    }
    qsa(".comment-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = qs(`[data-post-comments="${btn.getAttribute("data-post")}"]`);
        sec.style.display = sec.style.display === "none" ? "block" : "none";
      });
    });
    qsa(".reply-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const form = qs(`.comment-reply-form[data-post="${btn.getAttribute("data-post")}"][data-comment="${btn.getAttribute("data-comment")}"]`);
        form.style.display = form.style.display === "none" ? "flex" : "none";
      });
    });
    qsa(".comment-new-form").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        Promise.resolve()
          .then(() => createComment(form.getAttribute("data-post"), input.value))
          .then(() => render({ navigation: false }))
          .catch((err) => toast(err.message, "error"));
      });
    });
    qsa(".comment-reply-form:not(.comment-new-form)").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        Promise.resolve()
          .then(() => createReply(form.getAttribute("data-post"), form.getAttribute("data-comment"), input.value))
          .then(() => render({ navigation: false }))
          .catch((err) => toast(err.message, "error"));
      });
    });

    const profileForm = qs("#profileForm");
    if (profileForm) {
      profileForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(profileForm);
        const user = currentUser();
        const rawDoc = fd.get("document");
        const digits = onlyDigits(rawDoc);
        if (digits && !isValidDocument(digits)) {
          toast("CPF ou CNPJ inválido. Use 11 ou 14 dígitos.", "error");
          return;
        }
        updateUserProfile(user.id, {
          name: fd.get("name").trim() || user.name,
          bio: sanitizeText(fd.get("bio") || ""),
          document: digits || user.document || "",
        })
          .then(() => toast("Perfil atualizado!", "success"))
          .catch((err) => toast(err.message, "error"));
      });
    }

    const copyBtn = qs("#copyRefLink");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const text = qs("#refLinkText").textContent;
        navigator.clipboard?.writeText(text).then(
          () => toast("Link copiado!", "success"),
          () => toast("Não foi possível copiar automaticamente. Copie manualmente.", "error")
        );
      });
    }
    const withdrawForm = qs("#withdrawForm");
    if (withdrawForm) {
      withdrawForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(withdrawForm);
        Promise.resolve()
          .then(() => requestWithdrawal(parseFloat(fd.get("amount")), fd.get("pixKey")))
          .then(() => {
            toast("Solicitação de saque enviada!", "success");
            render({ navigation: false });
          })
          .catch((err) => toast(err.message, "error"));
      });
    }
  }

  function renderUploadPreview() {
    const box = qs("#uploadPreview");
    if (!box) return;
    box.innerHTML = pendingImages
      .map((src, i) => `<div class="rm"><img src="${src}"><button type="button" data-i="${i}">×</button></div>`)
      .join("");
    qsa("#uploadPreview button").forEach((b) =>
      b.addEventListener("click", () => {
        pendingImages.splice(parseInt(b.getAttribute("data-i")), 1);
        renderUploadPreview();
      })
    );
  }

  function updateExploreQuery() {
    const q = qs("#searchInput") ? qs("#searchInput").value : "";
    const cat = qs("#catFilter") ? qs("#catFilter").value : "";
    let hash = "/explorar?";
    const parts = [];
    if (q) parts.push("q=" + encodeURIComponent(q));
    if (cat) parts.push("cat=" + encodeURIComponent(cat));
    location.hash = hash + parts.join("&");
    // location.hash já dispara 'hashchange' -> render({navigation:true});
    // nenhuma chamada extra necessária aqui.
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /* ---------------------------------------------------------
     HEADER GLOBAL (menu usuário, hambúrguer)
  --------------------------------------------------------- */
  function bindGlobalUI() {
    const avatarBtn = qs("#avatarBtn");
    const userMenu = qs("#userMenu");
    if (avatarBtn) {
      avatarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        userMenu.classList.toggle("open");
      });
      document.addEventListener("click", () => userMenu.classList.remove("open"));
    }
    ["logoutBtn", "logoutBtnMobile"].forEach((id) => {
      const btn = qs("#" + id);
      if (btn) {
        btn.addEventListener("click", async () => {
          await logoutUser();
          toast("Você saiu da sua conta.");
          navigate("/");
        });
      }
    });
    const hamburger = qs("#hamburgerBtn");
    const mobileNav = qs("#mobileNav");
    if (hamburger) {
      hamburger.addEventListener("click", () => {
        mobileNav.classList.toggle("open");
      });
      qsa("#mobileNav a, #mobileNav button").forEach((el) => el.addEventListener("click", () => mobileNav.classList.remove("open")));
    }
  }

  /* ---------------------------------------------------------
     TEMPO REAL — Firebase Auth + Realtime Database
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => {
    firebaseUser = user;
    authReady = true;
    // Ao mudar o estado de login, os nós protegidos (users, referrals,
    // commissions, withdrawals) são recarregados do zero pelo db-sync.js
    // — isso é assíncrono. Até esses dados chegarem, "db.users" pode
    // estar vazio/desatualizado. Resetar dbReady aqui faz o render()
    // mostrar "Carregando…" nesse intervalo, em vez de concluir (errado)
    // que o usuário não está logado e redirecionar pro login.
    dbReady = false;
    // Mudança de sessão (login/logout) é um evento raro e sempre muda
    // significativamente o que a tela mostra — trata como navegação.
    render({ navigation: true });
  });

  onDBChange((newDb) => {
    db = newDb;
    dbReady = true;
    // Atualização de dado em segundo plano — nunca força scroll nem
    // interrompe quem estiver digitando (ver hasActiveFormField acima).
    render({ navigation: false });
  });

  window.addEventListener("hashchange", () => render({ navigation: true }));
  document.addEventListener("DOMContentLoaded", () => {
    bindGlobalUI();
    render({ navigation: true });
  });
})();
