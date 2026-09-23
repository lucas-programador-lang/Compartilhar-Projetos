import { auth } from "/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  document.body.classList.toggle("is-guest", !user);
});

// AQUI ESTÁ A CORREÇÃO: Tiramos o "DOMContentLoaded".
// Como é um module, o HTML já está pronto e os botões já existem.
const hamburger = document.getElementById("hamburgerBtn");
const mobileNav = document.getElementById("mobileNav");

if (hamburger && mobileNav) {
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
    
    mobileNav.querySelectorAll("a, button").forEach((el) => {
        el.addEventListener("click", () => {
            mobileNav.classList.remove("open");
            document.body.style.overflow = "";
            document.body.classList.remove("menu-open");
        });
    });
}
