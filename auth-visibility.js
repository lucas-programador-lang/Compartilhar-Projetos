/* =========================================================
   COMPARTILHAR PROJETOS — AUTH-VISIBILITY.JS
   Usado pelas páginas estáticas (sobre.html, como-funciona.html,
   apk.html, termos.html, privacidade.html) para deixar o
   cabeçalho igual ao do index.html: mostra/esconde os blocos
   guest-only/auth-only, preenche a pílula de assinatura, o
   avatar, o sino de notificações (com contador) e liga o menu
   do usuário — sem depender do script.js do index.
   ========================================================= */

import { auth } from "/firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { onDBChange } from "/db-sync.js";

(function () {
  "use strict";

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function initials(name) { return (name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(""); }
  function isSubscriptionActive(user) { return !!(user && user.subscription && user.subscription.active && new Date(user.subscription.expiresAt) > new Date()); }

  let firebaseUser = null;
  let db = null;

  function currentUser() {
    if (!firebaseUser || !db || !db.myProfile) return null;
    return db.myProfile.id === firebaseUser.uid ? db.myProfile : null;
  }

  function myNotifications(userId) {
    if (!db || !db.notifications) return [];
    return db.notifications.filter((n) => n.userId === userId && !n.resolved);
  }
  function unreadNotificationsCount(userId) { return myNotifications(userId).filter((n) => !n.read).length; }

  /* =========================================================
     CABEÇALHO: pílula de assinatura, avatar e sino
     ========================================================= */
  function refreshHeader() {
    const user = currentUser();
    document.body.classList.toggle("is-guest", !user);
    document.body.classList.toggle("is-admin", !!user && user.role === "admin");

    const avatarInitial = qs("#avatarInitial");
    const subPill = qs("#subPill");
    if (user && avatarInitial && subPill) {
      avatarInitial.textContent = initials(user.name);
      avatarInitial.style.background = user.avatarColor || "";
      const active = isSubscriptionActive(user);
      subPill.textContent = active ? "Assinatura ativa" : "Sem assinatura";
      subPill.className = "sub-pill " + (active ? "active" : "free");
    }

    const notifBtn = qs("#notifBtn");
    const notifBadge = qs("#notifBadge");
    if (notifBtn) {
      if (!user) {
        notifBtn.style.display = "none";
      } else {
        notifBtn.style.display = "";
        if (notifBadge) {
          const count = unreadNotificationsCount(user.id);
          notifBadge.style.display = count > 0 ? "block" : "none";
        }
      }
    }
  }

  /* =========================================================
     INTERAÇÕES: sino, avatar/menu, sair, biometria
     ========================================================= */
  function bindHeaderInteractions() {
    const notifBtn = qs("#notifBtn");
    if (notifBtn && !notifBtn.dataset.bound) {
      notifBtn.dataset.bound = "1";
      notifBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Mesmo destino usado no index: leva ao painel, onde fica
        // a seção de notificações.
        location.href = "index.html#/painel";
      });
    }

    const avatarBtn = qs("#avatarBtn");
    const userMenu = qs("#userMenu");
    if (avatarBtn && userMenu && !avatarBtn.dataset.bound) {
      avatarBtn.dataset.bound = "1";
      avatarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        userMenu.classList.toggle("open");
      });
      document.addEventListener("click", () => userMenu.classList.remove("open"));
    }

    ["logoutBtn", "logoutBtnMobile"].forEach((id) => {
      const btn = qs("#" + id);
      if (btn && !btn.dataset.bound) {
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          try { await signOut(auth); } catch (e) {}
          location.href = "index.html";
        });
      }
    });
  }

  // Mesmo comportamento do "Meu painel" no index: tenta biometria
  // dentro do app (APK) ou, no navegador, vai direto para o painel.
  window.tentarAcessarPainel = function (event) {
    if (event) event.preventDefault();
    if (typeof Android !== "undefined" && Android.solicitarBiometria) {
      Android.solicitarBiometria();
    } else {
      location.href = "index.html#/painel";
    }
  };
  // Chamado pelo app (wrapper Android) quando a biometria é aprovada.
  window.biometriaAprovada = function () {
    location.href = "index.html#/painel";
  };

  document.addEventListener("DOMContentLoaded", bindHeaderInteractions);
  onAuthStateChanged(auth, (user) => { firebaseUser = user; refreshHeader(); bindHeaderInteractions(); });
  onDBChange((newDb) => { db = newDb; refreshHeader(); bindHeaderInteractions(); });

  /* =========================================================
     MENU MOBILE INFALÍVEL (DELEGAÇÃO DE EVENTOS)
     ========================================================= */
  window.addEventListener("click", (e) => {
      // Procura se o utilizador clicou no botão hambúrguer ou dentro dele
      const hamburger = e.target.closest("#hamburgerBtn");
      const mobileNav = document.getElementById("mobileNav");

      if (hamburger && mobileNav) {
          e.stopPropagation();
          const isOpened = mobileNav.classList.contains("open");

          if (isOpened) {
              mobileNav.classList.remove("open");
              document.body.style.overflow = "";
              document.body.classList.remove("menu-open");
          } else {
              mobileNav.classList.add("open");
              document.body.style.overflow = "hidden";
              document.body.classList.add("menu-open");
          }
      }

      // Fecha automaticamente se clicar num link dentro do menu
      if (mobileNav && e.target.closest("#mobileNav a, #mobileNav button")) {
          mobileNav.classList.remove("open");
          document.body.style.overflow = "";
          document.body.classList.remove("menu-open");
      }
  });
})();
