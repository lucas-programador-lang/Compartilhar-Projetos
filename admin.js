/* =========================================================
   COMPARTILHAR PROJETOS — ADMIN.JS
   Painel administrativo. Agora sincronizado com o Firebase
   Realtime Database (mesmo nó usado por script.js).
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDB, saveDB, onDBChange } from "./db-sync.js";

(function () {
  "use strict";

  const PLAN_NAMES = { p4: "Plano 4 Dias", p7: "Plano 7 Dias" };
  const MIN_WITHDRAW = 10;

  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;

  function currentUser() {
    if (!db || !firebaseUser) return null;
    return db.users.find((u) => u.id === firebaseUser.uid) || null;
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
    const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
    stack.appendChild(el);
    const dismiss = () => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(dismiss, 3400);
  }

  function confirmAction(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = qs("#confirmOverlay");
      const box = overlay.querySelector(".confirm-box");
      const icon = qs("#confirmIcon");
      const titleEl = qs("#confirmTitle");
      const msgEl = qs("#confirmMessage");
      const okBtn = qs("#confirmOkBtn");
      const cancelBtn = qs("#confirmCancelBtn");

      titleEl.textContent = opts.title || "Confirmar ação";
      msgEl.textContent = message;
      okBtn.textContent = opts.confirmLabel || "Sim, excluir";
      cancelBtn.textContent = opts.cancelLabel || "Cancelar";
      box.classList.toggle("is-neutral", !!opts.neutral);
      icon.textContent = opts.neutral ? "?" : "!";

      overlay.classList.add("open");
      okBtn.focus();

      function settle(result) {
        overlay.classList.remove("open");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        overlay.removeEventListener("mousedown", onOverlayClick);
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onOk() {
        settle(true);
      }
      function onCancel() {
        settle(false);
      }
      function onOverlayClick(e) {
        if (e.target === overlay) settle(false);
      }
      function onKey(e) {
        if (e.key === "Escape") settle(false);
        if (e.key === "Enter") settle(true);
      }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      overlay.addEventListener("mousedown", onOverlayClick);
      document.addEventListener("keydown", onKey);
    });
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
    // ainda não sabemos se está logado / dados ainda não chegaram
    if (!authReady || !dbReady) return;

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
      // evita registrar o listener mais de uma vez a cada boot()
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        qsa("#adminNav button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        qsa(".section-block").forEach((s) => s.classList.remove("active"));
        qs("#sec-" + btn.getAttribute("data-section")).classList.add("active");
      });
    });
    const logoutBtn = qs("#adminLogout");
    if (logoutBtn && !logoutBtn.dataset.bound) {
      logoutBtn.dataset.bound = "1";
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await signOut(auth);
        location.href = "index.html";
      });
    }
  }

  /* ---------------------------------------------------------
     RENDER ALL
  --------------------------------------------------------- */
  function renderAll() {
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
                   <button class="btn btn-sm btn-ghost" data-promote="${u.id}">Tornar admin</button>
                   <button class="btn btn-sm btn-danger" data-deluser="${u.id}">Excluir</button>`
                : `<button class="btn btn-sm btn-ghost" data-demote="${u.id}">Remover admin</button>`
            }
          </td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="6" class="muted text-center">Nenhum usuário encontrado.</td></tr>`;

    qsa("[data-suspend]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const u = userById(btn.getAttribute("data-suspend"));
        u.suspended = !u.suspended;
        saveDB(db);
        toast(u.suspended ? "Usuário suspenso." : "Usuário reativado.", "success");
        renderAll();
      })
    );
    qsa("[data-promote]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const u = userById(btn.getAttribute("data-promote"));
        const ok = await confirmAction(`Tornar "${u.name}" um administrador? Isto dá acesso total ao painel admin.`, {
          title: "Promover a admin",
          neutral: true,
          confirmLabel: "Sim, promover",
        });
        if (!ok) return;
        u.role = "admin";
        u.isAdmin = true;
        saveDB(db);
        toast(`${u.name} agora é administrador.`, "success");
        renderAll();
      })
    );
    qsa("[data-demote]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const u = userById(btn.getAttribute("data-demote"));
        if (u.id === currentUser().id) {
          toast("Você não pode remover seu próprio acesso de administrador.", "error");
          return;
        }
        const ok = await confirmAction(`Remover o acesso de administrador de "${u.name}"?`, {
          title: "Remover admin",
          neutral: true,
          confirmLabel: "Sim, remover",
        });
        if (!ok) return;
        u.role = "user";
        u.isAdmin = false;
        saveDB(db);
        toast(`Acesso de administrador removido de ${u.name}.`, "success");
        renderAll();
      })
    );
    qsa("[data-deluser]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const ok = await confirmAction(
          "Excluir este usuário permanentemente? Isto remove o perfil do banco de dados — a conta de login (Firebase Authentication) deve ser removida separadamente pelo console do Firebase.",
          { title: "Excluir usuário" }
        );
        if (!ok) return;
        const id = btn.getAttribute("data-deluser");
        db.users = db.users.filter((u) => u.id !== id);
        saveDB(db);
        toast("Usuário excluído do banco de dados.", "success");
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
      btn.addEventListener("click", async () => {
        const ok = await confirmAction("Excluir este projeto? Ele deixará de aparecer para todos os usuários.", { title: "Excluir projeto" });
        if (!ok) return;
        db.projects = db.projects.filter((p) => p.id !== btn.getAttribute("data-delproj"));
        saveDB(db);
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
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-delcat");
        const inUse = db.projects.some((p) => p.categoryId === id);
        if (inUse) {
          const ok = await confirmAction("Existem projetos usando essa categoria. Remover mesmo assim?", { title: "Remover categoria" });
          if (!ok) return;
        }
        db.categories = db.categories.filter((c) => c.id !== id);
        saveDB(db);
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
      btn.addEventListener("click", async () => {
        const ok = await confirmAction("Excluir esta publicação e todos os comentários?", { title: "Excluir publicação" });
        if (!ok) return;
        db.posts = db.posts.filter((p) => p.id !== btn.getAttribute("data-delpost"));
        saveDB(db);
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
          <td class="muted" style="font-family:var(--font-mono);font-size:12.5px">${escapeHtml(w.pixKey || "—")}</td>
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
        .join("") || `<tr><td colspan="6" class="muted text-center">Nenhuma solicitação de saque (mínimo ${fmtBRL(MIN_WITHDRAW)}).</td></tr>`;

    qsa("[data-approve]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const w = db.withdrawals.find((w) => w.id === btn.getAttribute("data-approve"));
        w.status = "approved";
        let remaining = w.amount;
        db.commissions
          .filter((c) => c.referrerId === w.userId && c.status === "available")
          .forEach((c) => {
            if (remaining > 0) {
              c.status = "paid";
              remaining -= c.amount;
            }
          });
        saveDB(db);
        toast("Saque aprovado.", "success");
        renderAll();
      })
    );
    qsa("[data-reject]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const w = db.withdrawals.find((w) => w.id === btn.getAttribute("data-reject"));
        w.status = "rejected";
        saveDB(db);
        toast("Saque recusado.", "success");
        renderAll();
      })
    );
  }

  /* ---------------------------------------------------------
     FORMULÁRIOS (busca, nova categoria)
  --------------------------------------------------------- */
  function bindForms() {
    const userSearch = qs("#userSearch");
    if (userSearch && !userSearch.dataset.bound) {
      userSearch.dataset.bound = "1";
      userSearch.addEventListener("input", (e) => renderUsers(e.target.value));
    }
    const projectSearch = qs("#projectSearch");
    if (projectSearch && !projectSearch.dataset.bound) {
      projectSearch.dataset.bound = "1";
      projectSearch.addEventListener("input", (e) => renderProjects(e.target.value));
    }
    const catForm = qs("#catForm");
    if (catForm && !catForm.dataset.bound) {
      catForm.dataset.bound = "1";
      catForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = qs("#newCatName");
        const name = input.value.trim();
        if (!name) return;
        if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          toast("Essa categoria já existe.", "error");
          return;
        }
        db.categories.push({ id: "c_" + Math.random().toString(36).slice(2, 9), name });
        saveDB(db);
        input.value = "";
        toast("Categoria adicionada.", "success");
        renderAll();
      });
    }
  }

  /* ---------------------------------------------------------
     TEMPO REAL — Firebase Auth + Realtime Database
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => {
    firebaseUser = user;
    authReady = true;
    boot();
  });

  onDBChange((newDb) => {
    db = newDb;
    dbReady = true;
    boot();
  });

  document.addEventListener("DOMContentLoaded", boot);
})();
