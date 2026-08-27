/* =========================================================
   COMPARTILHAR PROJETOS — ADMIN.JS (v7 + RANKING QUINZENAL)
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

  const PLAN_NAMES = { pTeste: "Plano Teste", p4: "Plano 4 Dias", p7: "Plano 7 Dias", pMensal: "Plano Mensal" };
  const PLAN_PRICES = { pTeste: 5, p4: 10, p7: 20, pMensal: 50 };
  const MIN_WITHDRAW = 10;

  let db = null;
  let firebaseUser = null;
  let authReady = false;
  let dbReady = false;
  let currentUserFilter = "";
  let currentProjectFilter = "";

  // CORREÇÃO: "Plano B" para conseguir entrar no painel antes do backfill rodar
  function currentUser() {
    if (!firebaseUser || !db) return null;
    if (db.myProfile && db.myProfile.id === firebaseUser.uid) return db.myProfile;
    return db.users.find((u) => u && u.id === firebaseUser.uid) || null;
  }

  /* ---------- utils ---------- */
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtBRL(v) {
    return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function userById(id) { return db.users.find((u) => u && u.id === id); }
  function isSubActive(u) { return !!(u.subscription && u.subscription.active && new Date(u.subscription.expiresAt) > new Date()); }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const icon = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(msg)}</span>`;
    stack.appendChild(el);
    setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 220); }, 3400);
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
      function onKey(e) { if (e.key === "Escape") settle(false); if (e.key === "Enter") settle(true); }
      
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      overlay.addEventListener("mousedown", onOverlayClick);
      document.addEventListener("keydown", onKey);
    });
  }

  async function adminFetch(path, body) {
    if (!firebaseUser) throw new Error("Sessão expirada. Faça login novamente.");
    const idToken = await firebaseUser.getIdToken();
    const res = await fetch(WORKER_BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch { }
    if (!res.ok) throw new Error((data && data.message) || `Falha na requisição (${res.status})`);
    return data;
  }

  async function withButtonLock(btn, fn) {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const prevDisabled = btn.disabled;
    btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message || "Falha ao processar solicitação.", "error"); } finally { btn.dataset.busy = ""; btn.disabled = prevDisabled; }
  }

  function showLoading(show) {
    let el = document.getElementById("adminLoadingScreen");
    if (!el) {
      el = document.createElement("div");
      el.id = "adminLoadingScreen";
      el.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#fff;font:500 14px system-ui,sans-serif;z-index:9999;";
      el.textContent = "Carregando painel administrativo…";
      document.body.appendChild(el);
    }
    el.style.display = show ? "flex" : "none";
  }

  function boot() {
    if (!authReady || !dbReady) { showLoading(true); return; }
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
      logoutBtn.addEventListener("click", async (e) => { e.preventDefault(); await signOut(auth); location.href = "index.html"; });
    }
  }

  function renderAll() {
    renderOverview();
    renderUsers(currentUserFilter);
    renderSubscriptions();
    renderProjects(currentProjectFilter);
    renderCategories();
    renderCommunity();
    renderReferrals();
    renderWithdrawals();
    renderRankingPrizes(); 
  }

  function renderOverview() {
    const activeSubs = db.users.filter(isSubActive).length;
    const pendingWithdrawals = db.withdrawals.filter((w) => w.status === "pending").reduce((s, w) => s + w.amount, 0);
    const publishedCount = db.projects.filter((p) => p.status === "published").length;
    const pendingModerationCount = db.projects.filter((p) => p.status === "pending").length;
    qs("#statGrid").innerHTML = [
      stat("Usuários cadastrados", db.users.length),
      stat("Assinaturas ativas", activeSubs),
      stat("Projetos publicados", publishedCount),
      stat("Projetos aguardando moderação", pendingModerationCount, pendingModerationCount > 0),
      stat("Publicações na comunidade", db.posts.length),
      stat("Receita estimada", fmtBRL(estimateRevenue()), true),
      stat("Saques aguardando aprovação", fmtBRL(pendingWithdrawals), true),
    ].join("");

    const recent = db.projects.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
    qs("#recentProjectsTable tbody").innerHTML = recent
      .map((p) => {
        const owner = userById(p.ownerId);
        return `<tr><td>${escapeHtml(p.title)}</td><td>${escapeHtml(owner ? owner.name : "—")}</td><td>${escapeHtml(catName(p.categoryId))}</td><td>${fmtDate(p.createdAt)}</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="muted text-center">Nenhum projeto ainda.</td></tr>`;
  }

  function estimateRevenue() {
    return db.users.reduce((sum, u) => {
      if (u && u.subscription && u.subscription.plan) { return sum + (PLAN_PRICES[u.subscription.plan] || 0); }
      return sum;
    }, 0);
  }

  function stat(label, value, gold) { return `<div class="stat-card${gold ? " gold" : ""}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`; }
  function catName(id) { const c = db.categories.find((c) => c.id === id); return c ? c.name : "Geral"; }

  /* ---------------------------------------------------------
     USUÁRIOS
  --------------------------------------------------------- */
  function renderUsers(filter) {
    filter = (filter || "").toLowerCase();
    const list = db.users.filter((u) => u && (!filter || u.name.toLowerCase().includes(filter) || u.email.toLowerCase().includes(filter)));
    qs("#usersTable tbody").innerHTML = list
      .map((u) => {
        const active = isSubActive(u);
        return `<tr>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role === "admin" ? `<span class="badge badge-blue">Admin</span>` : `<span class="badge badge-neutral">Usuário</span>`}</td>
        <td>${active ? `<span class="badge badge-success">Ativa</span>` : `<span class="badge badge-neutral">Sem assinatura</span>`}</td>
        <td>${u.suspended ? `<span class="badge badge-danger">Suspenso</span>` : `<span class="badge badge-success">Ok</span>`}</td>
        <td class="flex gap-1">
          ${u.role !== "admin"
              ? `<button class="btn btn-sm ${u.suspended ? "btn-ghost" : "btn-danger"}" data-suspend="${u.id}">${u.suspended ? "Reativar" : "Suspender"}</button>
                 <button class="btn btn-sm btn-ghost" data-promote="${u.id}">Tornar admin</button>
                 <button class="btn btn-sm btn-danger" data-deluser="${u.id}">Excluir</button>`
              : `<button class="btn btn-sm btn-ghost" data-demote="${u.id}">Remover admin</button>`
          }
        </td>
      </tr>`;
      }).join("") || `<tr><td colspan="6" class="muted text-center">Nenhum usuário encontrado.</td></tr>`;

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
          const ok = await confirmAction(`Tornar "${u.name}" um administrador?`, { title: "Promover a admin", neutral: true, confirmLabel: "Sim, promover" });
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
          if (u.id === currentUser().id) { toast("Você não pode remover seu próprio acesso de administrador.", "error"); return; }
          const ok = await confirmAction(`Remover o acesso de administrador de "${u.name}"?`, { title: "Remover admin", neutral: true, confirmLabel: "Sim, remover" });
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
          const ok = await confirmAction("Excluir este usuário permanentemente? Isto remove o perfil do banco de dados.", { title: "Excluir usuário" });
          if (!ok) return;
          await adminFetch("/admin/delete-user", { targetUserId: btn.getAttribute("data-deluser") });
          toast("Usuário excluído do banco de dados.", "success");
          renderAll();
        })
      )
    );
  }

  function renderSubscriptions() {
    const subbed = db.users.filter((u) => u && u.subscription && u.subscription.plan);
    const active = subbed.filter(isSubActive).length;
    qs("#subStatGrid").innerHTML = [ stat("Assinaturas ativas", active), stat("Assinaturas expiradas", subbed.length - active), stat("Receita estimada", fmtBRL(estimateRevenue()), true) ].join("");

    qs("#subsTable tbody").innerHTML = subbed
      .map((u) => {
        const active = isSubActive(u);
        return `<tr><td>${escapeHtml(u.name)}</td><td>${PLAN_NAMES[u.subscription.plan] || "—"}</td><td>${fmtDate(u.subscription.expiresAt)}</td><td>${
          active ? `<span class="badge badge-success">Ativa</span>` : `<span class="badge badge-danger">Expirada</span>`
        }</td></tr>`;
      }).join("") || `<tr><td colspan="4" class="muted text-center">Nenhuma assinatura registrada.</td></tr>`;
  }

  function renderProjects(filter) {
    filter = (filter || "").toLowerCase();
    const list = db.projects
      .filter((p) => p && (!filter || p.title.toLowerCase().includes(filter)))
      .sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (b.status === "pending" && a.status !== "pending") return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    qs("#projectsTable tbody").innerHTML = list
      .map((p) => {
        const owner = userById(p.ownerId);
        let statusBadge = p.status === "published" ? '<span class="badge badge-success mt-1">Aprovado</span>' : p.status === "rejected" ? '<span class="badge badge-danger mt-1">Rejeitado</span>' : '<span class="badge badge-warning mt-1">Pendente</span>';
        let actionBtns = p.status === "pending" ? `<button class="btn btn-sm btn-primary" style="width: 100%" data-approve-proj="${p.id}">Aprovar</button><button class="btn btn-sm btn-danger" style="width: 100%" data-reject-proj="${p.id}">Reprovar</button>` : `<button class="btn btn-sm btn-danger" style="width: 100%" data-delproj="${p.id}">Excluir</button>`;
        return `<tr>
        <td><a href="index.html#/projeto/${p.id}" target="_blank" class="link">${escapeHtml(p.title)}</a></td>
        <td>${escapeHtml(owner ? owner.name : "—")}</td>
        <td>${escapeHtml(catName(p.categoryId))}</td>
        <td>${fmtDate(p.createdAt)}<br>${statusBadge}</td>
        <td class="flex gap-1" style="flex-direction: column;">${actionBtns}</td>
      </tr>`;
      }).join("") || `<tr><td colspan="5" class="muted text-center">Nenhum projeto encontrado.</td></tr>`;

    qsa("[data-approve-proj]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        const ok = await confirmAction("Aprovar este projeto? Ele ficará visível na vitrine para todos.", { title: "Aprovar projeto", confirmLabel: "Sim, aprovar", neutral: true });
        if (!ok) return;
        await adminFetch("/admin/moderate-project", { projectId: btn.getAttribute("data-approve-proj"), status: "published" });
        toast("Projeto aprovado e na vitrine!", "success"); renderAll();
      })
    ));

    qsa("[data-reject-proj]").forEach((btn) => btn.addEventListener("click", () => { openRejectModal(btn.getAttribute("data-reject-proj")); }));
    qsa("[data-delproj]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        const ok = await confirmAction("Excluir este projeto permanentemente?", { title: "Excluir projeto" });
        if (!ok) return;
        await adminFetch("/admin/delete-project", { projectId: btn.getAttribute("data-delproj") });
        toast("Projeto excluído.", "success"); renderAll();
      })
    ));
  }

  function bindRejectModal() {
    const modal = qs("#rejectModal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    qs("#rejectCancelBtn", modal).addEventListener("click", () => { modal.style.display = "none"; });
    qs("#rejectForm", modal).addEventListener("submit", (e) => {
      e.preventDefault();
      const submitBtn = modal.querySelector('button[type="submit"]');
      withButtonLock(submitBtn, async () => {
        await adminFetch("/admin/moderate-project", {
          projectId: qs("#rejectProjectId", modal).value,
          status: "rejected",
          rejectReason: modal.querySelector('input[name="rejectReason"]:checked').value,
        });
        toast("Projeto reprovado e usuário notificado.", "success");
        modal.style.display = "none"; renderAll();
      });
    });
  }

  function openRejectModal(projectId) {
    const modal = qs("#rejectModal");
    if (!modal) return;
    qs("#rejectProjectId", modal).value = projectId;
    modal.style.display = "flex";
  }

  function renderCategories() {
    qs("#catsTable tbody").innerHTML = db.categories.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${db.projects.filter((p) => p.categoryId === c.id).length}</td><td><button class="btn btn-sm btn-danger" data-delcat="${c.id}">Remover</button></td></tr>`).join("");
    qsa("[data-delcat]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        const id = btn.getAttribute("data-delcat");
        if (db.projects.some((p) => p && p.categoryId === id)) {
          const ok = await confirmAction("Existem projetos usando essa categoria. Remover mesmo assim?", { title: "Remover categoria" });
          if (!ok) return;
        }
        await adminFetch("/admin/delete-category", { categoryId: id });
        toast("Categoria removida.", "success"); renderAll();
      })
    ));
  }

  function renderCommunity() {
    qs("#communityTable tbody").innerHTML = db.posts.map((p) => {
        const author = userById(p.authorId);
        return `<tr><td>${escapeHtml(author ? author.name : "—")}</td><td style="max-width:320px">${escapeHtml(p.content.slice(0, 140))}${p.content.length > 140 ? "…" : ""}</td><td>${p.comments ? p.comments.length : 0}</td><td>${fmtDate(p.createdAt)}</td><td><button class="btn btn-sm btn-danger" data-delpost="${p.id}">Excluir</button></td></tr>`;
      }).join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma publicação na comunidade.</td></tr>`;
    qsa("[data-delpost]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        const ok = await confirmAction("Excluir esta publicação e todos os comentários?", { title: "Excluir publicação" });
        if (!ok) return;
        await adminFetch("/admin/delete-post", { postId: btn.getAttribute("data-delpost") });
        toast("Publicação removida.", "success"); renderAll();
      })
    ));
  }

  function renderReferrals() {
    qs("#refStatGrid").innerHTML = [ stat("Total de indicações", db.referrals.length), stat("Comissões geradas", fmtBRL(db.commissions.reduce((s, c) => s + c.amount, 0)), true), stat("Comissões pagas", fmtBRL(db.withdrawals.filter((w) => w.status === "approved").reduce((s, w) => s + w.amount, 0))) ].join("");
    qs("#refsTable tbody").innerHTML = db.commissions.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((c) => {
        const label = { pending: ["badge-warning", "Pendente"], available: ["badge-success", "Disponível"], paid: ["badge-neutral", "Pago"] }[c.status];
        return `<tr><td>${escapeHtml(userById(c.referrerId)?.name || "—")}</td><td>${escapeHtml(userById(c.referredId)?.name || "—")}</td><td>${fmtBRL(c.amount)}</td><td><span class="badge ${label[0]}">${label[1]}</span></td><td>${fmtDate(c.createdAt)}</td></tr>`;
      }).join("") || `<tr><td colspan="5" class="muted text-center">Nenhuma comissão registrada.</td></tr>`;
  }

  function renderWithdrawals() {
    qs("#withdrawTable tbody").innerHTML = db.withdrawals.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((w) => {
        const label = { pending: ["badge-warning", "Em análise"], approved: ["badge-success", "Aprovado"], rejected: ["badge-danger", "Recusado"] }[w.status];
        return `<tr><td>${escapeHtml(userById(w.userId)?.name || "—")}</td><td>${fmtBRL(w.amount)}</td><td class="muted" style="font-family:var(--font-mono);font-size:12.5px">${escapeHtml(w.pixKey || "—")}</td><td>${fmtDate(w.createdAt)}</td><td><span class="badge ${label[0]}">${label[1]}</span></td><td class="flex gap-1">${w.status === "pending" ? `<button class="btn btn-sm btn-primary" data-approve="${w.id}">Aprovar</button><button class="btn btn-sm btn-danger" data-reject="${w.id}">Recusar</button>` : `<span class="muted" style="font-size:12px">Concluído</span>`}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="muted text-center">Nenhuma solicitação de saque (mínimo ${fmtBRL(MIN_WITHDRAW)}).</td></tr>`;

    qsa("[data-approve]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => { await adminFetch("/admin/withdrawal-decision", { withdrawalId: btn.getAttribute("data-approve"), decision: "approved" }); toast("Saque aprovado.", "success"); renderAll(); })));
    qsa("[data-reject]").forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => { await adminFetch("/admin/withdrawal-decision", { withdrawalId: btn.getAttribute("data-reject"), decision: "rejected" }); toast("Saque recusado.", "success"); renderAll(); })));
  }

  /* ---------------------------------------------------------
     RANKING E PREMIAÇÃO (+ INJEÇÃO DINÂMICA DO QUINZENAL)
  --------------------------------------------------------- */
  function renderRankingPrizes() {
    const table = qs("#rankingPrizesTable");
    if (!table) return; 
    
    const prizes = Object.values(db.rankingPrizes || {}).sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category));
      
    qs("tbody", table).innerHTML = prizes.map((p) => {
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
            ? `<button class="btn btn-sm ${p.delivered ? "btn-ghost" : "btn-primary"}" data-toggle-delivered="${p.id}" data-current="${p.delivered ? "1" : "0"}">${p.delivered ? "Desmarcar" : "Marcar entregue"}</button>`
            : `<span class="muted">Sem vencedor</span>`
        }</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="muted text-center">Nenhum mês fechado ainda.</td></tr>`;
        
    qsa("[data-toggle-delivered]", table).forEach((btn) => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        await adminFetch("/admin/mark-prize-delivered", { prizeId: btn.getAttribute("data-toggle-delivered"), delivered: btn.getAttribute("data-current") !== "1" });
        toast("Status atualizado.", "success"); renderAll();
    })));

    let bwPanel = qs("#biweeklyPanel");
    if (!bwPanel) {
      bwPanel = document.createElement("div");
      bwPanel.id = "biweeklyPanel";
      bwPanel.className = "panel";
      bwPanel.style.marginTop = "24px";
      bwPanel.innerHTML = `
        <div class="panel-head"><h3>Prêmios Quinzenais (Meta de Assinantes)</h3></div>
        <div class="table-wrap"><table class="data-table" id="biweeklyPrizesTable">
          <thead><tr><th>Ciclo</th><th>Meta</th><th>Vencedor</th><th>Prêmio</th><th>Status</th><th>Ação</th></tr></thead>
          <tbody></tbody>
        </table></div>`;
      table.closest(".panel").parentNode.appendChild(bwPanel);
    }

    const bwTable = qs("#biweeklyPrizesTable tbody");
    const bwPrizes = Object.values(db.biweeklyPrizes || {}).sort((a,b) => b.cycleStart.localeCompare(a.cycleStart));

    let bwRows = "";
    bwPrizes.forEach(cycle => {
       const cycleLabel = `${fmtDate(cycle.cycleStart)} a ${fmtDate(cycle.cycleEnd)}`;
       (cycle.winners || []).forEach(w => {
          const winnerUser = userById(w.winnerId);
          const isDelivered = cycle.delivered && cycle.delivered[w.threshold];
          bwRows += `<tr>
            <td>${cycleLabel}</td>
            <td>${w.threshold} assinantes (Plano 4 dias)</td>
            <td>${winnerUser ? escapeHtml(winnerUser.name) : "—"}</td>
            <td>${fmtBRL(w.prize)}</td>
            <td>${isDelivered ? '<span class="badge badge-success">Entregue</span>' : '<span class="badge badge-warning">Pendente</span>'}</td>
            <td>
              <button class="btn btn-sm ${isDelivered ? "btn-ghost" : "btn-primary"}" data-toggle-bw="${cycle.id}" data-threshold="${w.threshold}" data-current="${isDelivered ? "1" : "0"}">
                ${isDelivered ? "Desmarcar" : "Marcar entregue"}
              </button>
            </td>
          </tr>`;
       });
    });
    bwTable.innerHTML = bwRows || `<tr><td colspan="6" class="muted text-center">Nenhum evento quinzenal fechado ainda.</td></tr>`;

    qsa("[data-toggle-bw]").forEach(btn => btn.addEventListener("click", () => withButtonLock(btn, async () => {
        await adminFetch("/admin/mark-biweekly-delivered", { cycleId: btn.getAttribute("data-toggle-bw"), threshold: btn.getAttribute("data-threshold"), delivered: btn.getAttribute("data-current") !== "1" });
        toast("Prêmio quinzenal atualizado.", "success"); renderAll();
    })));

    const closeBtn = qs("#forceCloseRankingBtn");
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = "1";
      closeBtn.addEventListener("click", () =>
        withButtonLock(closeBtn, async () => {
          const monthKey = qs("#forceCloseMonthInput")?.value.trim() || "";
          const ok = await confirmAction(monthKey ? `Refazer ranking de ${monthKey} agora?` : "Fechar o ranking do mês anterior agora?", { title: "Fechamento manual", confirmLabel: "Sim, fechar agora" });
          if (!ok) return;
          await adminFetch("/admin/force-close-ranking", monthKey ? { monthKey } : {});
          toast("Ranking fechado.", "success"); renderAll();
        })
      );
    }
    
    // BOTÃO DE BACKFILL (MIGRAR PERFIS)
    const backfillBtn = qs("#backfillProfilesBtn");
    if (backfillBtn && !backfillBtn.dataset.bound) {
      backfillBtn.dataset.bound = "1";
      backfillBtn.addEventListener("click", () =>
        withButtonLock(backfillBtn, async () => {
          const ok = await confirmAction(
            "Isso copia todos os usuários existentes para os nós publicProfiles/myProfile. Seguro rodar mais de uma vez. Continuar?",
            { title: "Backfill de perfis", confirmLabel: "Sim, rodar agora", neutral: true }
          );
          if (!ok) return;
          const result = await adminFetch("/admin/backfill-profiles", {});
          toast(`Migrados ${result.migrated} de ${result.total} usuários.`, "success");
        })
      );
    }
  }

  function bindForms() {
    bindRejectModal();
    const userSearch = qs("#userSearch");
    if (userSearch && !userSearch.dataset.bound) { userSearch.dataset.bound = "1"; userSearch.addEventListener("input", (e) => { currentUserFilter = e.target.value; renderUsers(currentUserFilter); }); }
    const projectSearch = qs("#projectSearch");
    if (projectSearch && !projectSearch.dataset.bound) { projectSearch.dataset.bound = "1"; projectSearch.addEventListener("input", (e) => { currentProjectFilter = e.target.value; renderProjects(currentProjectFilter); }); }
    const catForm = qs("#catForm");
    if (catForm && !catForm.dataset.bound) {
      catForm.dataset.bound = "1";
      catForm.addEventListener("submit", (e) => {
        e.preventDefault();
        withButtonLock(catForm.querySelector('button[type="submit"]'), async () => {
          const input = qs("#newCatName"); const name = input.value.trim(); if (!name) return;
          await adminFetch("/admin/create-category", { name });
          input.value = ""; toast("Categoria adicionada.", "success"); renderAll();
        });
      });
    }
  }

  /* ---------------------------------------------------------
     TEMPO REAL
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => { firebaseUser = user; authReady = true; boot(); });
  let lastRelevantSnapshot = null;
  function relevantSnapshot(database) { const { notifications, ...rest } = database; return JSON.stringify(rest); }
  onDBChange((newDb) => {
    db = newDb; const wasReady = dbReady; dbReady = isDBSynced();
    if (dbReady) {
      const snap = relevantSnapshot(db);
      if (wasReady && snap === lastRelevantSnapshot) return;
      lastRelevantSnapshot = snap;
    }
    boot();
  });
  document.addEventListener("DOMContentLoaded", boot);
})();
