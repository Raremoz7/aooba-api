const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
  try {
    const rewards = [
      { nome: 'Caipirinha Tradicional 🍹', pontos_custo: 150, descricao: 'Troque seus pontos por uma refrescante caipirinha.' },
      { nome: 'Cerveja Gelada (Lata) 🍺', pontos_custo: 80, descricao: 'Uma pilsen geladinha por conta da casa.' },
      { nome: 'Porção de Batata P 🍟', pontos_custo: 200, descricao: 'Acompanhamento perfeito para sua resenha.' },
      { nome: 'Shot de Tequila 🌵', pontos_custo: 120, descricao: 'Para animar a noite!' }
    ];

    for (const r of rewards) {
      const exists = await prisma.recompensa.findFirst({ where: { nome: r.nome } });
      if (!exists) {
        await prisma.recompensa.create({
          data: {
            nome: r.nome,
            pontos_custo: r.pontos_custo,
            descricao: r.descricao,
            status: 'ativo'
          }
        });
      }
    }
    console.log('✅ Recompensas semeadas com sucesso!');
  } catch (e) {
    console.error('❌ Erro no Seed:', e);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
