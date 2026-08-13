/* =========================================================
   COMPARTILHAR PROJETOS — AUTH.JS
   Lógica de login e cadastro, usada apenas em login.html e
   register.html. Agora usa Firebase Authentication para
   autenticar e Firebase Realtime Database para guardar o
   perfil (nome, plano, indicações, etc.).
   ========================================================= */

import { auth } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDB, saveDB, onDBChange } from "./db-sync.js";
import { uid, nowISO } from "./seed.js";

(function () {
  "use strict";

  /* ---------- utilidades ---------- */
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  function qs(sel) {
    return document.querySelector(sel);
  }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const iconChar = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = iconChar;
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = msg;
    el.append(icon, text);
    stack.appendChild(el);
    const dismiss = () => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(dismiss, 3400);
  }
  function getParam(name) {
    return new URLSearchParams(location.search).get(name);
  }
  function redirectDestination() {
    const r = getParam("redirect");
    const safe = r && /^[a-z0-9\-\/]+$/i.test(r) ? r : "painel";
    return "index.html#/" + safe.replace(/^\/+/, "");
  }

  // traduz códigos de erro do Firebase para mensagens em português
  function traduzErro(err) {
    const map = {
      "auth/email-already-in-use": "Este e-mail já está cadastrado.",
      "auth/invalid-email": "Informe um e-mail válido.",
      "auth/weak-password": "A senha deve ter ao menos 6 caracteres.",
      "auth/invalid-credential": "E-mail ou senha incorretos.",
      "auth/wrong-password": "E-mail ou senha incorretos.",
      "auth/user-not-found": "E-mail ou senha incorretos.",
      "auth/too-many-requests": "Muitas tentativas. Aguarde um instante e tente novamente.",
      "auth/network-request-failed": "Falha de conexão. Verifique sua internet.",
    };
    return map[err.code] || err.message || "Ocorreu um erro. Tente novamente.";
  }

  /* ---------- ações ---------- */
  async function registerUser({ name, email, password, refCode }) {
    email = email.trim().toLowerCase();
    if (!name || name.trim().length < 2) throw { message: "Informe seu nome completo." };
    if (!isValidEmail(email)) throw { message: "Informe um e-mail válido." };
    if (!password || password.length < 6) throw { message: "A senha deve ter ao menos 6 caracteres." };

    // 1. cria a conta de autenticação de verdade no Firebase
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const authUid = cred.user.uid;

    // 2. cria o perfil do usuário dentro do "banco" (Realtime Database)
    const db = getDB() || { users: [], categories: [], projects: [], posts: [], referrals: [], commissions: [], withdrawals: [] };

    if (db.users.some((u) => u.email === email && u.id !== authUid)) {
      throw { message: "Este e-mail já está cadastrado." };
    }

    let referredBy = null;
    if (refCode) {
      const ref = db.users.find((u) => (u.refCode || "").toLowerCase() === refCode.trim().toLowerCase());
      if (ref) referredBy = ref.id;
    }

    const user = {
      id: authUid, // o id do perfil É o uid do Firebase Auth
      name: name.trim(),
      email,
      role: "user",
      isAdmin: false,
      avatarColor: ["#1d4fc4", "#b8860b", "#0f8a5f", "#8a6410", "#163e8c"][Math.floor(Math.random() * 5)],
      createdAt: nowISO(),
      refCode: (name.trim().split(" ")[0] + Math.random().toString(36).slice(2, 6)).toUpperCase(),
      referredBy,
      subscription: { active: false, plan: null, expiresAt: null },
      suspended: false,
      bio: "",
    };
    db.users.push(user);
    if (referredBy) {
      db.referrals.push({ id: uid("rf"), referrerId: referredBy, referredId: user.id, createdAt: nowISO() });
    }
    await saveDB(db);
    return user;
  }

  async function loginUser(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    const db = getDB();
    const user = db && db.users.find((u) => u.id === cred.user.uid);
    if (user && user.suspended) {
      throw { message: "Sua conta foi suspensa. Entre em contato com o suporte." };
    }
    return user;
  }

  /* ---------- inicialização por página ---------- */
  function boot() {
    // preserva o parâmetro ?redirect= ao alternar entre login e cadastro
    const redirectParam = getParam("redirect");
    ["goRegister", "goLogin"].forEach((id) => {
      const link = qs("#" + id);
      if (link && redirectParam) {
        const url = new URL(link.href, location.href);
        url.searchParams.set("redirect", redirectParam);
        link.href = url.toString();
      }
    });

    // garante que os dados do Realtime Database já estejam carregados
    // antes de permitir o envio dos formulários
    onDBChange(() => {});

    const loginForm = qs("#loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const fd = new FormData(loginForm);
        const box = qs("#loginError");
        box.style.display = "none";
        if (submitBtn) submitBtn.disabled = true;
        try {
          await loginUser(fd.get("email"), fd.get("password"));
          toast("Bem-vindo(a) de volta!", "success");
          location.href = redirectDestination();
        } catch (err) {
          box.textContent = traduzErro(err);
          box.style.display = "block";
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    const registerForm = qs("#registerForm");
    if (registerForm) {
      const refField = qs("#refCodeInput");
      const refParam = getParam("ref");
      if (refField && refParam) refField.value = refParam;

      registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = registerForm.querySelector('button[type="submit"]');
        const fd = new FormData(registerForm);
        const box = qs("#registerError");
        box.style.display = "none";
        if (submitBtn) submitBtn.disabled = true;
        try {
          await registerUser({
            name: fd.get("name"),
            email: fd.get("email"),
            password: fd.get("password"),
            refCode: fd.get("refCode"),
          });
          toast("Conta criada com sucesso!", "success");
          location.href = redirectDestination();
        } catch (err) {
          box.textContent = traduzErro(err);
          box.style.display = "block";
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
