import { auth } from "/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  document.body.classList.toggle("is-guest", !user);
});

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
