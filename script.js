/* =========================================================
   COMPARTILHAR PROJETOS — SCRIPT.JS
   SPA leve, agora sincronizada com o Firebase Realtime Database
   em vez de localStorage. Autenticação via Firebase Auth.
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDB, saveDB, onDBChange } from "./db-sync.js";
import { uid, nowISO } from "./seed.js";

(function () {
  "use strict";

  const PLANS = {
    p4: { id: "p4", name: "Plano 4 Dias", price: 10, days: 4 },
    p7: { id: "p7", name: "Plano 7 Dias", price: 20, days: 7 },
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

  /* ---------------------------------------------------------
     AÇÕES DE NEGÓCIO
     (login e cadastro ficam em auth.js — login.html / register.html)
  --------------------------------------------------------- */
  function subscribeToPlan(planId) {
    const user = currentUser();
    if (!user) throw new Error("Você precisa entrar na sua conta.");
    const plan = PLANS[planId];
    if (!plan) throw new Error("Plano inválido.");

    const now = new Date();
    const base = isSubscriptionActive(user) ? new Date(user.subscription.expiresAt) : now;
    const expires = new Date(base.getTime() + plan.days * 24 * 60 * 60 * 1000);
    user.subscription = { active: true, plan: plan.id, expiresAt: expires.toISOString() };

    // comissão de indicação — apenas na primeira assinatura do indicado
    if (user.referredBy) {
      const alreadyCommissioned = db.commissions.some((c) => c.referredId === user.id);
      if (!alreadyCommissioned) {
        const amount = Math.round(plan.price * COMMISSION_RATE * 100) / 100;
        db.commissions.push({
          id: uid("cm2"),
          referrerId: user.referredBy,
          referredId: user.id,
          amount,
          status: "pending",
          createdAt: nowISO(),
          planId: plan.id,
        });
      }
    }
    saveDB(db);
    return user;
  }

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
    db.projects.unshift(project);
    saveDB(db);
    return project;
  }

  function createPost(content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para publicar.");
    if (!content || content.trim().length < 2) throw new Error("Escreva algo antes de publicar.");
    const post = { id: uid("post"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO(), comments: [] };
    db.posts.unshift(post);
    saveDB(db);
    return post;
  }

  function createComment(postId, content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para comentar.");
    if (!content || !content.trim()) throw new Error("Escreva um comentário.");
    const post = db.posts.find((p) => p.id === postId);
    if (!post) throw new Error("Publicação não encontrada.");
    post.comments.push({ id: uid("cm"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO(), replies: [] });
    saveDB(db);
  }

  function createReply(postId, commentId, content) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta para responder.");
    if (!content || !content.trim()) throw new Error("Escreva uma resposta.");
    const post = db.posts.find((p) => p.id === postId);
    const comment = post && post.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error("Comentário não encontrado.");
    comment.replies.push({ id: uid("rp"), authorId: user.id, content: sanitizeText(content.trim()), createdAt: nowISO() });
    saveDB(db);
  }

  function requestWithdrawal(amount, pixKey) {
    const user = currentUser();
    if (!user) throw new Error("Entre na sua conta.");
    const available = availableCommission(user.id);
    if (!pixKey || !pixKey.trim()) throw new Error("Informe sua chave Pix para receber o saque.");
    if (amount < MIN_WITHDRAW) throw new Error(`O saque mínimo é ${fmtBRL(MIN_WITHDRAW)}.`);
    if (amount > available) throw new Error("Valor solicitado maior que o saldo disponível.");
    db.withdrawals.push({
      id: uid("wd"),
      userId: user.id,
      amount,
      pixKey: sanitizeText(pixKey.trim()),
      status: "pending",
      createdAt: nowISO(),
    });
    saveDB(db);
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

  // simula "liberação" de comissões pendentes (para fins de demo, liberamos direto)
  function maturateCommissions() {
    let changed = false;
    db.commissions.forEach((c) => {
      if (c.status === "pending") {
        c.status = "available";
        changed = true;
      }
    });
    if (changed) saveDB(db);
  }

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

  function render() {
    // ainda carregando dados do Firebase (auth e/ou banco) — mostra um loading simples
    if (!authReady || !dbReady) {
      const app = qs("#app");
      if (app) app.innerHTML = `<div class="section text-center"><div class="container"><p class="muted">Carregando…</p></div></div>`;
      return;
    }

    maturateCommissions();
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
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    refreshHeader();
    bindPageEvents(path);
  }

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
            <div class="field-hint">Envie até 4 imagens (convertidas para base64 e salvas no banco nesta demonstração).</div>
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
            ? `<div class="badge badge-blue mt-2">Administradores podem publicar sem assinatura</div>`
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

    qsa("[data-plan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!currentUser()) {
          location.href = "login.html?redirect=planos";
          return;
        }
        try {
          const plan = PLANS[btn.getAttribute("data-plan")];
          subscribeToPlan(plan.id);
          toast(`Assinatura confirmada — ${plan.name}!`, "success");
          render();
        } catch (err) {
          toast(err.message, "error");
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
        try {
          const project = publishProject({
            title: fd.get("title"),
            description: fd.get("description"),
            categoryId: fd.get("categoryId"),
            link: fd.get("link"),
            ownerName: fd.get("ownerName"),
            contact: fd.get("contact"),
            images: pendingImages,
          });
          toast("Projeto publicado com sucesso!", "success");
          navigate("/projeto/" + project.id);
        } catch (err) {
          qs("#publishError").textContent = err.message;
          qs("#publishError").style.display = "block";
        }
      });
    }

    const postSubmit = qs("#postSubmit");
    if (postSubmit) {
      postSubmit.addEventListener("click", () => {
        const input = qs("#postInput");
        try {
          createPost(input.value);
          render();
          navigate("/comunidade");
          setTimeout(() => render(), 0);
        } catch (err) {
          toast(err.message, "error");
        }
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
        try {
          createComment(form.getAttribute("data-post"), input.value);
          render();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    qsa(".comment-reply-form:not(.comment-new-form)").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        try {
          createReply(form.getAttribute("data-post"), form.getAttribute("data-comment"), input.value);
          render();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });

    const profileForm = qs("#profileForm");
    if (profileForm) {
      profileForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(profileForm);
        const user = currentUser();
        user.name = fd.get("name").trim() || user.name;
        user.bio = sanitizeText(fd.get("bio") || "");
        saveDB(db);
        toast("Perfil atualizado!", "success");
        render();
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
        try {
          requestWithdrawal(parseFloat(fd.get("amount")), fd.get("pixKey"));
          toast("Solicitação de saque enviada!", "success");
          render();
        } catch (err) {
          toast(err.message, "error");
        }
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
    render();
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
          render();
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
     Substitui o antigo evento "storage" do localStorage: agora
     a sincronização funciona entre dispositivos diferentes.
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => {
    firebaseUser = user;
    authReady = true;
    render();
  });

  onDBChange((newDb) => {
    db = newDb;
    dbReady = true;
    render();
  });

  window.addEventListener("hashchange", render);
  document.addEventListener("DOMContentLoaded", () => {
    bindGlobalUI();
    render();
  });
})();
