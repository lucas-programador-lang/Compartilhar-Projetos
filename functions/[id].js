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
   - Se é uma pessoa de verdade, redireciona direto pra SPA de sempre,
     já na rota certa (#/projeto/123).

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
  const { request, params } = context;
  const id = params.id;
  const userAgent = request.headers.get("User-Agent") || "";
  const isBot = BOT_UA_REGEX.test(userAgent);
  const targetSpaUrl = `${SITE_ORIGIN}/#/projeto/${encodeURIComponent(id)}`;

  if (!isBot) {
    // Pessoa de verdade: manda direto pra SPA, já na rota certa.
    return Response.redirect(targetSpaUrl, 302);
  }

  let project = null;
  try { project = await findPublishedProject(id); } catch (err) { project = null; }

  if (!project) {
    // Projeto não existe ou não está publicado: sem dado pra prévia
    // específica, só manda pro link normal (o app mostra "não encontrado").
    return Response.redirect(targetSpaUrl, 302);
  }

  const title = escapeHtml(project.title);
  const description = escapeHtml((project.description || "").slice(0, 200));

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${title} | Compartilhar Projetos</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${DEFAULT_OG_IMAGE}">
<meta property="og:url" content="${SITE_ORIGIN}/projeto/${encodeURIComponent(id)}">
<meta property="og:site_name" content="Compartilhar Projetos">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${DEFAULT_OG_IMAGE}">
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
