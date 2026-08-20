/* =========================================================
   COMPARTILHAR PROJETOS — ADMIN.JS (v4)
   Painel administrativo. Leitura em tempo real via db-sync.js
   (Firebase Realtime Database). Toda ESCRITA administrativa
   passa pelo Worker (/admin/*), que valida a role no servidor
   com a Service Account — o cliente não tem mais permissão de
   escrita direta nesses campos (users/subscription, users/role,
   commissions, etc.), reforçado pelas Regras do Firebase.

   v2.1: PLAN_NAMES e estimateRevenue() agora conhecem também os
   planos "pTeste" (R$ 5, 2 dias) e "pMensal" (R$ 50, 30 dias) —
   antes só p4/p7 eram reconhecidos, então assinantes desses dois
   planos apareciam com plano "—" em Assinaturas e contribuíam
   R$ 0 pra "Receita estimada".

   v3: CORREÇÃO — dbReady virava true assim que onDBChange() era
   registrado, porque o db-sync.js antigo chamava cb(cache)
   imediatamente com o cache ainda vazio (emptyCache() não é null).
   Isso fazia boot() cair no ramo "acesso negado" (gateScreen) por
   uma fração de segundo antes do primeiro sync completo terminar
   e re-renderizar o painel de verdade — um flash visual incômodo,
   principalmente perceptível em conexões mais lentas. Agora
   dbReady só vira true quando isDBSynced() confirma que os 7 nós
   já responderam pelo menos uma vez, e enquanto isso não acontece
   (nem authReady) o boot() mostra uma tela de carregamento simples
   em vez do gate — evitando o usuário ver "acesso negado" quando
   na real os dados só ainda não chegaram.

   v4: DUAS CORREÇÕES —

   1) O card "Comissões pendentes de saque" na Visão geral somava
      db.withdrawals com status "pending" (solicitações de saque
      aguardando decisão do admin), mas o rótulo dava a entender
      que era sobre comissões ainda não maturadas (commissions com
      status "pending" — que segundo o worker.js nem chegam a
      existir mais, toda comissão já nasce "available"). São
      conceitos diferentes. Renomeado para "Saques aguardando
      aprovação", que é o que o número de fato representa.

   2) renderUsers(filter) e renderProjects(filter) perdiam o filtro
      digitado sempre que renderAll() rodava por conta de QUALQUER
      mudança em onDBChange — inclusive mudanças sem relação (ex.:
      alguém comentando na comunidade enquanto o admin busca um
      usuário específico). O texto continuava no campo de busca,
      mas a tabela voltava a mostrar a lista completa sem filtro,
      até o próximo keystroke. Agora o filtro atual é guardado em
      currentUserFilter/currentProjectFilter e renderAll() sempre
      repassa esse valor, então um sync em tempo real nunca reseta
      visualmente uma busca em andamento.
   ========================================================= */

import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDB, onDBChange, isDBSynced } from "./db-sync.js";

(function () {
  "use strict";

  const WORKER_BASE_URL = "https://api.compartilhar-projetos.com.br";

  // Nomes de exibição — mantidos em sincronia com o objeto PLANS do
  // worker.js e do script.js. Se adicionar/remover um plano lá, espelhe
  // a mudança aqui também.
  const PLAN_NAMES = {
    pTeste: "Plano Teste",
    p4: "Plano 4 Dias",
    p7: "Plano 7 Dias",
    pMensal: "Plano Mensal",
  };
  // Preços — usados só pra "Receita estimada" no painel admin. Mantidos
  // em sincronia com o objeto PLANS do worker.js e do script.js.
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

  // Guardam o texto atualmente digitado nas buscas, para que um
  // re-render automático disparado por onDBChange (ver nota v4 acima)
  // não "esqueça" o filtro em andamento.
  let currentUserFilter = "";
  let currentProjectFilter = "";

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
    try {
      data = await res.json();
    } catch {
      /* corpo vazio ou não-JSON */
    }
    if (!res.ok) {
      throw new Error((data && data.message) || `Falha na requisição (${res.status})`);
    }
    return data;
  }

  // Evita cliques duplos disparando a mesma escrita duas vezes enquanto
  // a primeira ainda está em voo.
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
     LOADING — mostrado enquanto auth e/ou o primeiro sync do
     banco ainda não terminaram, pra não mostrar "acesso negado"
     por engano antes dos dados reais chegarem (ver nota v3).
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
     GATE — só administradores acessam
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
     Reaplica sempre os filtros de busca atuais (currentUserFilter /
     currentProjectFilter) — ver nota v4 no cabeçalho do arquivo.
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
  }

  function renderOverview() {
    const activeSubs = db.users.filter(isSubActive).length;
    const totalRevenueEstimate = estimateRevenue();
    const pendingWithdrawals = db.withdrawals.filter((w) => w.status === "pending").reduce((s, w) => s + w.amount, 0);
    qs("#statGrid").innerHTML = [
      stat("Usuários cadastrados", db.users.length),
      stat("Assinaturas ativas", activeSubs),
      stat("Projetos publicados", db.projects.length),
      stat("Publicações na comunidade", db.posts.length),
      stat("Receita estimada", fmtBRL(totalRevenueEstimate), true),
      // Antes rotulado "Comissões pendentes de saque" — mas o valor é a
      // soma de SOLICITAÇÕES DE SAQUE com status "pending" (aguardando
      // aprovação do admin), não de comissões ainda não maturadas. Ver
      // nota v4 acima.
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

  // Soma o preço do plano de cada usuário com um plano definido — agora
  // usando PLAN_PRICES em vez de um if/else fixo em p4/p7, então
  // qualquer plano novo adicionado a PLAN_PRICES é contado automaticamente.
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
          // db será atualizado pelo listener em tempo real (onDBChange);
          // renderAll() aqui só evita a UI parada até isso acontecer.
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
     PROJETOS (Moderação e Gerenciamento)
  --------------------------------------------------------- */
  function renderProjects(filter) {
    filter = (filter || "").toLowerCase();
    
    // Ordenar: Pendentes primeiro, depois por data mais recente
    const list = db.projects
      .filter((p) => !filter || p.title.toLowerCase().includes(filter))
      .sort((a, b) => {
        if (a.status === 'pendente' && b.status !== 'pendente') return -1;
        if (b.status === 'pendente' && a.status !== 'pendente') return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    qs("#projectsTable tbody").innerHTML =
      list
        .map((p) => {
          const owner = userById(p.ownerId);

          // Definir o badge de status (agora agrupado com a Data para não quebrar a tabela HTML)
          let statusBadge = '';
          if (p.status === 'published') statusBadge = '<span class="badge badge-success mt-1">Aprovado</span>';
          else if (p.status === 'rejeitado') statusBadge = '<span class="badge badge-danger mt-1">Rejeitado</span>';
          else statusBadge = '<span class="badge badge-warning mt-1">Pendente</span>';

          // Definir os botões de ação baseados no status
          let actionBtns = '';
          if (p.status === 'pendente') {
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

    // AÇÕES DE APROVAR
    qsa("[data-approve-proj]").forEach((btn) =>
      btn.addEventListener("click", () =>
        withButtonLock(btn, async () => {
          const ok = await confirmAction("Aprovar este projeto? Ele ficará visível na vitrine para todos.", { title: "Aprovar projeto", confirmLabel: "Sim, aprovar", neutral: true });
          if (!ok) return;
          // Chama o endpoint de moderação (você precisa criar essa rota no seu Worker)
          await adminFetch("/admin/moderate-project", { projectId: btn.getAttribute("data-approve-proj"), status: "published" });
          toast("Projeto aprovado e na vitrine!", "success");
          renderAll();
        })
      )
    );

    // AÇÕES DE REPROVAR (Abre o modal)
    qsa("[data-reject-proj]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const projectId = btn.getAttribute("data-reject-proj");
        openRejectModal(projectId);
      })
    );

    // AÇÕES DE EXCLUIR
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

  /* ---------------------------------------------------------
     MODAL DE REPROVAÇÃO (Chatbot)
  --------------------------------------------------------- */
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
        // Envia para o Worker atualizar o status e disparar a mensagem
        await adminFetch("/admin/moderate-project", {
          projectId: projectId,
          status: "rejeitado",
          rejectReason: reason
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
     FORMULÁRIOS (busca, nova categoria)
     Os handlers de input atualizam currentUserFilter /
     currentProjectFilter (ver nota v4) para que um re-render
     automático vindo de onDBChange preserve o que está digitado.
  --------------------------------------------------------- */
  function bindForms() {
    bindRejectModal(); // <--- O modal do chatbot foi ativado aqui!
    
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
     TEMPO REAL — Firebase Auth + Realtime Database
  --------------------------------------------------------- */
  onAuthStateChanged(auth, (user) => {
    firebaseUser = user;
    authReady = true;
    boot();
  });

  onDBChange((newDb) => {
    db = newDb;
    // dbReady só vira true quando o db-sync.js confirma que os 7 nós
    // já responderam pelo menos uma vez nesta geração (ver nota v3).
    dbReady = isDBSynced();
    boot();
  });

  document.addEventListener("DOMContentLoaded", boot);
})();
