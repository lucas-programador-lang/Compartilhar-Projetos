/* =========================================================
   COMPARTILHAR PROJETOS — ADMIN.JS
   Painel administrativo. Compartilha o mesmo "banco de dados"
   (localStorage) usado em script.js.
   ========================================================= */

(function () {
  "use strict";

  const DB_KEY = "cp_database_v1";
  const SESSION_KEY = "cp_session_v1";
  const PLAN_NAMES = { p4: "Plano 4 Dias", p7: "Plano 7 Dias" };
  const MIN_WITHDRAW = 10;

  function loadDB() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY));
    } catch (e) {
      return null;
    }
  }
  function saveDB() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (e) {
      return null;
    }
  }

  let db = loadDB();

  function currentUser() {
    const s = getSession();
    if (!s || !db) return null;
    return db.users.find((u) => u.id === s.userId) || null;
  }

  /* ---------- utils ---------- */
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
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtBRL(v) {
    return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }
  function userById(id) {
    return db.users.find((u) => u.id === id);
  }
  function isSubActive(u) {
    return !!(u.subscription && u.subscription.active && new Date(u.subscription.expiresAt) > new Date());
  }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
  function confirmAction(msg) {
    return window.confirm(msg);
  }

  function availableCommission(userId) {
    const earned = db.commissions
      .filter((c) => c.referrerId === userId && c.status === "available")
      .reduce((s, c) => s + c.amount, 0);
    const withdrawn = db.withdrawals
      .filter((w) => w.userId === userId && (w.status === "approved" || w.status === "pending"))
      .reduce((s, w) => s + w.amount, 0);
    return Math.max(0, Math.round((earned - withdrawn) * 100) / 100);
  }

  /* ---------------------------------------------------------
     GATE — só administradores acessam
  --------------------------------------------------------- */
  function boot() {
    db = loadDB();
    const user = currentUser();
    if (!db || !user || user.role !== "admin") {
      qs("#gateScreen").style.display = "flex";
      qs("#adminShell").style.display = "none";
      return;
    }
    qs("#gateScreen").style.display = "none";
    qs("#adminShell").style.display = "grid";
    bindNav();
    bindForms();
    renderAll();
  }

  function bindNav() {
    qsa("#adminNav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        qsa("#adminNav button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        qsa(".section-block").forEach((s) => s.classList.remove("active"));
        qs("#sec-" + btn.getAttribute("data-section")).classList.add("active");
      });
    });
    qs("#adminLogout").addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem(SESSION_KEY);
      location.href = "index.html";
    });
  }

  /* ---------------------------------------------------------
     RENDER ALL
  --------------------------------------------------------- */
  function renderAll() {
    db = loadDB();
    renderOverview();
    renderUsers();
    renderSubscriptions();
    renderProjects();
    renderCategories();
    renderCommunity();
    renderReferrals();
    renderWithdrawals();
  }

  function renderOverview() {
    const activeSubs = db.users.filter(isSubActive).length;
    const revenue = db.commissions.reduce((s, c) => s + c.amount / 0.3, 0); // aproxima receita bruta a partir das comissões geradas
    const totalRevenueEstimate = estimateRevenue();
    qs("#statGrid").innerHTML = [
      stat("Usuários cadastrados", db.users.length),
      stat("Assinaturas ativas", activeSubs),
      stat("Projetos publicados", db.projects.length),
      stat("Publicações na comunidade", db.posts.length),
      stat("Receita estimada", fmtBRL(totalRevenueEstimate), true),
      stat("Comissões pendentes de saque", fmtBRL(db.withdrawals.filter((w) => w.status === "pending").reduce((s, w) => s + w.amount, 0)), true),
    ].join("");

    const recent = db.projects.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
    qs("#recentProjectsTable tbody").innerHTML =
      recent
        .map((p) => {
          const owner = userById(p.ownerId);
          return `<tr><td>${escapeHtml(p.title)}</td><td>${escapeHtml(owner ? owner.name : "—")}</td><td>${escapeHtml(catName(p.categoryId))}</td><td>${fmtDate(p.createdAt)}</td></tr>`;
        })
        .join("") || `<tr><td colspan="4" class="muted text-center">Nenhum projeto ainda.</td></tr>`;
  }

  function estimateRevenue() {
    // soma o valor de cada assinatura ativa/expirada com base no plano atual salvo por usuário (aproximação para fins de demonstração)
    return db.users.reduce((sum, u) => {
      if (u.subscription && u.subscription.plan) {
        const price = u.subscription.plan === "p4" ? 10 : u.subscription.plan === "p7" ? 20 : 0;
        return sum + price;
      }
      return sum;
    }, 0);
  }

  function stat(label, value, gold) {
    return `<div class="stat-card${gold ? " gold" : ""}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  }
  function catName(id) {
    const c = db.categories.find((c) => c.id === id);
    return c ? c.name : "Geral";
  }

  /* ---------------------------------------------------------
     USUÁRIOS
  --------------------------------------------------------- */
  function renderUsers(filter) {
    filter = (filter || "").toLowerCase();
    const list = db.users.filter((u) => !filter || u.name.toLowerCase().includes(filter) || u.email.toLowerCase().includes(filter));
    qs("#usersTable tbody").innerHTML =
      list
        .map((u) => {
          const active = isSubActive(u);
          return `<tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${u.role === "admin" ? `<span class="badge badge-blue">Admin</span>` : `<span class="badge badge-neutral">Usuário</span>`}</td>
          <td>${active ? `<span class="badge badge-success">Ativa</span>` : `<span class="badge badge-neutral">Sem assinatura</span>`}</td>
          <td>${u.suspended ? `<span class="badge badge-danger">Suspenso</span>` : `<span class="badge badge-success">Ok</span>`}</td>
          <td class="flex gap-1">
            ${
              u.role !== "admin"
                ? `<button class="btn btn-sm ${u.suspended ? "btn-ghost" : "btn-danger"}" data-suspend="${u.id}">${u.suspended ? "Reativar" : "Suspender"}</button>
                   <button class="btn btn-sm btn-danger" data-deluser="${u.id}">Excluir</button>`
                : `<span class="muted" style="font-size:12px">Conta protegida</span>`
            }
          </td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="6" class="muted text-center">Nenhum usuário encontrado.</td></tr>`;

    qsa("[data-suspend]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const u = userById(btn.getAttribute("data-suspend"));
        u.suspended = !u.suspended;
        saveDB();
        toast(u.suspended ? "Usuário suspenso." : "Usuário reativado.", "success");
        renderAll();
      })
    );
    qsa("[data-deluser]").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (!confirmAction("Excluir este usuário permanentemente? Esta ação não pode ser desfeita.")) return;
        const id = btn.getAttribute("data-deluser");
        db.users = db.users.filter((u) => u.id !== id);
        saveDB();
        toast("Usuário excluído.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     ASSINATURAS
  --------------------------------------------------------- */
  function renderSubscriptions() {
    const subbed = db.users.filter((u) => u.subscription && u.subscription.plan);
    const active = subbed.filter(isSubActive).length;
    const expired = subbed.length - active;
    qs("#subStatGrid").innerHTML = [
      stat("Assinaturas ativas", active),
      stat("Assinaturas expiradas", expired),
      stat("Receita estimada", fmtBRL(estimateRevenue()), true),
    ].join("");

    qs("#subsTable tbody").innerHTML =
      subbed
        .map((u) => {
          const active = isSubActive(u);
          return `<tr><td>${escapeHtml(u.name)}</td><td>${PLAN_NAMES[u.subscription.plan] || "—"}</td><td>${fmtDate(u.subscription.expiresAt)}</td><td>${
            active ? `<span class="badge badge-success">Ativa</span>` : `<span class="badge badge-danger">Expirada</span>`
          }</td></tr>`;
        })
        .join("") || `<tr><td colspan="4" class="muted text-center">Nenhuma assinatura registrada.</td></tr>`;
  }

  /* ---------------------------------------------------------
     PROJETOS
  --------------------------------------------------------- */
  function renderProjects(filter) {
    filter = (filter || "").toLowerCase();
    const list = db.projects.filter((p) => !filter || p.title.toLowerCase().includes(filter));
    qs("#projectsTable tbody").innerHTML =
      list
        .map((p) => {
          const owner = userById(p.ownerId);
          return `<tr>
          <td><a href="index.html#/projeto/${p.id}" target="_blank" class="link">${escapeHtml(p.title)}</a></td>
          <td>${escapeHtml(owner ? owner.name : "—")}</td>
          <td>${escapeHtml(catName(p.categoryId))}</td>
          <td>${fmtDate(p.createdAt)}</td>
          <td><button class="btn btn-sm btn-danger" data-delproj="${p.id}">Excluir</button></td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted text-center">Nenhum projeto encontrado.</td></tr>`;

    qsa("[data-delproj]").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (!confirmAction("Excluir este projeto?")) return;
        db.projects = db.projects.filter((p) => p.id !== btn.getAttribute("data-delproj"));
        saveDB();
        toast("Projeto excluído.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     CATEGORIAS
  --------------------------------------------------------- */
  function renderCategories() {
    qs("#catsTable tbody").innerHTML = db.categories
      .map((c) => {
        const count = db.projects.filter((p) => p.categoryId === c.id).length;
        return `<tr><td>${escapeHtml(c.name)}</td><td>${count}</td><td><button class="btn btn-sm btn-danger" data-delcat="${c.id}">Remover</button></td></tr>`;
      })
      .join("");

    qsa("[data-delcat]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-delcat");
        const inUse = db.projects.some((p) => p.categoryId === id);
        if (inUse && !confirmAction("Existem projetos usando essa categoria. Remover mesmo assim?")) return;
        db.categories = db.categories.filter((c) => c.id !== id);
        saveDB();
        toast("Categoria removida.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     COMUNIDADE
  --------------------------------------------------------- */
  function renderCommunity() {
    qs("#communityTable tbody").innerHTML =
      db.posts
        .map((p) => {
          const author = userById(p.authorId);
          return `<tr>
          <td>${escapeHtml(author ? author.name : "—")}</td>
          <td style="max-width:320px">${escapeHtml(p.content).slice(0, 140)}${p.content.length > 140 ? "…" : ""}</td>
          <td>${p.comments.length}</td>
          <td>${fmtDate(p.createdAt)}</td>
          <td><button class="btn btn-sm btn-danger" data-delpost="${p.id}">Excluir</button></td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma publicação na comunidade.</td></tr>`;

    qsa("[data-delpost]").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (!confirmAction("Excluir esta publicação e todos os comentários?")) return;
        db.posts = db.posts.filter((p) => p.id !== btn.getAttribute("data-delpost"));
        saveDB();
        toast("Publicação removida.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     INDICAÇÕES / COMISSÕES
  --------------------------------------------------------- */
  function renderReferrals() {
    qs("#refStatGrid").innerHTML = [
      stat("Total de indicações", db.referrals.length),
      stat("Comissões geradas", fmtBRL(db.commissions.reduce((s, c) => s + c.amount, 0)), true),
      stat("Comissões pagas", fmtBRL(db.withdrawals.filter((w) => w.status === "approved").reduce((s, w) => s + w.amount, 0))),
    ].join("");

    qs("#refsTable tbody").innerHTML =
      db.commissions
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((c) => {
          const referrer = userById(c.referrerId);
          const referred = userById(c.referredId);
          const label = { pending: ["badge-warning", "Pendente"], available: ["badge-success", "Disponível"], paid: ["badge-neutral", "Pago"] }[c.status];
          return `<tr><td>${escapeHtml(referrer ? referrer.name : "—")}</td><td>${escapeHtml(referred ? referred.name : "—")}</td><td>${fmtBRL(c.amount)}</td><td><span class="badge ${label[0]}">${label[1]}</span></td><td>${fmtDate(c.createdAt)}</td></tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma comissão registrada.</td></tr>`;
  }

  /* ---------------------------------------------------------
     SAQUES
  --------------------------------------------------------- */
  function renderWithdrawals() {
    qs("#withdrawTable tbody").innerHTML =
      db.withdrawals
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((w) => {
          const u = userById(w.userId);
          const label = { pending: ["badge-warning", "Em análise"], approved: ["badge-success", "Aprovado"], rejected: ["badge-danger", "Recusado"] }[w.status];
          return `<tr>
          <td>${escapeHtml(u ? u.name : "—")}</td>
          <td>${fmtBRL(w.amount)}</td>
          <td>${fmtDate(w.createdAt)}</td>
          <td><span class="badge ${label[0]}">${label[1]}</span></td>
          <td class="flex gap-1">
            ${
              w.status === "pending"
                ? `<button class="btn btn-sm btn-primary" data-approve="${w.id}">Aprovar</button><button class="btn btn-sm btn-danger" data-reject="${w.id}">Recusar</button>`
                : `<span class="muted" style="font-size:12px">Concluído</span>`
            }
          </td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma solicitação de saque (mínimo ${fmtBRL(MIN_WITHDRAW)}).</td></tr>`;

    qsa("[data-approve]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const w = db.withdrawals.find((w) => w.id === btn.getAttribute("data-approve"));
        w.status = "approved";
        // marca comissões disponíveis correspondentes como pagas (aproximação simples por ordem)
        let remaining = w.amount;
        db.commissions
          .filter((c) => c.referrerId === w.userId && c.status === "available")
          .forEach((c) => {
            if (remaining > 0) {
              c.status = "paid";
              remaining -= c.amount;
            }
          });
        saveDB();
        toast("Saque aprovado.", "success");
        renderAll();
      })
    );
    qsa("[data-reject]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const w = db.withdrawals.find((w) => w.id === btn.getAttribute("data-reject"));
        w.status = "rejected";
        saveDB();
        toast("Saque recusado.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     FORMULÁRIOS (busca, nova categoria)
  --------------------------------------------------------- */
  function bindForms() {
    qs("#userSearch").addEventListener("input", (e) => renderUsers(e.target.value));
    qs("#projectSearch").addEventListener("input", (e) => renderProjects(e.target.value));
    qs("#catForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = qs("#newCatName");
      const name = input.value.trim();
      if (!name) return;
      if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        toast("Essa categoria já existe.", "error");
        return;
      }
      db.categories.push({ id: "c_" + Math.random().toString(36).slice(2, 9), name });
      saveDB();
      input.value = "";
      toast("Categoria adicionada.", "success");
      renderAll();
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
