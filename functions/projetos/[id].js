/* =========================================================
   COMPARTILHAR PROJETOS — functions/projeto/[id].js
   Cloudflare Pages Function

   Resolve o problema da prévia quebrada ao compartilhar um projeto:
   o site é uma SPA com rota por hash (#/projeto/123), e tudo que vem
   depois do # nunca chega ao servidor — então, sem isso, toda prévia
   no WhatsApp/Twitter/Facebook mostrava só o título genérico do site,
   nunca o título/descrição do projeto específico.

   Como funciona:
   - URL real (sem #) tipo /projeto/123 cai aqui, nesta function.
   - Se quem pediu a página é um robô de prévia (WhatsApp, Twitter,
     Facebook, Telegram, Discord, LinkedIn, Slack, Google, etc.),
     devolve um HTML enxuto só com as meta tags certas — rápido,
     sem precisar carregar o app inteiro.
   - Se é uma pessoa de verdade, serve o index.html de verdade NESSA
     MESMA URL (sem redirecionar) e deixa um script pequeno ajustar a
     rota internamente (via history.replaceState) assim que a página
     carrega. Importante: isso NÃO é por capricho — um redirect pra
     uma URL com # quebra dentro do navegador embutido do WhatsApp/
     Instagram/Facebook em vários casos, fazendo os arquivos do site
     (style.css, script.js etc.) serem buscados no lugar errado.
     Servir o HTML direto, sem trocar de URL, evita esse problema.

   Observação: as fotos dos projetos ficam salvas como data: URL no
   Firebase (não são um link público de imagem), então og:image usa
   uma imagem padrão do site — não dá pra mostrar a foto do projeto
   na prévia por enquanto. Se quiser isso no futuro, dá pra guardar
   as fotos em algum storage com URL pública (R2, por exemplo) e essa
   function passa a usar a foto real do projeto.
   ========================================================= */

const FIREBASE_DB_URL = "https://compartilhar-projetos-default-rtdb.firebaseio.com";
const SITE_ORIGIN = "https://compartilhar-projetos.com.br";
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/favicon-512.png`;

// Cobre os principais robôs de prévia + crawlers de busca. O "bot|crawl|
// spider" genérico no fim pega qualquer outro que não listamos.
const BOT_UA_REGEX = /facebookexternalhit|whatsapp|telegrambot|discordbot|linkedinbot|twitterbot|slackbot|skypeuripreview|pinterest|applebot|googlebot|bingbot|yandex|duckduckbot|embedly|quora link preview|w3c_validator|bot|crawl|spider/i;

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function findPublishedProject(id) {
  const res = await fetch(`${FIREBASE_DB_URL}/database/projects.json`);
  if (!res.ok) return null;
  const raw = await res.json();
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  return entries.find((p) => p && p.id === id && p.status === "published") || null;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const id = params.id;
  const userAgent = request.headers.get("User-Agent") || "";
  const isBot = BOT_UA_REGEX.test(userAgent);
  const hashRoute = `/projeto/${encodeURIComponent(id)}`;
  const targetSpaUrl = `${SITE_ORIGIN}/#${hashRoute}`;

  let project = null;
  try { project = await findPublishedProject(id); } catch (err) { project = null; }

  if (isBot) {
    if (!project) {
      // Projeto não existe ou não está publicado: sem dado pra prévia
      // específica — ainda assim devolve 200/404 com algo mínimo
      // (crawlers não seguem redirect 302 de forma confiável pra gerar
      // prévia).
      return new Response(
        `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Compartilhar Projetos</title></head><body></body></html>`,
        { status: 404, headers: { "Content-Type": "text/html; charset=UTF-8" } }
      );
    }

    const title = escapeHtml(project.title);
    const description = escapeHtml((project.description || "").slice(0, 200));
    // Projetos mais antigos ainda guardam a foto como data: URL (não dá
    // pra usar como og:image). Projetos novos têm uma URL http(s) de
    // verdade (R2, via worker.js) — só essa forma funciona na prévia.
    const firstImage = Array.isArray(project.images) ? project.images[0] : null;
    const ogImage = firstImage && /^https?:\/\//.test(firstImage) ? firstImage : DEFAULT_OG_IMAGE;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${title} | Compartilhar Projetos</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${SITE_ORIGIN}${hashRoute}">
<meta property="og:site_name" content="Compartilhar Projetos">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${ogImage}">
<link rel="canonical" href="${targetSpaUrl}">
</head>
<body>
<h1>${title}</h1>
<p>${description}</p>
<p><a href="${targetSpaUrl}">Ver projeto em Compartilhar Projetos</a></p>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "public, max-age=300" },
    });
  }

  // Pessoa de verdade: busca o index.html real da implantação (Cloudflare
  // Pages expõe os arquivos estáticos via env.ASSETS) e devolve ELE MESMO
  // nesta URL — sem redirecionar. <base href="/"> garante que style.css,
  // script.js etc. (referenciados com caminho relativo no index.html)
  // continuem resolvendo certinho mesmo a página tendo sido pedida em
  // /projeto/123 (um nível "mais fundo" que a raiz). O script injetado
  // ajusta a URL pra #/projeto/123 via history.replaceState — isso roda
  // no navegador, depois que a página já carregou, então não tem o
  // problema de redirect quebrando em navegador embutido.
  try {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/index.html";
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
    if (assetResponse.ok) {
      let html = await assetResponse.text();
      html = html.replace(
        "<head>",
        `<head>\n<base href="/">\n<script>history.replaceState(null, "", "/#${hashRoute}");</script>`
      );
      return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }
  } catch (err) { /* cai no redirect de segurança abaixo */ }

  // Rede de segurança: se por algum motivo não der pra buscar o
  // index.html real, ainda manda a pessoa pra rota certa.
  return Response.redirect(targetSpaUrl, 302);
}
