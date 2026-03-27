const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log("Iniciando o Seed do Banco de Dados AOOBA! BAR...")
  
  // 1. Criação do Bar
  const bar = await prisma.bar.upsert({
    where: { slug: 'aooba-bar' },
    update: {},
    create: {
      nome: 'AOOBA! BAR',
      slug: 'aooba-bar',
      mensagem_boas_vindas: 'Seja bem-vindo ao bar mais tecnológico da cidade.',
    }
  })
  console.log(`Bar criado: ${bar.nome}`)

  // 2. Mesas
  for (let i = 1; i <= 50; i++) {
    await prisma.mesa.upsert({
      where: { qr_token: `pwd_${i}` },
      update: {},
      create: { bar_id: bar.id, numero: i, qr_token: `pwd_${i}`, setor: 'interno' }
    });
  }
  console.log("50 Mesas criadas!")

  // 3. Categorias e Produtos
  const categoriasInput = [
    { nome: 'Nargs', ordem: 1 },
    { nome: 'Litrão', ordem: 2 },
    { nome: 'Long Necks', ordem: 3 },
    { nome: 'Energéticos', ordem: 4 },
    { nome: 'Refrigerante', ordem: 5 },
    { nome: 'Sucos', ordem: 6 },
    { nome: 'Doses', ordem: 7 },
    { nome: 'Drinks', ordem: 8 },
    { nome: 'Porções', ordem: 9 },
    { nome: 'Tabacaria', ordem: 10 },
    { nome: 'Happy Hour', ordem: 11 },
    { nome: 'Whisky', ordem: 12 },
  ]

  const categoriasDb = {}
  for (const cat of categoriasInput) {
    let existing = await prisma.produtoCategoria.findFirst({
      where: { bar_id: bar.id, nome: cat.nome }
    });
    if (!existing) {
       existing = await prisma.produtoCategoria.create({
         data: { nome: cat.nome, ordem: cat.ordem, bar_id: bar.id }
       })
    }
    categoriasDb[cat.nome] = existing.id
  }
  
  // 4. Produtos (Extraídos diretamente do Cardápio.md do UX)
  const produtos = [
    // ... (mesma lista de produtos)
  ]

  let count = 0;
  for (const item of produtos) {
    const existingProd = await prisma.produto.findFirst({
      where: { categoria_id: categoriasDb[item.c], nome: item.n }
    });
    if (!existingProd) {
      await prisma.produto.create({
        data: {
          categoria_id: categoriasDb[item.c],
          nome: item.n,
          preco: item.p,
          status: item.s,
          descricao: item.d || null
        }
      })
      count++;
    }
  }
  
  // 5. Configuração de Fidelidade
  const configFid = await prisma.configFidelidade.findUnique({ where: { bar_id: bar.id } });
  if (!configFid) {
    await prisma.configFidelidade.create({
      data: {
        bar_id: bar.id,
        pts_por_real: 1.0,
        pts_cadastro: 50,
        pts_musica_tocada: 10
      }
    });
  }

  // 6. Recompensas MOCK
  const recompensas = [
    { nome: 'Cerveja Grátis', descricao: 'Ganhe um litrão por conta da casa!', pontos_custo: 100 },
    { nome: 'Rosh Comum', descricao: 'Sessão de narguilé free', pontos_custo: 200 },
    { nome: 'Combo Chivas', descricao: 'Desconto de R$ 50 no combo', pontos_custo: 500 },
  ];

  for (const r of recompensas) {
    const existingR = await prisma.recompensa.findFirst({ where: { nome: r.nome } });
    if (!existingR) {
      await prisma.recompensa.create({ data: r });
    }
  }

  // 7. Mock Dados Operacionais...
  // (Resto do script com checagem de existência)
  const existingCliente = await prisma.cliente.findUnique({ where: { cpf_ou_telefone: '11999999999' } });
  if (!existingCliente) {
    const cliente = await prisma.cliente.create({
      data: { nome: 'Davi UX Designer', cpf_ou_telefone: '11999999999', pontos_fidelidade: 150 }
    });
    const mesa1 = await prisma.mesa.findFirst({ where: { numero: 1 } });
    if (mesa1) {
      const sessao = await prisma.sessao.create({
        data: { mesa_id: mesa1.id, cliente_id: cliente.id, total: 45.99 }
      });
      const produto = await prisma.produto.findFirst({ where: { nome: 'Litrão Original' } });
      if (produto) {
        await prisma.pedido.create({
          data: {
            sessao_id: sessao.id, status: 'preparando',
            itens_pedido: { create: [{ produto_id: produto.id, quantidade: 2, preco_unitario: produto.preco }] }
          }
        });
      }
      await prisma.sugestaoMusica.createMany({
        data: [
          { sessao_id: sessao.id, nome: 'Aoba Mix', artista: 'DJ Aooba', capa: 'https://placehold.co/600x600/orange/white?text=Aoba+Mix', status: 'playing', spotify_track_id: '1' },
          { sessao_id: sessao.id, nome: 'Vibe das 21h', artista: 'Radio Aoba', capa: 'https://placehold.co/600x600/purple/white?text=Vibe', status: 'pendente', spotify_track_id: '2' }
        ]
      });
    }
  }

  console.log(`Seed concluído com sucesso!`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
