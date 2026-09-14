/* ===== Banner de Consentimento de Cookies (LGPD) ===== */
(function () {
  var STORAGE_KEY = 'cp_cookie_consent'; // 'accepted' | 'rejected'

  function getConsent() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {}
  }

  function createBanner() {
    var banner = document.createElement('div');
    banner.id = 'cookieConsentBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Aviso de cookies');
    banner.innerHTML =
      '<div class="cookie-consent-inner">' +
        '<p class="cookie-consent-text">' +
          'Usamos cookies e tecnologias semelhantes para manter você logado, lembrar preferências e melhorar sua experiência no Compartilhar Projetos. ' +
          'Ao continuar navegando, você concorda com nossa ' +
          '<a href="/privacidade.html">Política de Privacidade</a>.' +
        '</p>' +
        '<div class="cookie-consent-actions">' +
          '<button type="button" id="cookieConsentReject" class="cookie-consent-btn cookie-consent-btn-ghost">Recusar não essenciais</button>' +
          '<button type="button" id="cookieConsentAccept" class="cookie-consent-btn cookie-consent-btn-primary">Aceitar</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    document.getElementById('cookieConsentAccept').addEventListener('click', function () {
      setConsent('accepted');
      banner.classList.add('cookie-consent-hidden');
      setTimeout(function () { banner.remove(); }, 300);
      document.dispatchEvent(new CustomEvent('cookieConsentChanged', { detail: 'accepted' }));
    });

    document.getElementById('cookieConsentReject').addEventListener('click', function () {
      setConsent('rejected');
      banner.classList.add('cookie-consent-hidden');
      setTimeout(function () { banner.remove(); }, 300);
      document.dispatchEvent(new CustomEvent('cookieConsentChanged', { detail: 'rejected' }));
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!getConsent()) {
      createBanner();
    }
  });

  // Expõe uma função global caso você queira, por exemplo,
  // colocar um link "Gerenciar cookies" no rodapé do site.
  window.reopenCookieConsent = function () {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    var existing = document.getElementById('cookieConsentBanner');
    if (existing) existing.remove();
    createBanner();
  };
})();
