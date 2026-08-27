/* =========================================================
   COMPARTILHAR PROJETOS — AUTH.JS
   Lógica de login e cadastro, usada apenas em login.html e
   register.html. Agora usa Firebase Authentication para
   autenticar e Firebase Realtime Database para guardar o
   perfil (nome, plano, indicações, etc.).

   A criação do perfil no cadastro NÃO é mais feita direto pelo
   navegador (as regras do banco não permitem isso). O navegador
   pede pro Worker (que tem acesso total via Service Account)
   criar o perfil completo.
   ========================================================= */

import { auth, rtdb } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { getDB, onDBChange } from "./db-sync.js";

(function () {
  "use strict";

  // endereço do Worker que cria o perfil completo do usuário no cadastro
  const WORKER_URL = "https://api.compartilhar-projetos.com.br";

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
      "auth/weak-password": "A senha deve ter ao menos 8 caracteres.",
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
    if (!password || password.length < 8) throw { message: "A senha deve ter ao menos 8 caracteres." };

    // 1. cria a conta de autenticação de verdade no Firebase
    const cred = await createUserWithEmailAndPassword(auth, email, password);

    // 2. pede pro Worker (que tem acesso total ao banco) criar o perfil completo
    let resp;
    try {
      const idToken = await cred.user.getIdToken();
      resp = await fetch(WORKER_URL + "/create-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + idToken,
        },
        body: JSON.stringify({
          name: name.trim(),
          email,
          refCode: refCode ? refCode.trim() : null,
        }),
      });
    } catch (networkErr) {
      // falha de rede ao chamar o Worker — desfaz a conta criada
      console.error("Erro de rede ao chamar o Worker (/create-profile):", networkErr);
      await cred.user.delete().catch(() => {});
      throw { message: "Falha de conexão ao criar seu perfil. Tente novamente." };
    }

    if (!resp.ok) {
      // o Worker recusou ou deu erro — desfaz a conta de autenticação
      // pra não deixar um usuário "fantasma" sem perfil no banco
      const errBody = await resp.json().catch(() => ({}));
      console.error("Worker recusou criar o perfil:", resp.status, resp.statusText, errBody);
      await cred.user.delete().catch(() => {});
      throw { message: errBody.message || "Não foi possível criar seu perfil. Tente novamente." };
    }

    const data = await resp.json();
    return data.user;
  }

  async function loginUser(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    
    // Busca o perfil diretamente na gaveta blindada (myProfile)
    const profileSnap = await get(ref(rtdb, `myProfile/${cred.user.uid}`));
    const profile = profileSnap.val();
    
    if (profile && profile.suspended) {
      await auth.signOut(); // Desloga o usuário suspenso imediatamente
      throw { message: "Sua conta foi suspensa. Entre em contato com o suporte." };
    }
    
    return profile;
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
          console.error("Erro ao fazer login:", err);
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
          console.error("Erro ao criar conta:", err);
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
