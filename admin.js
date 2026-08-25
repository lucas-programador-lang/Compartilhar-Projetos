/* =========================================================
   COMPARTILHAR PROJETOS — ADMIN.JS (v7 + CHAT + RANKING)
   Painel administrativo. Leitura em tempo real via db-sync.js
   (Firebase Realtime Database). Toda ESCRITA administrativa
   passa pelo Worker (/admin/*).
   ========================================================= */

import { auth, rtdb } from "./firebase-config.js"; 
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { ref, onValue, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js"; 
import { getDB, onDBChange, isDBSynced } from "./db-sync.js";

(function () {
  "use strict";

  const WORKER_BASE_URL = "https://api.compartilhar-projetos.com.br";

  // Nomes de exibição
  const PLAN_NAMES = {
    pTeste: "Plano Teste",
    p4: "Plano 4 Dias",
    p7: "Plano 7 Dias",
    pMensal: "Plano Mensal",
  };
  
  // Preços
  const PLAN_PRICES = {
    pTeste: 5,
    p4: 10,
    p7: 20,
    pMensal: 50,
  };
  const MIN_WITHDRAW = 10;

  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;

  let currentUserFilter = "";
  let currentProjectFilter = "";

  // Variáveis de estado do Chat Admin
  let chatBound = false;
  let currentActiveChatUser = null;

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
      function onOk() { settle(true); }
      function onCancel() { settle(false); }
      function onOverlayClick(e) { if (e.target === overlay) settle(false); }
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

  /* ---------------------------------------------------------
     WORKER — chamadas administrativas autenticadas
  --------------------------------------------------------- */
  async function adminFetch(path, body) {
    if (!firebaseUser) throw new Error("Sessão expirada. Faça login novamente.");
    const idToken = await firebaseUser.getIdToken();
    const res = await fetch(WORKER_BASE_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + idToken,
      },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch { }
    if (!res.ok) {
      throw new Error((data && data.message) || `Falha na requisição (${res.status})`);
    }
    return data;
  }

  async function withButtonLock(btn, fn) {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const prevDisabled = btn.disabled;
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err.message || "Falha ao processar solicitação.", "error");
    } finally {
      btn.dataset.busy = "";
      btn.disabled = prevDisabled;
    }
  }

  /* ---------------------------------------------------------
     LOADING
  --------------------------------------------------------- */
  function showLoading(show) {
    let el = document.getElementById("adminLoadingScreen");
    if (!el) {
      el = document.createElement("div");
      el.id = "adminLoadingScreen";
      el.style.cssText =
        "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
        "background:#0b0b0f;color:#fff;font:500 14px system-ui,sans-serif;z-index:9999;";
      el.textContent = "Carregando painel administrativo…";
      document.body.appendChild(el);
    }
    el.style.display = show ? "flex" : "none";
  }

  /* ---------------------------------------------------------
     GATE
  --------------------------------------------------------- */
  function boot() {
    if (!authReady || !dbReady) {
      showLoading(true);
      return;
    }
    showLoading(false);

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
    bindChat(); // Inicializa o chat admin
    renderAll();
  }

  function bindNav() {
    qsa("#adminNav button").forEach((btn) => {
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
    renderUsers(currentUserFilter);
    renderSubscriptions();
    renderProjects(currentProjectFilter);
    renderCategories();
    renderCommunity();
    renderReferrals();
    renderWithdrawals();
    renderRankingPrizes(); // <--- Ranking adicionado aqui
  }

  function renderOverview() {
    const activeSubs = db.users.filter(isSubActive).length;
    const totalRevenueEstimate = estimateRevenue();
    const pendingWithdrawals = db.withdrawals.filter((w) => w.status === "pending").reduce((s, w) => s + w.amount, 0);
    const publishedCount = db.projects.filter((p) => p.status === "published").length;
    const pendingModerationCount = db.projects.filter((p) => p.status === "pending").length;
    qs("#statGrid").innerHTML = [
      stat("Usuários cadastrados", db.users.length),
      stat("Assinaturas ativas", activeSubs),
      stat("Projetos publicados", publishedCount),
      stat("Projetos aguardando moderação", pendingModerationCount, pendingModerationCount > 0),
      stat("Publicações na comunidade", db.posts.length),
      stat("Receita estimada", fmtBRL(totalRevenueEstimate), true),
      stat("Saques aguardando aprovação", fmtBRL(pendingWithdrawals), true),
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
        const price = PLAN_PRICES[u.subscription.plan] || 0;
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
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const u = userById(btn.getAttribute("data-suspend"));
          const result = await adminFetch("/admin/toggle-suspend", { targetUserId: u.id });
          toast(result.suspended ? "Usuário suspenso." : "Usuário reativado.", "success");
          renderAll();
        })
      )
    );
    qsa("[data-promote]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const u = userById(btn.getAttribute("data-promote"));
          const ok = await confirmAction(`Tornar "${u.name}" um administrador? Isto dá acesso total ao painel admin.`, {
            title: "Promover a admin",
            neutral: true,
            confirmLabel: "Sim, promover",
          });
          if (!ok) return;
          await adminFetch("/admin/set-role", { targetUserId: u.id, role: "admin" });
          toast(`${u.name} agora é administrador.`, "success");
          renderAll();
        })
      )
    );
    qsa("[data-demote]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
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
          await adminFetch("/admin/set-role", { targetUserId: u.id, role: "user" });
          toast(`Acesso de administrador removido de ${u.name}.`, "success");
          renderAll();
        })
      )
    );
    qsa("[data-deluser]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const ok = await confirmAction(
            "Excluir este usuário permanentemente? Isto remove o perfil do banco de dados — a conta de login (Firebase Authentication) deve ser removida separadamente pelo console do Firebase.",
            { title: "Excluir usuário" }
          );
          if (!ok) return;
          const id = btn.getAttribute("data-deluser");
          await adminFetch("/admin/delete-user", { targetUserId: id });
          toast("Usuário excluído do banco de dados.", "success");
          renderAll();
        })
      )
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

    const list = db.projects
      .filter((p) => !filter || p.title.toLowerCase().includes(filter))
      .sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (b.status === "pending" && a.status !== "pending") return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    qs("#projectsTable tbody").innerHTML =
      list
        .map((p) => {
          const owner = userById(p.ownerId);
          let statusBadge = "";
          if (p.status === "published") statusBadge = '<span class="badge badge-success mt-1">Aprovado</span>';
          else if (p.status === "rejected") statusBadge = '<span class="badge badge-danger mt-1">Rejeitado</span>';
          else statusBadge = '<span class="badge badge-warning mt-1">Pendente</span>';

          let actionBtns = "";
          if (p.status === "pending") {
            actionBtns = `
              <button class="btn btn-sm btn-primary" style="width: 100%" data-approve-proj="${p.id}">Aprovar</button>
              <button class="btn btn-sm btn-danger" style="width: 100%" data-reject-proj="${p.id}">Reprovar</button>
            `;
          } else {
            actionBtns = `<button class="btn btn-sm btn-danger" style="width: 100%" data-delproj="${p.id}">Excluir</button>`;
          }

          return `<tr>
          <td><a href="index.html#/projeto/${p.id}" target="_blank" class="link">${escapeHtml(p.title)}</a></td>
          <td>${escapeHtml(owner ? owner.name : "—")}</td>
          <td>${escapeHtml(catName(p.categoryId))}</td>
          <td>${fmtDate(p.createdAt)}<br>${statusBadge}</td>
          <td class="flex gap-1" style="flex-direction: column;">${actionBtns}</td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="5" class="muted text-center">Nenhum projeto encontrado.</td></tr>`;

    qsa("[data-approve-proj]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const ok = await confirmAction("Aprovar este projeto? Ele ficará visível na vitrine para todos.", { title: "Aprovar projeto", confirmLabel: "Sim, aprovar", neutral: true });
          if (!ok) return;
          await adminFetch("/admin/moderate-project", { projectId: btn.getAttribute("data-approve-proj"), status: "published" });
          toast("Projeto aprovado e na vitrine!", "success");
          renderAll();
        })
      )
    );

    qsa("[data-reject-proj]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const projectId = btn.getAttribute("data-reject-proj");
        openRejectModal(projectId);
      })
    );

    qsa("[data-delproj]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const ok = await confirmAction("Excluir este projeto permanentemente?", { title: "Excluir projeto" });
          if (!ok) return;
          await adminFetch("/admin/delete-project", { projectId: btn.getAttribute("data-delproj") });
          toast("Projeto excluído.", "success");
          renderAll();
        })
      )
    );
  }

  function bindRejectModal() {
    const modal = qs("#rejectModal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    const cancelBtn = qs("#rejectCancelBtn", modal);
    const form = qs("#rejectForm", modal);

    cancelBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const projectId = qs("#rejectProjectId", modal).value;
      const reason = form.querySelector('input[name="rejectReason"]:checked').value;
      const submitBtn = form.querySelector('button[type="submit"]');

      withButtonLock(submitBtn, async () => {
        await adminFetch("/admin/moderate-project", {
          projectId: projectId,
          status: "rejected",
          rejectReason: reason,
        });

        toast("Projeto reprovado e usuário notificado.", "success");
        modal.style.display = "none";
        renderAll();
      });
    });
  }

  function openRejectModal(projectId) {
    const modal = qs("#rejectModal");
    if (!modal) return;
    qs("#rejectProjectId", modal).value = projectId;
    modal.style.display = "flex";
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
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const id = btn.getAttribute("data-delcat");
          const inUse = db.projects.some((p) => p.categoryId === id);
          if (inUse) {
            const ok = await confirmAction("Existem projetos usando essa categoria. Remover mesmo assim?", { title: "Remover categoria" });
            if (!ok) return;
          }
          await adminFetch("/admin/delete-category", { categoryId: id });
          toast("Categoria removida.", "success");
          renderAll();
        })
      )
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
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const ok = await confirmAction("Excluir esta publicação e todos os comentários?", { title: "Excluir publicação" });
          if (!ok) return;
          await adminFetch("/admin/delete-post", { postId: btn.getAttribute("data-delpost") });
          toast("Publicação removida.", "success");
          renderAll();
        })
      )
    );
  }

  /* ---------------------------------------------------------
     INDICAÇÕES
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
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          await adminFetch("/admin/withdrawal-decision", { withdrawalId: btn.getAttribute("data-approve"), decision: "approved" });
          toast("Saque aprovado.", "success");
          renderAll();
        })
      )
    );
    qsa("[data-reject]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          await adminFetch("/admin/withdrawal-decision", { withdrawalId: btn.getAttribute("data-reject"), decision: "rejected" });
          toast("Saque recusado.", "success");
          renderAll();
        })
      )
    );
  }

  /* ---------------------------------------------------------
     RANKING E PREMIAÇÃO
  --------------------------------------------------------- */
  function renderRankingPrizes() {
    const table = qs("#rankingPrizesTable");
    if (!table) return; // HTML ainda não tem a seção — não quebra o resto do painel
    
    const prizes = (db.rankingPrizes || [])
      .slice()
      .sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category));
      
    qs("tbody", table).innerHTML =
      prizes
        .map((p) => {
          const winner = p.winnerId ? userById(p.winnerId) : null;
          const catLabel = p.category === "indicacoes" ? "Mais indicações" : "Mais assinantes";
          return `<tr>
          <td>${escapeHtml(p.month)}</td>
          <td>${catLabel}</td>
          <td>${winner ? escapeHtml(winner.name) : "—"}${p.wasTiebreakDraw ? ' <span class="badge badge-neutral">sorteio</span>' : ""}</td>
          <td>${p.score}</td>
          <td>${p.delivered ? '<span class="badge badge-success">Entregue</span>' : '<span class="badge badge-warning">Pendente</span>'}</td>
          <td>${
            p.winnerId
              ? `<button class="btn btn-sm ${p.delivered ? "btn-ghost" : "btn-primary"}" data-toggle-delivered="${p.id}" data-current="${p.delivered ? "1" : "0"}">${p.delivered ? "Marcar não entregue" : "Marcar entregue"}</button>`
              : `<span class="muted">Sem vencedor</span>`
          }</td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="6" class="muted text-center">Nenhum mês fechado ainda.</td></tr>`;
        
    qsa("[data-toggle-delivered]", table).forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const prizeId = btn.getAttribute("data-toggle-delivered");
          const next = btn.getAttribute("data-current") !== "1";
          await adminFetch("/admin/mark-prize-delivered", { prizeId, delivered: next });
          toast(next ? "Prêmio marcado como entregue." : "Prêmio marcado como pendente.", "success");
          renderAll();
        })
      )
    );
    
    const closeBtn = qs("#forceCloseRankingBtn");
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = "1";
      closeBtn.addEventListener("click", () =>
        withButtonLock(closeBtn, async () => {
          const monthInput = qs("#forceCloseMonthInput");
          const monthKey = monthInput ? monthInput.value.trim() : "";
          const ok = await confirmAction(
            monthKey
              ? `Fechar/refazer o ranking de ${monthKey} agora? Isso sorteia o vencedor de novo e sobrescreve o prêmio existente desse mês, se houver.`
              : "Fechar o ranking do mês anterior agora, fora do agendamento automático?",
            { title: "Fechamento manual do ranking", confirmLabel: "Sim, fechar agora" }
          );
          if (!ok) return;
          await adminFetch("/admin/force-close-ranking", monthKey ? { monthKey } : {});
          toast("Ranking fechado.", "success");
          renderAll();
        })
      );
    }
  }

  /* ---------------------------------------------------------
     FORMULÁRIOS
  --------------------------------------------------------- */
  function bindForms() {
    bindRejectModal();

    const userSearch = qs("#userSearch");
    if (userSearch && !userSearch.dataset.bound) {
      userSearch.dataset.bound = "1";
      userSearch.addEventListener("input", (e) => {
        currentUserFilter = e.target.value;
        renderUsers(currentUserFilter);
      });
    }
    const projectSearch = qs("#projectSearch");
    if (projectSearch && !projectSearch.dataset.bound) {
      projectSearch.dataset.bound = "1";
      projectSearch.addEventListener("input", (e) => {
        currentProjectFilter = e.target.value;
        renderProjects(currentProjectFilter);
      });
    }
    const catForm = qs("#catForm");
    if (catForm && !catForm.dataset.bound) {
      catForm.dataset.bound = "1";
      catForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const submitBtn = catForm.querySelector('button[type="submit"]') || catForm;
        withButtonLock(submitBtn, async () => {
          const input = qs("#newCatName");
          const name = input.value.trim();
          if (!name) return;
          if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
            toast("Essa categoria já existe.", "error");
            return;
          }
          await adminFetch("/admin/create-category", { name });
          input.value = "";
          toast("Categoria adicionada.", "success");
          renderAll();
        });
      });
    }
  }

  /* ---------------------------------------------------------
     CHAT ADMIN (Lógica de Atendimento com Nome/Email)
  --------------------------------------------------------- */
  function bindChat() {
    if (chatBound) return;
    
    const listEl = qs("#adminChatList");
    const bodyEl = qs("#adminChatBody");
    const formEl = qs("#adminChatForm");
    const inputEl = qs("#adminChatInput");
    const submitBtn = qs("#adminChatSubmitBtn");
    const activeUserEl = qs("#adminChatActiveUser");

    if (!listEl || !formEl) return;
    chatBound = true; 

    // Escuta a lista de usuários que mandaram mensagem
    const allChatsRef = ref(rtdb, 'chats');
    onValue(allChatsRef, (snapshot) => {
        listEl.innerHTML = ''; 
        
        if (!snapshot.exists()) {
            listEl.innerHTML = '<p style="padding: 16px; font-size: 13px; color: #888; text-align: center;">Nenhuma conversa encontrada.</p>';
            return;
        }

        snapshot.forEach((childSnapshot) => {
            const userId = childSnapshot.key;
            
            // Tenta achar o usuário na lista global (db.users)
            const registeredUser = userById(userId);
            let displayName = userId.length > 15 ? userId.substring(0, 10) + '...' : userId;
            let displayEmail = 'Visitante não logado';

            if (registeredUser) {
                displayName = registeredUser.name;
                displayEmail = registeredUser.email;
            } else {
                displayName = `Visitante (${displayName})`;
            }
            
            const userBtn = document.createElement('button');
            userBtn.style.cssText = "width: 100%; text-align: left; padding: 16px; border: none; border-bottom: 1px solid var(--border-soft); background: transparent; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: background 0.2s;";
            
            // Renderiza Nome e E-mail na lista lateral
            userBtn.innerHTML = `
                <span style="font-size: 14px; font-weight: 600; color: var(--navy-900);">👤 ${escapeHtml(displayName)}</span>
                <span style="font-size: 12px; color: #666; font-weight: 400;">${escapeHtml(displayEmail)}</span>
            `;
            
            userBtn.onmouseover = () => { if(currentActiveChatUser !== userId) userBtn.style.background = '#f0f0f5'; };
            userBtn.onmouseout = () => { if(currentActiveChatUser !== userId) userBtn.style.background = 'transparent'; };

            userBtn.onclick = () => {
                Array.from(listEl.children).forEach(btn => btn.style.background = 'transparent');
                userBtn.style.background = '#e2e8f0';
                openChatWithUser(userId, displayName, displayEmail);
            };

            if(currentActiveChatUser === userId) {
                userBtn.style.background = '#e2e8f0';
            }

            listEl.appendChild(userBtn);
        });
    });

    // Abre o histórico recebendo o Nome e Email do usuário
    function openChatWithUser(userId, displayName, displayEmail) {
        currentActiveChatUser = userId;
        
        // Renderiza o Nome e Email no topo da janela do chat
        activeUserEl.innerHTML = `Atendendo: <strong>${escapeHtml(displayName)}</strong> <span style="font-size: 13px; color: #666; font-weight: normal; margin-left: 8px;">${escapeHtml(displayEmail)}</span>`;
        
        inputEl.disabled = false;
        submitBtn.disabled = false;
        inputEl.focus();

        const userMessagesRef = ref(rtdb, `chats/${userId}/messages`);
        
        onValue(userMessagesRef, (snapshot) => {
            if(currentActiveChatUser !== userId) return; 

            bodyEl.innerHTML = ''; 
            
            if (!snapshot.exists()) {
                bodyEl.innerHTML = '<p style="text-align: center; color: #888; margin-top: auto; margin-bottom: auto; font-size: 14px;">Nenhuma mensagem recebida ainda.</p>';
                return;
            }

            snapshot.forEach((childSnapshot) => {
                const msg = childSnapshot.val();
                
                const msgDiv = document.createElement('div');
                msgDiv.style.cssText = "max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-wrap: break-word;";
                
                if (msg.sender === 'admin') {
                    msgDiv.style.alignSelf = "flex-end";
                    msgDiv.style.background = "var(--blue-600)";
                    msgDiv.style.color = "white";
                    msgDiv.style.borderBottomRightRadius = "4px";
                } else {
                    msgDiv.style.alignSelf = "flex-start";
                    msgDiv.style.background = "#e5e5ea";
                    msgDiv.style.color = "#333";
                    msgDiv.style.borderBottomLeftRadius = "4px";
                }

                msgDiv.innerText = msg.text;
                bodyEl.appendChild(msgDiv);
            });

            bodyEl.scrollTop = bodyEl.scrollHeight;
        });
    }

    formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!currentActiveChatUser) return;
        
        const textValue = inputEl.value.trim();
        if (!textValue) return;

        inputEl.value = ''; 

        const userMessagesRef = ref(rtdb, `chats/${currentActiveChatUser}/messages`);
        
        try {
            await push(userMessagesRef, {
                text: textValue,
                sender: 'admin',
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("Erro ao enviar resposta:", error);
            toast("Falha ao enviar mensagem ao visitante.", "error");
        }
    });
  }

  /* ---------------------------------------------------------
     TEMPO REAL — Firebase Auth + Realtime Database
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => {
    firebaseUser = user;
    authReady = true;
    boot();
  });

  let lastRelevantSnapshot = null;
  function relevantSnapshot(database) {
    const { notifications, ...rest } = database;
    return JSON.stringify(rest);
  }

  onDBChange((newDb) => {
    db = newDb;
    const wasReady = dbReady;
    dbReady = isDBSynced();

    if (dbReady) {
      const snap = relevantSnapshot(db);
      if (wasReady && snap === lastRelevantSnapshot) {
        return;
      }
      lastRelevantSnapshot = snap;
    }

    boot();
  });

  document.addEventListener("DOMContentLoaded", boot);
})();
