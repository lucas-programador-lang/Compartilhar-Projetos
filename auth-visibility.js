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

/* =========================================================
   MENU MOBILE (HAMBÚRGUER)
   Faz o menu abrir/fechar nas páginas estáticas no celular
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => {
    const hamburger = document.getElementById("hamburgerBtn");
    const mobileNav = document.getElementById("mobileNav");
    
    if (hamburger && mobileNav) {
        // Clicar no botão hambúrguer
        hamburger.addEventListener("click", (e) => {
            e.stopPropagation();
            if (mobileNav.classList.contains("open")) {
                mobileNav.classList.remove("open");
                document.body.style.overflow = "";
                document.body.classList.remove("menu-open");
            } else {
                mobileNav.classList.add("open");
                document.body.style.overflow = "hidden";
                document.body.classList.add("menu-open");
            }
        });
        
        // Fechar o menu ao clicar num link
        mobileNav.querySelectorAll("a, button").forEach((el) => {
            el.addEventListener("click", () => {
                mobileNav.classList.remove("open");
                document.body.style.overflow = "";
                document.body.classList.remove("menu-open");
            });
        });
    }
});
