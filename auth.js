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

  function initialsFrom(name) {
    return (name || "?").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
  }

  // ---- Avatar de "bem-vindo de volta" na tela de login ----
  // Mostra o avatar/nome de quem já tem conta com o e-mail digitado. Pra
  // aparecer rápido (principalmente quando o navegador preenche e-mail e
  // senha sozinho e a pessoa aperta Entrar na hora):
  //  1) guarda as últimas contas vistas no localStorage e mostra daí,
  //     instantaneamente, sem esperar a rede;
  //  2) confirma/atualiza em segundo plano pelo Worker.
  const AVATAR_CACHE_KEY = "loginAvatarCache";
  const AVATAR_CACHE_MAX = 3; // poucas entradas: a foto pode ter dezenas de KB
  let avatarLookupSeq = 0;

  function readAvatarCache() {
    try { return JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function writeAvatarCache(email, data) {
    try {
      const cache = readAvatarCache();
      delete cache[email];
      cache[email] = { name: data.name || "", avatarUrl: data.avatarUrl || "", avatarColor: data.avatarColor || "", ts: Date.now() };
      const keys = Object.keys(cache).sort((a, b) => cache[b].ts - cache[a].ts).slice(0, AVATAR_CACHE_MAX);
      const trimmed = {}; keys.forEach((k) => { trimmed[k] = cache[k]; });
      localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(trimmed));
    } catch (e) { /* sem espaço/bloqueado: segue sem cache */ }
  }
  function removeFromAvatarCache(email) {
    try { const cache = readAvatarCache(); delete cache[email]; localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  function hideLoginAvatar() {
    const wrap = qs("#loginAvatarPreviewWrap");
    if (wrap) wrap.classList.remove("is-visible");
  }

  function showLoginAvatar(data) {
    const wrap = qs("#loginAvatarPreviewWrap");
    const avatarEl = qs("#loginAvatarPreview");
    const greetingEl = qs("#loginAvatarGreeting");
    if (!wrap || !avatarEl || !greetingEl) return;

    if (data.avatarUrl) {
      // Ordem importa: o "background" (atalho) tem que vir ANTES do
      // backgroundImage, senão ele apaga a imagem que acabamos de setar.
      avatarEl.style.background = "none";
      avatarEl.style.backgroundImage = `url('${data.avatarUrl}')`;
      avatarEl.style.backgroundSize = "cover";
      avatarEl.style.backgroundPosition = "center";
      avatarEl.textContent = "";
    } else {
      avatarEl.style.backgroundImage = "none";
      avatarEl.style.background = data.avatarColor || "#888";
      avatarEl.textContent = initialsFrom(data.name);
    }
    greetingEl.textContent = data.name ? `Olá, ${data.name.split(" ")[0]}!` : "";
    wrap.classList.add("is-visible");
  }

  async function lookupAvatarByEmail(email) {
    const seq = ++avatarLookupSeq;
    const key = email.toLowerCase();

    // 1) cache local: aparece na hora
    const cached = readAvatarCache()[key];
    if (cached) showLoginAvatar(cached);

    // 2) confirma no servidor (e atualiza se a foto/nome mudou)
    try {
      const res = await fetch(`${WORKER_URL}/lookup-avatar-by-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({ found: false }));
      // Se a pessoa já mudou o e-mail enquanto a resposta vinha, ignora.
      const input = qs("#loginEmail");
      if (seq !== avatarLookupSeq || (input && input.value.trim().toLowerCase() !== key)) return;

      if (!data.found) { removeFromAvatarCache(key); hideLoginAvatar(); return; }
      writeAvatarCache(key, data);
      showLoginAvatar(data);
    } catch (err) {
      // Sem rede: se já mostramos pelo cache, mantém; senão, nada a mostrar.
      if (!cached) hideLoginAvatar();
    }
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

    const loginEmailInput = qs("#loginEmail");
    if (loginEmailInput) {
      let avatarLookupTimer;
      let lastLookedUp = "";
      const checkEmail = (immediate) => {
        clearTimeout(avatarLookupTimer);
        const email = loginEmailInput.value.trim();
        if (!isValidEmail(email)) { lastLookedUp = ""; avatarLookupSeq++; hideLoginAvatar(); return; }
        if (email.toLowerCase() === lastLookedUp) return; // já tratado
        const run = () => { lastLookedUp = email.toLowerCase(); lookupAvatarByEmail(email); };
        // Digitando: espera um pouquinho pra não buscar a cada letra.
        // Colou/autopreencheu/saiu do campo: busca já.
        if (immediate) run(); else avatarLookupTimer = setTimeout(run, 200);
      };
      loginEmailInput.addEventListener("input", () => checkEmail(false));
      loginEmailInput.addEventListener("change", () => checkEmail(true));
      loginEmailInput.addEventListener("blur", () => checkEmail(true));

      // Preenchimento automático do navegador (e-mail/senha salvos): muitas
      // vezes não dispara "input" de forma confiável, então confere o campo
      // algumas vezes logo depois que a página abre.
      [0, 150, 400, 900, 1800].forEach((ms) => setTimeout(() => checkEmail(true), ms));
    }

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
