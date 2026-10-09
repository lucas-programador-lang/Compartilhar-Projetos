/* =========================================================
   COMPARTILHAR PROJETOS — update-modal.js
   Aviso de atualização obrigatória do app Android e Funções Nativas.

   Só roda dentro do app (quando existe a ponte "Android"): compara a
   versão instalada com a última release do GitHub e, se forem
   diferentes, bloqueia a tela com um aviso pedindo a atualização.
   ========================================================= */
(function () {
  "use strict";

  var REPO = "lucas-programador-lang/Compartilhar-Projetos";
  var APK_URL = "https://github.com/" + REPO + "/releases/latest/download/compartilhar-projetos.apk";
  var SUPPORT_URL = "https://wa.me/5569993607367?text=" + encodeURIComponent("Olá, estou com problemas para atualizar o aplicativo Compartilhar Projetos.");

  var CSS = [
    ".cpu-backdrop{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;overflow-y:auto;",
    "padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));",
    "background:radial-gradient(120% 70% at 50% 0%,rgba(47,91,255,.30) 0%,rgba(8,23,54,0) 62%),rgba(5,10,24,.93);",
    "-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);animation:cpuFade .25s ease-out;font-family:var(--font-body,Inter),system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif}",

    ".cpu-card{position:relative;width:100%;max-width:400px;margin:auto;padding:34px 26px 20px;border-radius:26px;overflow:hidden;text-align:center;color:#fff;",
    "background:linear-gradient(180deg,#10214a 0%,#0b1636 100%);border:1px solid rgba(255,255,255,.09);",
    "box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06);animation:cpuRise .34s cubic-bezier(.2,.9,.3,1)}",
    ".cpu-card::before{content:\"\";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,#2f5bff,#ecc65b,#2f5bff)}",

    ".cpu-icon{position:relative;width:76px;height:76px;margin:2px auto 20px;border-radius:24px;display:grid;place-items:center;color:#fff;",
    "background:linear-gradient(145deg,#2f5bff,#0a2fb8);box-shadow:0 12px 30px rgba(47,91,255,.45),inset 0 1px 0 rgba(255,255,255,.25)}",
    ".cpu-icon::after{content:\"\";position:absolute;inset:-8px;border-radius:30px;border:2px solid rgba(98,135,255,.5);animation:cpuPulse 2.2s ease-out infinite}",

    ".cpu-tag{display:inline-block;margin-bottom:12px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;",
    "color:#ecc65b;background:rgba(220,174,44,.12);border:1px solid rgba(236,198,91,.28)}",
    ".cpu-title{margin:0 0 10px;font-family:var(--font-display,Sora),system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif;font-size:clamp(22px,6vw,26px);font-weight:800;letter-spacing:-.02em;line-height:1.15;color:#fff}",
    ".cpu-text{margin:0 auto 22px;max-width:34ch;font-size:15px;line-height:1.55;color:rgba(226,232,245,.74)}",

    ".cpu-versions{display:flex;align-items:stretch;justify-content:center;gap:10px;margin:0 0 22px}",
    ".cpu-ver{flex:1;min-width:0;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}",
    ".cpu-ver small{display:block;margin-bottom:2px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:rgba(226,232,245,.5)}",
    ".cpu-ver strong{display:block;font-size:16px;font-weight:700;color:rgba(255,255,255,.85);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cpu-ver.is-new{background:rgba(47,91,255,.15);border-color:rgba(98,135,255,.5)}",
    ".cpu-ver.is-new strong{color:#fff}",
    ".cpu-arrow{flex:none;align-self:center;color:#ecc65b}",

    ".cpu-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:54px;padding:14px 20px;border:0;border-radius:16px;cursor:pointer;",
    "font:inherit;font-size:16px;font-weight:700;color:#fff;background:linear-gradient(135deg,#2f5bff 0%,#0a2fb8 100%);",
    "box-shadow:0 10px 26px rgba(47,91,255,.42),inset 0 1px 0 rgba(255,255,255,.22);transition:transform .15s,filter .15s;-webkit-tap-highlight-color:transparent}",
    ".cpu-btn:hover{filter:brightness(1.08);transform:translateY(-1px)}",
    ".cpu-btn:active{transform:scale(.985)}",
    ".cpu-btn:focus-visible,.cpu-support:focus-visible{outline:3px solid #ecc65b;outline-offset:3px}",
    ".cpu-hint{margin:12px 0 0;font-size:12.5px;line-height:1.45;color:rgba(226,232,245,.55)}",

    ".cpu-divider{height:1px;margin:18px -26px 12px;background:rgba(255,255,255,.07)}",
    ".cpu-help{margin:0 0 8px;font-size:13px;color:rgba(226,232,245,.55)}",
    ".cpu-support{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap;color:#25D366;background:rgba(37,211,102,.08);border:1px solid rgba(37,211,102,.35);transition:background .15s}",
    ".cpu-support:hover{background:rgba(37,211,102,.16)}",

    "@keyframes cpuFade{from{opacity:0}to{opacity:1}}",
    "@keyframes cpuRise{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}",
    "@keyframes cpuPulse{0%{opacity:.9;transform:scale(.92)}100%{opacity:0;transform:scale(1.22)}}",
    "@media (prefers-reduced-motion:reduce){.cpu-backdrop,.cpu-card,.cpu-icon::after{animation:none}.cpu-btn{transition:none}}"
  ].join("");

  var ICON_UPDATE = '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  var ICON_ARROW = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
  var ICON_DOWNLOAD = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';
  var ICON_WHATSAPP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.38-.03-.53-.07-.15-.67-1.62-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.1 4.49.71.31 1.27.49 1.7.63.72.23 1.37.2 1.88.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35zM12.05 21.8h-.01a9.9 9.9 0 0 1-5.03-1.38l-.36-.21-3.75.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.9-9.89 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.9 7c0 5.45-4.44 9.88-9.89 9.88zM20.5 3.45A11.8 11.8 0 0 0 12.05 0C5.5 0 .16 5.33.16 11.89c0 2.1.55 4.14 1.59 5.94L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.69 1.45h.01c6.55 0 11.89-5.34 11.89-11.9 0-3.17-1.23-6.16-3.48-8.4z"/></svg>';

  function normalizeVersion(v) {
    return String(v || "").trim().replace(/^v/i, "");
  }

  // ==========================================================
  // FUNÇÃO PARA BAIXAR O APK DIRETO PELO APLICATIVO
  // ==========================================================
  var RETRY_AFTER_MS = 20000; // depois disso, libera o botão pra tentar de novo
  var retryTimer = null;

  function openUpdateLink() {
    if (typeof Android !== "undefined" && typeof Android.baixarApkDireto === "function") {
      Android.baixarApkDireto(APK_URL);

      var btn = document.getElementById("cpuUpdateBtn");
      var hint = document.getElementById("cpuHint");
      var originalBtn = btn.innerHTML;
      btn.innerHTML = '<span>Baixando atualização... Aguarde a instalação.</span>';
      btn.style.opacity = "0.7";
      btn.style.pointerEvents = "none";

      // Se o download não começar ou não terminar (sem permissão pra instalar,
      // sem internet...), o botão não pode ficar travado pra sempre: depois de
      // um tempo ele volta ao normal e a pessoa pode tentar de novo.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function () {
        btn.innerHTML = originalBtn;
        btn.style.opacity = "";
        btn.style.pointerEvents = "";
        if (hint) hint.textContent = "Não terminou? Toque em Atualizar Agora para tentar de novo ou fale com o suporte.";
      }, RETRY_AFTER_MS);
    } else {
      window.open(APK_URL, "_blank");
    }
  }

  function showUpdateModal(installed, latest) {
    if (document.getElementById("cpuBackdrop")) return;

    var style = document.createElement("style");
    style.id = "cpuStyle";
    style.textContent = CSS;
    document.head.appendChild(style);

    var backdrop = document.createElement("div");
    backdrop.id = "cpuBackdrop";
    backdrop.className = "cpu-backdrop";
    backdrop.innerHTML =
      '<div class="cpu-card" role="dialog" aria-modal="true" aria-labelledby="cpuTitle" aria-describedby="cpuText">' +
        '<div class="cpu-icon">' + ICON_UPDATE + '</div>' +
        '<span class="cpu-tag">Atualização obrigatória</span>' +
        '<h2 class="cpu-title" id="cpuTitle">Nova versão disponível</h2>' +
        '<p class="cpu-text" id="cpuText">Lançamos uma nova versão com melhorias importantes de segurança e desempenho. Para continuar usando o Compartilhar Projetos, instale a atualização mais recente.</p>' +
        '<div class="cpu-versions">' +
          '<div class="cpu-ver"><small>Instalada</small><strong id="cpuInstalled"></strong></div>' +
          '<span class="cpu-arrow">' + ICON_ARROW + '</span>' +
          '<div class="cpu-ver is-new"><small>Nova</small><strong id="cpuLatest"></strong></div>' +
        '</div>' +
        '<button type="button" class="cpu-btn" id="cpuUpdateBtn">' + ICON_DOWNLOAD + '<span>Atualizar Agora</span></button>' +
        '<p class="cpu-hint" id="cpuHint">Toque no botão para baixar e instalar a nova versão direto no aplicativo.</p>' +
        '<div class="cpu-divider"></div>' +
        '<p class="cpu-help">Precisa de ajuda?</p>' +
        '<a class="cpu-support" id="cpuSupport" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">' + ICON_WHATSAPP + '<span>Falar no WhatsApp</span></a>' +
      '</div>';
    document.body.appendChild(backdrop);

    // Versões entram como texto (nunca como HTML).
    document.getElementById("cpuInstalled").textContent = installed && installed !== "0.0.0" ? "v" + installed : "—";
    document.getElementById("cpuLatest").textContent = "v" + latest;

    var btn = document.getElementById("cpuUpdateBtn");
    var support = document.getElementById("cpuSupport");
    btn.addEventListener("click", openUpdateLink);

    // Atualização é obrigatória: trava a rolagem do site e mantém o foco
    // dentro do aviso (só tem dois elementos clicáveis).
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    backdrop.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var first = btn, last = support;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
  }

  function checkForUpdate() {
    if (typeof Android === "undefined") return; // só vale dentro do app

    var installed = "0.0.0";
    if (typeof Android.obterVersaoApp === "function") {
      installed = normalizeVersion(Android.obterVersaoApp());
    }

    fetch("https://api.github.com/repos/" + REPO + "/releases/latest")
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.tag_name) return;
        var latest = normalizeVersion(data.tag_name);
        if (installed !== latest) showUpdateModal(installed, latest);
      })
      .catch(function (error) { console.error("Erro ao verificar atualizações.", error); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkForUpdate);
  } else {
    checkForUpdate();
  }

  // ==========================================================
  // FUNÇÃO DE TEMA ESCURO (Ajustada para o seu 'data-theme')
  // ==========================================================
  window.mudarTemaApp = function(isEscuro) {
      if (isEscuro) {
          document.documentElement.setAttribute('data-theme', 'dark');
      } else {
          document.documentElement.setAttribute('data-theme', 'light');
      }
  };

  // ==========================================================
  // O TRUQUE GLOBAL DE VIBRAÇÃO (HAPTIC FEEDBACK)
  // ==========================================================
  document.addEventListener('click', function(event) {
      // Verifica se a pessoa clicou num botão ou num link
      var elementoClicado = event.target.closest('button, a');

      if (elementoClicado) {
          // Se for no Android, dá o Toque Sutil (vibração premium)
          if (typeof Android !== 'undefined' && typeof Android.toqueSutil === 'function') {
              Android.toqueSutil();
          }
      }
  }, true); // true = fase de captura: roda ANTES dos outros cliques. Sem isso, botões
            // que redesenham a tela ao clicar (como o "Atualizar Agora" e a SPA toda)
            // já saíram do DOM quando este código roda, e o closest() não acha mais o botão.

})();
