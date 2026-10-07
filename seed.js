/* =========================================================
   COMPARTILHAR PROJETOS — SEED.JS
   Dados iniciais do "banco" quando o Realtime Database ainda
   está vazio. Usado apenas por db-sync.js.

   IMPORTANTE: os usuários de demonstração aqui (admin/senha e
   marina/senha) NÃO criam contas de autenticação automaticamente.
   Veja a nota no final deste arquivo.
   ========================================================= */

export function uid(prefix) {
  return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 10);
}

export function nowISO() {
  return new Date().toISOString();
}

export function seedDB() {
  const adminId = uid("u");
  const demoId = uid("u");
  const day = 24 * 60 * 60 * 1000;

  const users = [
    {
      id: adminId,
      name: "Equipe Compartilhar Projetos",
      email: "admin@compartilharprojetos.com",
      role: "admin",
      isAdmin: true,
      avatarColor: "#1d4fc4",
      createdAt: nowISO(),
      refCode: "ADMIN01",
      referredBy: null,
      subscription: { active: false, plan: null, expiresAt: null },
      suspended: false,
      bio: "Conta oficial da plataforma.",
    },
    {
      id: demoId,
      name: "Marina Duarte",
      email: "marina@demo.com",
      role: "user",
      isAdmin: false,
      avatarColor: "#b8860b",
      createdAt: nowISO(),
      refCode: "MARINA7X",
      referredBy: null,
      subscription: { active: true, plan: "p7", expiresAt: new Date(Date.now() + 7 * day).toISOString() },
      suspended: false,
      bio: "Product designer e criadora de side-projects.",
    },
  ];

  const categories = [
    { id: uid("c"), name: "Web" },
    { id: uid("c"), name: "Mobile" },
    { id: uid("c"), name: "Design" },
    { id: uid("c"), name: "Inteligência Artificial" },
    { id: uid("c"), name: "Open Source" },
    { id: uid("c"), name: "Jogos" },
  ];
  const catByName = (n) => categories.find((c) => c.name === n).id;

  const projects = [
    {
      id: uid("pj"),
      title: "Nimbus — Painel financeiro para freelancers",
      description:
        "Nimbus ajuda freelancers a organizar contratos, cobranças e fluxo de caixa em um só lugar.\n\nConstruído com foco em simplicidade: sem planilhas, sem complicação. Você cadastra o cliente, gera a cobrança e acompanha o status de pagamento em tempo real.",
      images: ["https://images.unsplash.com/photo-1551288049-bebda4e38f71?q=80&w=1200&auto=format&fit=crop"],
      categoryId: catByName("Web"),
      link: "https://example.com/nimbus",
      ownerName: "Marina Duarte",
      contact: "marina@demo.com",
      ownerId: demoId,
      createdAt: nowISO(),
      status: "published",
    },
    {
      id: uid("pj"),
      title: "Trilha — App de trilhas e caminhadas offline",
      description:
        "Um app mobile para quem gosta de explorar trilhas sem depender de internet. Mapas offline, registro de percurso e comunidade de trilheiros.",
      images: ["https://images.unsplash.com/photo-1551632811-561732d1e306?q=80&w=1200&auto=format&fit=crop"],
      categoryId: catByName("Mobile"),
      link: "https://example.com/trilha",
      ownerName: "Marina Duarte",
      contact: "(11) 99888-2211",
      ownerId: demoId,
      createdAt: new Date(Date.now() - 2 * day).toISOString(),
      status: "published",
    },
    {
      id: uid("pj"),
      title: "Verso — Design system para produtos B2B",
      description:
        "Uma biblioteca de componentes acessíveis e tokens de design pensados para produtos B2B que precisam escalar rápido sem perder consistência visual.",
      images: ["https://images.unsplash.com/photo-1559028012-481c04fa702d?q=80&w=1200&auto=format&fit=crop"],
      categoryId: catByName("Design"),
      link: "https://example.com/verso",
      ownerName: "Marina Duarte",
      contact: "marina@demo.com",
      ownerId: demoId,
      createdAt: new Date(Date.now() - 5 * day).toISOString(),
      status: "published",
    },
  ];

  const posts = [
    {
      id: uid("post"),
      authorId: demoId,
      content:
        "Pessoal, acabei de publicar o Nimbus por aqui! Feedback de quem trabalha como freelancer é muito bem-vindo 🙌",
      createdAt: nowISO(),
      comments: [
        {
          id: uid("cm"),
          authorId: adminId,
          content: "Parabéns pelo lançamento! A plataforma está de portas abertas para você divulgar mais.",
          createdAt: nowISO(),
          replies: [],
        },
      ],
    },
  ];

  return {
    users,
    categories,
    projects,
    posts,
    referrals: [],
    commissions: [],
    withdrawals: [],
  };
}

/* NOTA IMPORTANTE:
   Esses usuários de seed (admin@compartilharprojetos.com e
   marina@demo.com) existem só dentro do Realtime Database — eles
   NÃO têm conta correspondente no Firebase Authentication ainda.
   Para conseguir logar como admin, crie a conta pelo formulário
   normal de cadastro (register.html) usando esse e-mail, ou crie
   manualmente em Firebase Console → Authentication → Add user,
   depois edite o campo "id" desse usuário no Realtime Database
   para bater com o UID gerado. O mais simples é: cadastre-se
   normalmente e depois, no console, mude o "role" desse usuário
   para "admin" na aba Realtime Database. */
