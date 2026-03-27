const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log("Iniciando banco de dados AOOBA...")

  const bar = await prisma.bar.upsert({
    where: { slug: 'aooba-bar' },
    update: {},
    create: {
      nome: 'AOOBA! BAR',
      slug: 'aooba-bar',
      mensagem_boas_vindas: 'Seja bem-vindo ao bar mais tecnológico da cidade.',
      senha_master: '1234',
      active: true,
      aberto: true,
    }
  })
  console.log(`Bar criado: ${bar.nome} (id: ${bar.id})`)

  // Mesas
  for (let i = 1; i <= 20; i++) {
    await prisma.mesa.upsert({
      where: { qr_token: `pwd_${i}` },
      update: {},
      create: { bar_id: bar.id, numero: i, qr_token: `pwd_${i}`, setor: 'interno' }
    });
  }
  console.log("20 Mesas criadas!")

  // Config fidelidade
  const cfg = await prisma.configFidelidade.findUnique({ where: { bar_id: bar.id } });
  if (!cfg) {
    await prisma.configFidelidade.create({
      data: { bar_id: bar.id, pts_por_real: 1.0, pts_cadastro: 50, pts_musica_tocada: 10 }
    });
    console.log("Config fidelidade criada!")
  }

  console.log("Init concluído com sucesso!")
}

main()
  .catch((e) => { console.error("Erro no init:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); })
