export async function onRequest(context) {
  const url = new URL(context.request.url);
  
  // Se alguém acessar pelo link do pages.dev, troca para o domínio oficial
  if (url.hostname === 'compartilhar-projetos.pages.dev') {
    url.hostname = 'compartilhar-projetos.com.br';
    
    // Retorna um Redirecionamento 301 (Permanente)
    return Response.redirect(url.toString(), 301);
  }
  
  // Se já estiver no domínio certo, deixa o site carregar normalmente
  return context.next();
}
