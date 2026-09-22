/* =========================================================
   COMPARTILHAR PROJETOS — AUTH-VISIBILITY.JS
   Script leve para páginas institucionais estáticas
   (sobre, como-funciona, termos, privacidade, apk).
   Esconde/mostra links .guest-only e .auth-only conforme
   o usuário estiver logado ou não, reaproveitando as
   mesmas classes/regras CSS do index.html.
   ========================================================= */
import { auth } from "/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  document.body.classList.toggle("is-guest", !user);
});
