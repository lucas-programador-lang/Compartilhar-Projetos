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
      '<div class="cookie-consent-card">' +
        '<div class="cookie-consent-icon" aria-hidden="true">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
            '<path d="M21 12.5c0 5-4 8.5-9 8.5s-9-3.5-9-8.5S7 3 12 3c.6 0 1.1.4 1.1 1 0 .3-.1.5-.3.7-.2.2-.3.5-.3.8 0 .6.5 1 1.1 1h.2c1.6 0 3 1.3 3 3v.1c0 .6.4 1 1 1h.1c1.1 0 2.1.9 2.1 2.9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
            '<circle cx="9" cy="11" r="1.1" fill="currentColor"/>' +
            '<circle cx="8.5" cy="15.5" r="1.1" fill="currentColor"/>' +
            '<circle cx="12.5" cy="17" r="1.1" fill="currentColor"/>' +
          '</svg>' +
        '</div>' +
        '<div class="cookie-consent-body">' +
          '<h3 class="cookie-consent-title">Nós usamos cookies</h3>' +
          '<p class="cookie-consent-text">' +
            'Usamos cookies essenciais para manter você logado, lembrar preferências e melhorar sua experiência no Compartilhar Projetos. ' +
            'Veja nossa ' +
            '<a href="/privacidade.html">Política de Privacidade</a>.' +
          '</p>' +
          '<div class="cookie-consent-actions">' +
            '<button type="button" id="cookieConsentReject" class="cookie-consent-btn cookie-consent-btn-ghost">Recusar não essenciais</button>' +
            '<button type="button" id="cookieConsentAccept" class="cookie-consent-btn cookie-consent-btn-primary">Aceitar todos</button>' +
          '</div>' +
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
