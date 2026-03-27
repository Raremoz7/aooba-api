require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const spotifyService = require('./services/spotifyService');
const xml2js = require('xml2js');
const { verifyToken } = require('./auth');

// Configuração do Multer (Upload de Imagens Local)
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, 'produto-' + uniqueSuffix + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

// Origens permitidas — inclui localhost e qualquer tunnel (ngrok, localtunnel, etc.)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : true; // true = aceita qualquer origem (modo demo)

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Armazena IDs propostos simulando banco de dados no MVP
let orderIdCounter = 1050;

// Rastreia sessões que solicitaram fechamento (sem mudança de schema)
const closingSessionIds = new Set();
let currentPromo = {
  active: false,
  title: '',
  description: '',
  image: '',
  productId: null,
  originalPrice: 0,
  promoPrice: 0,
  percentage: 0,
  countdown: 0
};

let playerMusicVisible = true;

// Auxiliar para Auditoria
async function logAction(bar_id, admin_id, acao, detalhes) {
  try {
    await prisma.auditLog.create({
      data: {
        bar_id,
        admin_id: admin_id || 'system',
        acao,
        detalhes_json: JSON.stringify(detalhes)
      }
    });
  } catch (err) {
    console.error('❌ Erro ao logar ação:', err);
  }
}

// F4: Verifica alertas de estoque e emite notificações
async function checkStockAlert(io, produto_id, estoque_atual, estoque_minimo, nome) {
  try {
    if (estoque_atual === 0) {
      await prisma.alertaEstoque.create({
        data: { produto_id, tipo: 'esgotado', mensagem: `${nome} ESGOTADO!` }
      });
      await prisma.produto.update({ where: { id: produto_id }, data: { status: 'esgotado' } });
      io.emit('stock_alert', { type: 'esgotado', produto: nome, estoque: 0 });
      io.emit('refresh_data');
    } else if (estoque_atual <= estoque_minimo) {
      await prisma.alertaEstoque.create({
        data: { produto_id, tipo: 'baixo', mensagem: `${nome} com estoque baixo (${estoque_atual} un)` }
      });
      io.emit('stock_alert', { type: 'baixo', produto: nome, estoque: estoque_atual });
    }
  } catch (err) {
    console.error('❌ Erro ao verificar alerta de estoque:', err);
  }
}

app.get('/api/test-get', (req, res) => res.json({ ok: true }));
app.post('/api/test-post', (req, res) => res.json({ ok: true, body: req.body }));

// Verifica se telefone já está cadastrado
app.get('/api/clientes/check', async (req, res) => {
  const { telefone } = req.query;
  if (!telefone) return res.json({ exists: false });
  const cliente = await prisma.cliente.findUnique({
    where: { cpf_ou_telefone: String(telefone) },
    select: { id: true, nome: true }
  });
  res.json({ exists: !!cliente, nome: cliente?.nome || null });
});

// Abertura de Sessão (Tela de Identificação)
app.post('/api/sessoes/identificar', async (req, res) => {
  console.log('📬 Recebido POST /api/sessoes/identificar:', req.body);
  try {
    const { nome, telefone, numeroMesa, aniversario_dia, aniversario_mes, aceite_marketing, mode } = req.body;
    
    // MVP: Pega o primeiro bar ativo
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: "Nenhum bar ativo configurado." });

    // 1. Encontra ou Cria a Mesa
    let mesa = await prisma.mesa.findFirst({
      where: { bar_id: bar.id, numero: parseInt(numeroMesa) }
    });
    
    if (!mesa) {
      mesa = await prisma.mesa.create({
        data: {
          bar_id: bar.id,
          numero: parseInt(numeroMesa),
          qr_token: `mesa-${numeroMesa}-${Date.now()}`,
          status: 'ocupada'
        }
      });
    } else {
      mesa = await prisma.mesa.update({ where: { id: mesa.id }, data: { status: 'ocupada' }});
    }

    // 2. Encontra ou Cria o Cliente (O Telefone é a chave unívoca)
    let cliente = await prisma.cliente.findUnique({
      where: { cpf_ou_telefone: telefone }
    });

    if (!cliente) {
      // Modo login: cliente não encontrado → erro
      if (mode === 'login') {
        return res.status(404).json({ error: 'Número não encontrado. Faça o cadastro primeiro.' });
      }
      if (!nome || nome.length < 2) {
        return res.status(400).json({ error: 'Nome é obrigatório para novo cadastro.' });
      }
      // Buscar bônus de boas-vindas real do bar
      const barInfo = await prisma.bar.findFirst({ include: { config_fidelidade: true } });
      const ptsBoasVindas = (barInfo?.fidelidade_ativa && barInfo?.config_fidelidade) ? barInfo.config_fidelidade.pts_cadastro : 0;

      cliente = await prisma.cliente.create({
        data: {
          cpf_ou_telefone: telefone,
          nome: nome,
          pontos_fidelidade: ptsBoasVindas,
          aniversario_dia: aniversario_dia ? parseInt(aniversario_dia) : null,
          aniversario_mes: aniversario_mes ? parseInt(aniversario_mes) : null,
          aceite_marketing: aceite_marketing === true,
          ultimo_acesso: new Date(),
          total_visitas: 1
        }
      });
      console.log(`🎁 Novo cliente ${nome} criado com bônus de ${ptsBoasVindas} pontos.`);
    } else {
      // Cliente existente: atualiza visitas, último acesso e nome (se fornecido)
      const updateData = {
        ultimo_acesso: new Date(),
        total_visitas: { increment: 1 }
      };
      if (nome && nome.length >= 2) updateData.nome = nome;
      // Só preenche aniversário se fornecido e ainda não cadastrado
      if (aniversario_dia && !cliente.aniversario_dia) {
        updateData.aniversario_dia = parseInt(aniversario_dia);
        updateData.aniversario_mes = parseInt(aniversario_mes);
      }
      if (aceite_marketing !== undefined) {
        updateData.aceite_marketing = aceite_marketing === true;
      }
      cliente = await prisma.cliente.update({
        where: { id: cliente.id },
        data: updateData
      });
    }

    // 3. Multi-device: Verifica se já existe uma sessão ativa para este cliente (mesmo em outra mesa)
    // Se for na mesma mesa, reaproveitamos. Se for em outra, deslogamos a anterior (regra de negócio)
    let sessao = await prisma.sessao.findFirst({
      where: {
        cliente_id: cliente.id,
        fechada_em: null 
      },
      include: { mesa: true, cliente: true }
    });

    if (sessao && sessao.mesa_id !== mesa.id) {
       // Opcional: Fechar sessão anterior ou apenas avisar. Vamos fechar por segurança.
       await prisma.sessao.update({
         where: { id: sessao.id },
         data: { fechada_em: new Date(), device_id: 'displaced' }
       });
       sessao = null;
    }

    // 4. Cria ou Recupera a Sessão
    if (!sessao) {
      sessao = await prisma.sessao.create({
        data: {
          mesa_id: mesa.id,
          cliente_id: cliente.id,
          device_id: req.headers['user-agent'] || 'unknown'
        },
        include: { mesa: true, cliente: true }
      });
    }

    // Calcula Nível de Fidelidade (Mock simples baseado em pontos)
    const pontos = cliente.pontos_fidelidade || 0;
    let nivel = "Iniciante 🌱";
    if (pontos > 100) nivel = "Habitué 🔥";
    if (pontos > 500) nivel = "Vip ⭐";

    // Verificar se é aniversário do cliente
    const hoje = new Date();
    const isAniversario = cliente.aniversario_dia === hoje.getDate() && cliente.aniversario_mes === (hoje.getMonth() + 1);

    console.log('✅ Sessão aberta com sucesso:', sessao.id);
    res.json({
      ...sessao,
      cliente: {
        ...sessao.cliente,
        aniversario_dia: cliente.aniversario_dia,
        aniversario_mes: cliente.aniversario_mes,
        total_visitas: cliente.total_visitas
      },
      fidelidade: {
        pontos,
        nivel
      },
      isAniversario
    });
  } catch (error) {
    console.error('❌ Erro na Abertura de Sessão:', error);
    res.status(500).json({ error: "Erro ao abrir sessão" });
  }
});

// Histórico de Pedidos de uma Sessão Específica
app.get('/api/sessoes/:id/pedidos', async (req, res) => {
  try {
    const { id } = req.params;
    const pedidos = await prisma.pedido.findMany({
      where: { sessao_id: id },
      include: {
        itens_pedido: { include: { produto: true } }
      },
      orderBy: { criado_em: 'desc' }
    });

    const formatados = pedidos.map(p => ({
      id: p.id,
      status: p.status,
      time: new Date(p.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      total: p.itens_pedido.reduce((acc, i) => acc + (i.preco_unitario * i.quantidade), 0),
      items: p.itens_pedido.map(i => ({
        qtd: i.quantidade,
        name: i.produto.nome,
        preco: i.preco_unitario
      }))
    }));

    res.json(formatados);
  } catch (error) {
    console.error("Erro ao buscar histórico da sessão:", error);
    res.status(500).json({ error: "Erro interno DB" });
  }
});

io.on('connection', (socket) => {
  console.log('🔗 Device connected via WebSocket:', socket.id);

  // Sincroniza promo ativa ao conectar
  socket.emit('promo_sync', currentPromo);
  socket.emit('player_mode_sync', playerMusicVisible);

  // Cliente disparou novo pedido
  socket.on('new_order', async (data) => {
    try {
      let finalOrderData = { ...data, status: 'recebido', time: 'Agora' };
      
      // Se mandar sessão e itens estruturados, gravamos no Prisma
      if (data.sessao_id && data.items && data.items.length > 0) {
        try {
          const pedidoCriado = await prisma.pedido.create({
            data: {
              sessao_id: data.sessao_id,
              status: 'recebido',
              itens_pedido: {
                create: data.items.map(item => ({
                  produto_id: item.produto_id,
                  quantidade: item.qtd,
                  preco_unitario: item.preco_unitario || 0,
                  observacao: item.observacao || '',
                  opcoes_escolhidas: item.opcoes_escolhidas || ''
                }))
              }
            },
            include: {
              itens_pedido: true,
              sessao: { include: { mesa: true, cliente: true } }
            }
          });

          // Atualiza o objeto de broadcast com IDs reais e dados formatados pro Admin
          finalOrderData = {
            id: pedidoCriado.id,
            sessao_id: data.sessao_id,
            table: pedidoCriado.sessao.mesa.numero,
            client: pedidoCriado.sessao.cliente.nome,
            time: new Date(pedidoCriado.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute:'2-digit' }),
            status: pedidoCriado.status,
            items: data.items // mantemos o formato de exibição name e qtd
          };
          console.log('🍕 Pedido persistido no BD com Sucesso:', pedidoCriado.id);

          // F3/F4: Baixa automática de estoque
          for (const item of data.items) {
            try {
              const produto = await prisma.produto.findUnique({ where: { id: item.produto_id } });
              if (produto && produto.controlar_estoque && produto.estoque_atual > 0) {
                const novoEstoque = Math.max(0, produto.estoque_atual - item.qtd);
                await prisma.produto.update({
                  where: { id: item.produto_id },
                  data: { estoque_atual: novoEstoque }
                });
                await prisma.movimentacaoEstoque.create({
                  data: {
                    produto_id: item.produto_id,
                    tipo: 'venda',
                    quantidade: -item.qtd,
                    estoque_antes: produto.estoque_atual,
                    estoque_depois: novoEstoque,
                    motivo: `Pedido ${pedidoCriado.id}`
                  }
                });
                await checkStockAlert(io, item.produto_id, novoEstoque, produto.estoque_minimo, produto.nome);
              }
            } catch (stockErr) {
              console.error('⚠️ Erro na baixa de estoque:', stockErr);
            }
          }
        } catch (dbError) {
          console.error("Erro Prisma ao salvar:", dbError);
          finalOrderData.id = orderIdCounter++; // Fallback se errar o BD
        }
      } else {
        finalOrderData.id = orderIdCounter++; // Fallback MVC sem sessão
      }
      
      // Confirma envio para quem pediu
      socket.emit('order_confirmation', { success: true, id: finalOrderData.id });
      
      // Dispara alerta global (Atinge Painel Admin Dashboards)
      io.emit('order_broadcast', finalOrderData);
    } catch (error) {
      console.error('Erro extremo no WebSocket new_order:', error);
    }
  });
  
  // Painel Admin ou Garçom atualizou o Status do Pedido
  socket.on('update_order_status', async (data) => {
    console.log('🔄 Atualização de Pedido:', data);
    
    try {
      // 1. Atualiza no Banco de Dados (registra garcom_id se informado)
      await prisma.pedido.update({
        where: { id: data.id },
        data: {
          status: data.status,
          ...(data.garcom_id ? { garcom_id: data.garcom_id } : {})
        }
      });

      // 2. Se status for entregue, dar pontos ao cliente
      if (data.status === 'entregue') {
         // ... (lógica de pontos mantida)
         const pedido = await prisma.pedido.findUnique({
           where: { id: data.id },
           include: { 
             itens_pedido: true,
             sessao: { include: { cliente: true } }
           }
         });

         if (pedido && pedido.sessao && pedido.sessao.cliente) {
           const barInfo = await prisma.bar.findFirst({ include: { config_fidelidade: true } });
           if (barInfo && barInfo.fidelidade_ativa) {
              const config = barInfo.config_fidelidade || { pts_por_real: 1 };
              const totalPedido = pedido.itens_pedido.reduce((acc, i) => acc + (i.preco_unitario * i.quantidade), 0);
              const pontosGanhos = Math.floor(totalPedido * config.pts_por_real);

              await prisma.cliente.update({
                where: { id: pedido.sessao.cliente.id },
                data: { pontos_fidelidade: { increment: pontosGanhos } }
              });

              console.log(`💎 Cliente ${pedido.sessao.cliente.nome} ganhou ${pontosGanhos} pontos!`);
              io.emit('points_updated', { cliente_id: pedido.sessao.cliente.id, pontos_ganhos: pontosGanhos });
           }
         }
      }

      // 3. Notifica todos os sistemas (Admin, Cliente, Garçom)
      io.emit('order_status_changed', data);
    } catch (err) {
      console.error("Erro ao atualizar status do pedido:", err);
    }
  });

  // Eventos de Apoio à Mesa (Garçom / Conta)
  socket.on('call_waiter', async (data) => {
    try {
      console.log(`🔔 Mesa ${data.mesa} chamando garçom!`);
      const bar = await prisma.bar.findFirst();
      if (bar) {
        await prisma.mesa.updateMany({
           where: { bar_id: bar.id, numero: parseInt(data.mesa) },
           data: { status: 'atencao' }
        });
      }
      io.emit('waiter_requested', data);
      io.emit('refresh_data');
    } catch (err) { console.error(err); }
  });

  socket.on('request_closure', async (data) => {
    try {
      console.log(`🧾 Mesa ${data.mesa} pedindo conta! Sessão: ${data.sessao_id}`);

      if (data.sessao_id) {
        closingSessionIds.add(data.sessao_id);
      }

      const bar = await prisma.bar.findFirst();
      if (bar && data.mesa) {
        const sessoesAtivas = await prisma.sessao.findMany({
          where: { mesa: { bar_id: bar.id, numero: parseInt(data.mesa) }, fechada_em: null }
        });
        const todasFechando = sessoesAtivas.length > 0 && sessoesAtivas.every(s => closingSessionIds.has(s.id));
        if (todasFechando) {
          await prisma.mesa.updateMany({
            where: { bar_id: bar.id, numero: parseInt(data.mesa) },
            data: { status: 'fechando' }
          });
        }
      }

      // Busca nome do cliente se não veio no payload
      let clienteNome = data.cliente_nome || null;
      if (!clienteNome && data.sessao_id) {
        try {
          const sessao = await prisma.sessao.findUnique({ where: { id: data.sessao_id }, include: { cliente: true } });
          clienteNome = sessao?.cliente?.nome || null;
        } catch (_) {}
      }

      io.emit('closure_requested', { mesa: data.mesa, sessao_id: data.sessao_id, cliente_nome: clienteNome });
    } catch (err) {
      console.error('Erro em request_closure:', err);
      io.emit('closure_requested', data);
    }
  });

  // Cliente entra na sala da sua sessão para receber eventos específicos
  socket.on('join_session', ({ sessao_id }) => {
    if (sessao_id) socket.join(`sessao_${sessao_id}`);
  });

  // Cliente sugeriu música
  socket.on('suggest_music', async (data) => {
    try {
      console.log(`🎵 Nova sugestão de música: ${data.nome} por ${data.artista}`);
      if (data.sessao_id) {
        await prisma.sugestaoMusica.create({
          data: {
            sessao_id: data.sessao_id,
            spotify_track_id: data.id || 'mock-id',
            nome: data.nome,
            artista: data.artista,
            duracao: data.duracao || null,
            capa: data.capa || null,
            status: 'pendente'
          }
        });
      }
      // Avisa o Admin para atualizar a fila
      io.emit('music_suggested', data);
    } catch (err) {
      console.error("Erro ao salvar música:", err);
    }
  });

  // Cliente chamando garçom
  socket.on('call_waiter', (data) => {
    console.log(`🛎️ Garçom solicitado na Mesa ${data.mesa}`);
    // Notifica o Admin
    io.emit('waiter_requested', data);
  });

  // Admin atualizou a Flash Promo
  socket.on('update_promo', (data) => {
    console.log('🔥 Atualização de Flash Promo:', data.message);
    currentPromo = data;
    io.emit('promo_sync', currentPromo);
  });

  // Admin alternou visibilidade da música no player
  socket.on('toggle_player_mode', (visible) => {
    playerMusicVisible = visible;
    io.emit('player_mode_sync', playerMusicVisible);
  });

  // Admin atualizou mural Instagram
  socket.on('instagram_wall_update', (data) => {
    io.emit('instagram_wall_sync', data);
  });

  // Cliente solicitou fechamento da conta (por sessão individual)
  socket.on('close_account', async (data) => {
    try {
      console.log(`🧾 Solicitação de fechamento: Mesa ${data.mesa}, Sessão ${data.sessao_id}`);

      if (data.sessao_id) {
        closingSessionIds.add(data.sessao_id);
      }

      const bar = await prisma.bar.findFirst();
      if (bar) {
        // Verifica se TODAS as sessões ativas da mesa estão solicitando fechamento
        const sessoesAtivas = await prisma.sessao.findMany({
          where: { mesa: { bar_id: bar.id, numero: parseInt(data.mesa) }, fechada_em: null }
        });
        const todasFechando = sessoesAtivas.length > 0 && sessoesAtivas.every(s => closingSessionIds.has(s.id));
        if (todasFechando) {
          await prisma.mesa.updateMany({
            where: { bar_id: bar.id, numero: parseInt(data.mesa) },
            data: { status: 'fechando' }
          });
        }
      }

      // Inclui nome do cliente para o garçom exibir
      let clienteNome = data.cliente_nome || null;
      if (!clienteNome && data.sessao_id) {
        try {
          const sessao = await prisma.sessao.findUnique({ where: { id: data.sessao_id }, include: { cliente: true } });
          clienteNome = sessao?.cliente?.nome || null;
        } catch (_) {}
      }

      io.emit('closure_requested', { mesa: data.mesa, sessao_id: data.sessao_id, cliente_nome: clienteNome });
    } catch (error) {
       console.error("Erro ao solicitar fechamento:", error);
    }
  });

  // Admin confirmou o fechamento (pagamento realizado) — por sessão individual
  socket.on('confirm_closure', async (data) => {
    try {
      // Suporta tanto { sessao_id, metodo_pgto } (novo) quanto { mesa, metodo_pgto } (legado)
      let sessaoAtiva = null;
      const bar = await prisma.bar.findFirst();
      if (!bar) return;

      if (data.sessao_id) {
        sessaoAtiva = await prisma.sessao.findUnique({
          where: { id: data.sessao_id },
          include: {
            cliente: true,
            mesa: true,
            pedidos: { include: { itens_pedido: { include: { produto: true } } } }
          }
        });
      } else if (data.mesa) {
        // Fallback legado: fecha a primeira sessão ativa da mesa
        const mesa = await prisma.mesa.findFirst({ where: { bar_id: bar.id, numero: parseInt(data.mesa) } });
        if (mesa) {
          sessaoAtiva = await prisma.sessao.findFirst({
            where: { mesa_id: mesa.id, fechada_em: null },
            include: {
              cliente: true,
              mesa: true,
              pedidos: { include: { itens_pedido: { include: { produto: true } } } }
            }
          });
        }
      }

      if (!sessaoAtiva) {
        console.warn('confirm_closure: sessão não encontrada', data);
        return;
      }

      console.log(`✅ Pagamento confirmado: Mesa ${sessaoAtiva.mesa.numero} - ${sessaoAtiva.cliente.nome}`);

      const itensConsumidos = [];
      let totalGeral = 0;
      sessaoAtiva.pedidos.forEach(p => {
        p.itens_pedido.forEach(item => {
          itensConsumidos.push(`${item.quantidade}x ${item.produto.nome}`);
          totalGeral += (item.preco_unitario * item.quantidade);
        });
      });

      // Atualiza total_gasto do cliente
      if (sessaoAtiva.cliente && totalGeral > 0) {
        await prisma.cliente.update({
          where: { id: sessaoAtiva.cliente.id },
          data: { total_gasto: { increment: totalGeral } }
        });
      }

      // Lançamento automático no caixa aberto
      if (totalGeral > 0) {
        const caixaAberto = await prisma.caixa.findFirst({ where: { bar_id: bar.id, status: 'aberto' } });
        if (caixaAberto) {
          await prisma.lancamentoCaixa.create({
            data: {
              caixa_id: caixaAberto.id,
              sessao_id: sessaoAtiva.id,
              tipo: 'venda',
              valor: totalGeral,
              descricao: `Mesa ${sessaoAtiva.mesa.numero} - ${sessaoAtiva.cliente.nome}`,
              metodo_pgto: data.metodo_pgto || null
            }
          });
        }
      }

      // Auditoria
      await logAction(bar.id, 'admin', 'FECHAMENTO_CONTA', {
        mesa: sessaoAtiva.mesa.numero,
        cliente: sessaoAtiva.cliente.nome,
        total: totalGeral,
        itens: itensConsumidos,
        sessao_id: sessaoAtiva.id
      });

      // Encerra esta sessão
      await prisma.sessao.update({
        where: { id: sessaoAtiva.id },
        data: { fechada_em: new Date() }
      });
      closingSessionIds.delete(sessaoAtiva.id);

      // Verifica se ainda há sessões ativas na mesa
      const restantes = await prisma.sessao.count({
        where: { mesa_id: sessaoAtiva.mesa_id, fechada_em: null }
      });

      if (restantes === 0) {
        await prisma.mesa.update({ where: { id: sessaoAtiva.mesa_id }, data: { status: 'livre' } });
      } else {
        // Mantém mesa ocupada ou fechando conforme as sessões restantes
        const sessoesRestantes = await prisma.sessao.findMany({
          where: { mesa_id: sessaoAtiva.mesa_id, fechada_em: null },
          select: { id: true }
        });
        const algumafechando = sessoesRestantes.some(s => closingSessionIds.has(s.id));
        await prisma.mesa.update({
          where: { id: sessaoAtiva.mesa_id },
          data: { status: algumafechando ? 'fechando' : 'ocupada' }
        });
      }

      // Notifica APENAS o cliente desta sessão
      io.to(`sessao_${sessaoAtiva.id}`).emit('account_closed', { mesa: sessaoAtiva.mesa.numero });

      // Atualiza todos os painéis
      io.emit('refresh_data');
    } catch (error) {
       console.error("Erro ao confirmar fechamento:", error);
    }
  });

  // Admin transferiu a mesa
  socket.on('transfer_table', async (data) => {
    try {
      console.log(`🔄 Transferindo Mesa ${data.origem} -> ${data.destino}`);
      const bar = await prisma.bar.findFirst();
      if (!bar) return;

      const mesaOrigem = await prisma.mesa.findFirst({ where: { bar_id: bar.id, numero: parseInt(data.origem) } });
      const mesaDestino = await prisma.mesa.findFirst({ where: { bar_id: bar.id, numero: parseInt(data.destino) } });

      if (mesaOrigem && mesaDestino) {
        // Encontra sessão ativa na origem
        const sessao = await prisma.sessao.findFirst({
          where: { mesa_id: mesaOrigem.id, fechada_em: null }
        });

        if (sessao) {
          // Move a sessão para a nova mesa
          await prisma.sessao.update({
            where: { id: sessao.id },
            data: { mesa_id: mesaDestino.id }
          });

          // Atualiza status das mesas
          await prisma.mesa.update({ where: { id: mesaOrigem.id }, data: { status: 'livre' } });
          await prisma.mesa.update({ where: { id: mesaDestino.id }, data: { status: 'ocupada' } });

          await logAction(bar.id, 'admin', 'TRANSFERENCIA_MESA', { de: data.origem, para: data.destino, sessao: sessao.id });
          io.emit('refresh_data');
          io.emit('table_transferred', { de: data.origem, para: data.destino });
        }
      }
    } catch (err) { console.error(err); }
  });

  // Admin adicionou item manualmente
  socket.on('add_manual_item', async (data) => {
    try {
      console.log(`➕ Item manual na Mesa ${data.mesa}: ${data.produtoNome}`);
      const bar = await prisma.bar.findFirst();
      if (!bar) return;

      const mesa = await prisma.mesa.findFirst({ where: { bar_id: bar.id, numero: parseInt(data.mesa) } });
      if (mesa) {
        const sessao = await prisma.sessao.findFirst({
          where: { mesa_id: mesa.id, fechada_em: null }
        });

        if (sessao) {
          // Cria um pedido "interno"
          const pedido = await prisma.pedido.create({
            data: {
              sessao_id: sessao.id,
              status: 'entregue', // Itens manuais do admin costumam ser entregues na hora
              origem: 'ADMIN'
            }
          });

          await prisma.itemPedido.create({
            data: {
              pedido_id: pedido.id,
              produto_id: data.produtoId,
              quantidade: data.qtd || 1,
              preco_unitario: data.preco
            }
          });

          await logAction(bar.id, 'admin', 'ITEM_MANUAL', { mesa: data.mesa, item: data.produtoNome, qtd: data.qtd });
          io.emit('refresh_data');
        }
      }
    } catch (err) { console.error(err); }
  });

  socket.on('disconnect', () => {
    console.log('❌ Device disconnected:', socket.id);
  });
});

// ==========================================
// GARÇONS — Auth + CRUD + Stats
// ==========================================

// ==================== ADMIN AUTH ====================

// Login admin (master password ou individual)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { senha, email } = req.body;
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    // Login individual por email+senha
    if (email && senha) {
      const admin = await prisma.adminUser.findFirst({ where: { email, bar_id: bar.id } });
      if (!admin || admin.senha_hash !== senha) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
      }
      return res.json({ ok: true, admin: { id: admin.id, nome: admin.nome, role: admin.role, email: admin.email, mode: 'individual' } });
    }

    // Login por senha master
    if (senha) {
      if (bar.require_admin_login) {
        return res.status(403).json({ error: 'Login individual obrigatório. Use email e senha.' });
      }
      if (senha !== bar.senha_master) {
        return res.status(401).json({ error: 'Senha incorreta' });
      }
      return res.json({ ok: true, admin: { nome: 'Gerente Master', role: 'owner', mode: 'master' } });
    }

    return res.status(400).json({ error: 'Senha obrigatória' });
  } catch (error) {
    console.error('Erro login admin:', error);
    res.status(500).json({ error: 'Erro no login' });
  }
});

// CRUD Admin Users
app.get('/api/admin/users', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.json([]);
    const admins = await prisma.adminUser.findMany({ where: { bar_id: bar.id }, orderBy: { criado_em: 'desc' } });
    res.json(admins.map(a => ({ id: a.id, nome: a.nome, email: a.email, role: a.role, criado_em: a.criado_em })));
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar admins' });
  }
});

app.post('/api/admin/users', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });
    const { nome, email, senha, role } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });
    const existe = await prisma.adminUser.findFirst({ where: { email } });
    if (existe) return res.status(400).json({ error: 'Email já cadastrado' });
    const admin = await prisma.adminUser.create({
      data: { bar_id: bar.id, nome, email, senha_hash: senha, role: role || 'staff' }
    });
    logAction(bar.id, 'admin', 'CRIAR_ADMIN', { nome, email, role });
    res.json({ id: admin.id, nome: admin.nome, email: admin.email, role: admin.role });
  } catch (error) {
    console.error('Erro criar admin:', error);
    res.status(500).json({ error: 'Erro ao criar admin' });
  }
});

app.put('/api/admin/users/:id', async (req, res) => {
  try {
    const { nome, email, senha, role } = req.body;
    const data = {};
    if (nome) data.nome = nome;
    if (email) data.email = email;
    if (senha) data.senha_hash = senha;
    if (role) data.role = role;
    const admin = await prisma.adminUser.update({ where: { id: req.params.id }, data });
    res.json({ id: admin.id, nome: admin.nome, email: admin.email, role: admin.role });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar admin' });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await prisma.adminUser.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover admin' });
  }
});

// Login do garçom via PIN
app.post('/api/garcom/login', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN obrigatório' });
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });
    const garcom = await prisma.garcom.findFirst({ where: { bar_id: bar.id, pin: String(pin), ativo: true } });
    if (!garcom) return res.status(401).json({ error: 'PIN inválido ou garçom inativo' });
    res.json({ id: garcom.id, nome: garcom.nome });
  } catch (err) {
    console.error('Erro no login do garçom:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Listar garçons
app.get('/api/admin/garcons', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    const garcons = await prisma.garcom.findMany({
      where: { bar_id: bar.id },
      orderBy: { criado_em: 'desc' }
    });
    res.json(garcons);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar garçons' });
  }
});

// Stats dos garçons (entregas por garçon)
app.get('/api/admin/garcons/stats', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    const garcons = await prisma.garcom.findMany({ where: { bar_id: bar.id }, orderBy: { criado_em: 'desc' } });
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const stats = await Promise.all(garcons.map(async (g) => {
      const totalEntregas = await prisma.pedido.count({ where: { garcom_id: g.id, status: 'entregue' } });
      const entregasHoje = await prisma.pedido.count({ where: { garcom_id: g.id, status: 'entregue', criado_em: { gte: hoje } } });
      return { ...g, totalEntregas, entregasHoje };
    }));
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar stats' });
  }
});

// Criar garçom
app.post('/api/admin/garcons', async (req, res) => {
  const { nome, pin } = req.body;
  if (!nome || !pin) return res.status(400).json({ error: 'Nome e PIN obrigatórios' });
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    const existe = await prisma.garcom.findFirst({ where: { bar_id: bar.id, pin: String(pin) } });
    if (existe) return res.status(400).json({ error: 'PIN já está em uso' });
    const garcom = await prisma.garcom.create({ data: { bar_id: bar.id, nome, pin: String(pin) } });
    res.json(garcom);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar garçom' });
  }
});

// Atualizar garçom
app.put('/api/admin/garcons/:id', async (req, res) => {
  const { nome, pin, ativo } = req.body;
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (pin) {
      const existe = await prisma.garcom.findFirst({ where: { bar_id: bar.id, pin: String(pin), id: { not: req.params.id } } });
      if (existe) return res.status(400).json({ error: 'PIN já está em uso' });
    }
    const data = {};
    if (nome !== undefined) data.nome = nome;
    if (pin !== undefined) data.pin = String(pin);
    if (ativo !== undefined) data.ativo = ativo;
    const garcom = await prisma.garcom.update({ where: { id: req.params.id }, data });
    res.json(garcom);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar garçom' });
  }
});

// Excluir garçom (soft delete)
app.delete('/api/admin/garcons/:id', async (req, res) => {
  try {
    await prisma.garcom.update({ where: { id: req.params.id }, data: { ativo: false } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover garçom' });
  }
});

// Busca Spotify Real
app.get('/api/musica/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  
  try {
    const results = await spotifyService.searchTracks(q);
    res.json(results);
  } catch (error) {
    console.error('Erro na busca do Spotify:', error);
    res.status(500).json({ error: 'Erro ao buscar músicas' });
  }
});

// ==========================================
// ROTAS REST - Integração Prisma
// ==========================================

// Retorna todas as categorias e seus respectivos produtos
app.get('/api/cardapio', async (req, res) => {
  try {
    const categorias = await prisma.produtoCategoria.findMany({
      include: {
        produtos: {
          include: { opcoes: true }
        }
      },
      orderBy: { ordem: 'asc' }
    });
    res.json(categorias);
  } catch (error) {
    console.error('Erro ao buscar o cardápio:', error);
    res.status(500).json({ error: 'Erro interno DB' });
  }
});

// Exportar cardápio completo (categorias + produtos + fotos em base64)
app.get('/api/admin/cardapio/exportar', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst();
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    const categorias = await prisma.produtoCategoria.findMany({
      where: { bar_id: bar.id },
      include: { produtos: { include: { opcoes: true } } },
      orderBy: { ordem: 'asc' }
    });

    const payload = categorias.map(cat => ({
      ...cat,
      produtos: cat.produtos.map(p => {
        let foto_base64 = null, foto_ext = null;
        if (p.foto_url) {
          const filename = p.foto_url.split('/uploads/')[1];
          if (filename) {
            const filepath = path.join(uploadDir, filename);
            if (fs.existsSync(filepath)) {
              foto_base64 = fs.readFileSync(filepath).toString('base64');
              foto_ext = path.extname(filename);
            }
          }
        }
        return { ...p, foto_base64, foto_ext };
      })
    }));

    const data = JSON.stringify({ versao: '1.0', exportado_em: new Date().toISOString(), categorias: payload });
    const filename = `cardapio-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (error) {
    console.error('Erro ao exportar cardápio:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Importar cardápio (modo: 'merge' ou 'replace')
app.post('/api/admin/cardapio/importar', async (req, res) => {
  try {
    const { modo, categorias } = req.body;
    if (!categorias || !Array.isArray(categorias)) {
      return res.status(400).json({ error: 'Arquivo inválido: campo "categorias" não encontrado' });
    }
    const bar = await prisma.bar.findFirst();
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    if (modo === 'replace') {
      const cats = await prisma.produtoCategoria.findMany({ where: { bar_id: bar.id } });
      for (const cat of cats) {
        await prisma.produto.deleteMany({ where: { categoria_id: cat.id } });
      }
      await prisma.produtoCategoria.deleteMany({ where: { bar_id: bar.id } });
    }

    const baseUrl = process.env.BASE_URL || 'https://aooba-api.onrender.com';

    for (const cat of categorias) {
      let categoria = await prisma.produtoCategoria.findFirst({
        where: { nome: cat.nome, bar_id: bar.id }
      });
      if (!categoria) {
        categoria = await prisma.produtoCategoria.create({
          data: { nome: cat.nome, ordem: cat.ordem ?? 99, bar_id: bar.id }
        });
      }

      for (const p of cat.produtos) {
        let foto_url = null;
        if (p.foto_base64 && p.foto_ext) {
          const newFilename = `produto-${Date.now()}-${Math.round(Math.random() * 1e9)}${p.foto_ext}`;
          const newPath = path.join(uploadDir, newFilename);
          fs.writeFileSync(newPath, Buffer.from(p.foto_base64, 'base64'));
          foto_url = `${baseUrl}/uploads/${newFilename}`;
        }

        await prisma.produto.create({
          data: {
            nome: p.nome,
            descricao: p.descricao ?? null,
            preco: p.preco,
            categoria_id: categoria.id,
            foto_url,
            destaque: p.destaque ?? false,
            status: p.status ?? 'ativo',
            limite_escolhas: p.limite_escolhas ?? 0,
            controlar_estoque: p.controlar_estoque ?? false,
            estoque_atual: p.estoque_atual ?? 0,
            estoque_minimo: p.estoque_minimo ?? 5,
            opcoes: {
              create: (p.opcoes ?? []).map(o => ({ nome: o.nome, acrescimo: o.acrescimo ?? 0 }))
            }
          }
        });
      }
    }

    await logAction(bar.id, null, 'IMPORTAR_CARDAPIO', { modo, total_categorias: categorias.length });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao importar cardápio:', error);
    res.status(500).json({ error: 'Erro interno: ' + error.message });
  }
});

// Retorna as mesas (Para View Garçom / Painel)
app.get('/api/mesas', async (req, res) => {
  try {
    const mesas = await prisma.mesa.findMany({
      orderBy: { numero: 'asc' }
    });
    res.json(mesas);
  } catch (error) {
    console.error('Erro ao buscar mesas:', error);
    res.status(500).json({ error: 'Erro interno DB' });
  }
});

// (Rota movida para o topo)

// ==========================================
// ROTAS ADMIN - DASHBOARD E MESAS
// ==========================================

// Retorna o Status das Mesas com sessões ativas e totais consumidos
app.get('/api/admin/mesas/status', async (req, res) => {
  try {
    const mesas = await prisma.mesa.findMany({
      include: {
        sessoes: {
          where: { fechada_em: null },
          include: {
            cliente: true,
            pedidos: {
              include: { 
                itens_pedido: {
                  include: { produto: true }
                } 
              }
            }
          }
        }
      },
      orderBy: { numero: 'asc' }
    });

    const mesaComStatus = mesas.map(m => {
      const sessaoAtiva = m.sessoes[0]; // primeira sessão (compatibilidade)
      let totalMesa = 0;
      let labelStatus = m.status.toUpperCase();
      let itensSessao = [];
      let resumoPedido = null;

      if (sessaoAtiva) {
        totalMesa = sessaoAtiva.pedidos.reduce((acc, p) => {
          return acc + p.itens_pedido.reduce((accItem, item) => {
            itensSessao.push({
               nome: item.produto.nome,
               qtd: item.quantidade,
               preco: item.preco_unitario
            });
            return accItem + (item.preco_unitario * item.quantidade);
          }, 0);
        }, 0);

        // Agregação de Status de Pedidos
        const statuses = sessaoAtiva.pedidos.map(p => p.status.toUpperCase());
        if (statuses.includes('PENDENTE')) {
          resumoPedido = 'PENDENTE';
        } else if (statuses.includes('PREPARANDO')) {
          resumoPedido = 'PREPARANDO';
        } else if (statuses.includes('PRONTO')) {
          resumoPedido = 'PRONTO';
        } else if (statuses.length > 0) {
          resumoPedido = 'ENTREGUE';
        }
      }

      // Sessões individuais com totais para fechamento por cliente
      const sessoes = m.sessoes.map(s => {
        const totalSessao = s.pedidos.reduce((acc, p) =>
          acc + p.itens_pedido.reduce((a, i) => a + i.preco_unitario * i.quantidade, 0), 0);
        return {
          sessao_id: s.id,
          cliente_nome: s.cliente.nome,
          total: totalSessao,
          solicitando_fechamento: closingSessionIds.has(s.id),
          aberta_em: s.criado_em
        };
      });

      return {
        id: m.id,
        numero: m.numero,
        apelido: m.nome_apelido,
        statusLabel: labelStatus,
        statusCorBase: labelStatus === "LIVRE" ? "bg-[#2A2A2A] border-[#333]" :
                       labelStatus === "FECHANDO" ? "bg-red-500/10 border-red-500/50 animate-pulse" :
                       "bg-[#1E1E1E] border-brand-orange/50 shadow-md",
        statusCorPonto: labelStatus === "LIVRE" ? "bg-green-500" :
                        labelStatus === "FECHANDO" ? "bg-red-500" :
                        "bg-brand-orange-bright",
        clienteNome: sessaoAtiva ? sessaoAtiva.cliente.nome : null,
        totalConsumo: totalMesa,
        itens: itensSessao,
        sessao_id: sessaoAtiva ? sessaoAtiva.id : null,
        ocupada_desde: sessaoAtiva ? sessaoAtiva.criado_em : null,
        statusPedido: resumoPedido || null,
        sessoes // array com todas as sessões ativas
      };
    });

    res.json(mesaComStatus);
  } catch (error) {
    console.error("Erro ao buscar mesas:", error);
    res.status(500).json({ error: "Erro interno DB" });
  }
});

// Retorna os KPIs do Dashboard
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);

    // 1. Faturamento Total (Pedidos desde a meia noite)
    const pedidosHoje = await prisma.pedido.findMany({
      where: { criado_em: { gte: inicioDoDia } },
      include: { itens_pedido: true }
    });

    const faturamento = pedidosHoje.reduce((acc, p) => {
      return acc + p.itens_pedido.reduce((accI, item) => accI + (item.preco_unitario * item.quantidade), 0);
    }, 0);

    // 2. Total Mesas Ativas
    const mesasAtivas = await prisma.sessao.count({
      where: { fechada_em: null }
    });

    // 3. Novos Clientes Hoje (Sessões iniciadas hoje)
    const clientesHoje = await prisma.sessao.findMany({
      where: { criado_em: { gte: inicioDoDia } },
      select: { cliente_id: true },
      distinct: ['cliente_id']
    });

    // 4. Vendas por Hora (Últimas 8 horas)
    const vendasPorHora = [];
    const agora = new Date();
    for (let i = 7; i >= 0; i--) {
      const horaInicio = new Date(agora);
      horaInicio.setHours(agora.getHours() - i, 0, 0, 0);
      const horaFim = new Date(agora);
      horaFim.setHours(agora.getHours() - i + 1, 0, 0, 0);

      const pedidosNaHora = pedidosHoje.filter(p => {
        const d = new Date(p.criado_em);
        return d >= horaInicio && d < horaFim;
      });

      const totalNaHora = pedidosNaHora.reduce((acc, p) => {
        return acc + p.itens_pedido.reduce((accI, item) => accI + (item.preco_unitario * item.quantidade), 0);
      }, 0);

      vendasPorHora.push({
        hora: `${horaInicio.getHours()}h`,
        valor: totalNaHora
      });
    }

    // 5. Top 5 Itens (Reais, por volume de vendas hoje)
    const contagemItens = {};
    pedidosHoje.forEach(p => {
      p.itens_pedido.forEach(it => {
        const nome = it.produto_id; // Idealmente buscar o nome, mas usaremos o que temos no include se possível
        contagemItens[it.nome_snapshot || it.produto_id] = (contagemItens[it.nome_snapshot || it.produto_id] || 0) + it.quantidade;
      });
    });

    const topItensSorted = Object.entries(contagemItens)
      .map(([nome, qtd]) => ({ nome, qtd }))
      .sort((a, b) => b.qtd - a.qtd)
      .slice(0, 5);

    res.json({
      faturamentoHoje: faturamento,
      totalPedidosHoje: pedidosHoje.length,
      mesasAtivas: mesasAtivas,
      totalClientesHoje: clientesHoje.length,
      vendasPorHora,
      topItens: topItensSorted
    });
  } catch (error) {
    console.error("Erro no Dashboard:", error);
    res.status(500).json({ error: "Erro interno DB" });
  }
});

// Retorna Pedidos Ativos (Não entregues)
app.get('/api/admin/pedidos/ativos', async (req, res) => {
  try {
    const pedidos = await prisma.pedido.findMany({
      where: {
        NOT: { status: 'entregue' }
      },
      include: {
        itens_pedido: { include: { produto: true } },
        sessao: { include: { mesa: true, cliente: true } }
      },
      orderBy: { criado_em: 'desc' }
    });

    const formatados = pedidos.map(p => ({
      id: p.id,
      sessao_id: p.sessao_id,
      table: p.sessao.mesa.numero,
      client: p.sessao.cliente.nome,
      status: p.status,
      time: new Date(p.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      items: p.itens_pedido.map(i => ({
        qtd: i.quantidade,
        name: i.produto.nome
      }))
    }));

    res.json(formatados);
  } catch (error) {
    console.error("Erro ao buscar pedidos ativos:", error);
    res.status(500).json({ error: "Erro interno DB" });
  }
});

// ==========================================
// ROTAS ADMIN - CRUD CARDÁPIO
// ==========================================

// Criar Produto (com ou sem foto)
app.post('/api/admin/produtos', upload.single('foto'), async (req, res) => {
  try {
    const { nome, descricao, preco, categoriaNome, destaque, opcoes, limite_escolhas } = req.body;
    
    let parsedOpcoes = [];
    if (opcoes) { try { parsedOpcoes = JSON.parse(opcoes); } catch(e){} }
    
    // 1. Busca bar (Mock do MVP = primeiro bar)
    const bar = await prisma.bar.findFirst();
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    // 2. Resolve categoria (Find or Create)
    let categoria_id = req.body.categoria_id;
    if (!categoria_id && categoriaNome) {
      let cat = await prisma.produtoCategoria.findFirst({ where: { nome: categoriaNome, bar_id: bar.id } });
      if (!cat) {
        cat = await prisma.produtoCategoria.create({ data: { nome: categoriaNome, ordem: 99, bar_id: bar.id } });
      }
      categoria_id = cat.id;
    }

    const produto = await prisma.produto.create({
      data: {
        nome,
        descricao: descricao || null,
        preco: parseFloat(preco),
        categoria_id,
        destaque: destaque === 'true',
        limite_escolhas: parseInt(limite_escolhas) || 0,
        controlar_estoque: req.body.controlar_estoque === 'true',
        estoque_atual: parseInt(req.body.estoque_atual) || 0,
        estoque_minimo: parseInt(req.body.estoque_minimo) || 5,
        foto_url: req.file ? `http://localhost:3334/uploads/${req.file.filename}` : null,
        status: 'ativo',
        opcoes: {
          create: parsedOpcoes.map(opt => ({ nome: opt.nome, acrescimo: parseFloat(opt.acrescimo) || 0 }))
        }
      }
    });

    logAction(bar.id, null, 'CRIAR_PRODUTO', { id: produto.id, nome: produto.nome, preco: produto.preco });
    res.json(produto);
  } catch (error) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Editar Produto
app.put('/api/admin/produtos/:id', upload.single('foto'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, preco, categoriaNome, destaque, status, opcoes, limite_escolhas } = req.body;
    
    let parsedOpcoes = null;
    if (opcoes) { try { parsedOpcoes = JSON.parse(opcoes); } catch(e){} }
    
    const bar = await prisma.bar.findFirst();

    // Resolve categoria (Find or Create)
    let categoria_id = undefined;
    if (categoriaNome && bar) {
      let cat = await prisma.produtoCategoria.findFirst({ where: { nome: categoriaNome, bar_id: bar.id } });
      if (!cat) {
        cat = await prisma.produtoCategoria.create({ data: { nome: categoriaNome, ordem: 99, bar_id: bar.id } });
      }
      categoria_id = cat.id;
    }

    const updateData = {};
    if (nome) updateData.nome = nome;
    if (descricao !== undefined) updateData.descricao = descricao;
    if (preco) updateData.preco = parseFloat(preco);
    if (categoria_id) updateData.categoria_id = categoria_id;
    if (destaque !== undefined) updateData.destaque = destaque === 'true';
    if (limite_escolhas !== undefined) updateData.limite_escolhas = parseInt(limite_escolhas) || 0;
    if (status) updateData.status = status;
    if (req.body.controlar_estoque !== undefined) updateData.controlar_estoque = req.body.controlar_estoque === 'true';
    if (req.body.estoque_atual !== undefined) updateData.estoque_atual = parseInt(req.body.estoque_atual) || 0;
    if (req.body.estoque_minimo !== undefined) updateData.estoque_minimo = parseInt(req.body.estoque_minimo) || 5;
    if (req.file) updateData.foto_url = `http://localhost:3334/uploads/${req.file.filename}`;

    if (parsedOpcoes !== null) {
      await prisma.produtoOpcao.deleteMany({ where: { produto_id: id } });
      updateData.opcoes = {
        create: parsedOpcoes.map(opt => ({ nome: opt.nome, acrescimo: parseFloat(opt.acrescimo) || 0 }))
      };
    }

    const produto = await prisma.produto.update({
      where: { id },
      data: updateData
    });

    logAction(bar.id, null, 'EDITAR_PRODUTO', { id, ...updateData });
    res.json(produto);
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Atualizar Status Rápido (Ativo/Esgotado)
app.patch('/api/admin/produtos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const produto = await prisma.produto.update({
      where: { id },
      data: { status }
    });
    res.json(produto);
  } catch (error) {
    console.error('Erro ao atualizar status do produto:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==========================================
// ROTAS ADMIN - CONFIGURAÇÕES GERAIS
// ==========================================

// Buscar configurações atuais
app.get('/api/admin/config', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst();
    if (!bar) return res.status(404).json({ error: 'Bar não encontrado' });
    
    res.json({
      limite_pedidos: bar.limite_pedidos,
      tempo_inatividade: bar.tempo_inatividade,
      senha_master: bar.senha_master,
      aberto: bar.aberto,
      chamar_garcom_ativo: bar.chamar_garcom_ativo,
      fidelidade_ativa: bar.fidelidade_ativa,
      nome: bar.nome,
      mensagem_boas_vindas: bar.mensagem_boas_vindas,
      require_admin_login: bar.require_admin_login,
    });
  } catch (error) {
    console.error('Erro ao buscar config:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Atualizar configurações
app.post('/api/admin/config', async (req, res) => {
  try {
    const { limite_pedidos, tempo_inatividade, senha_master, aberto, chamar_garcom_ativo, require_admin_login } = req.body;
    const bar = await prisma.bar.findFirst();
    if (!bar) return res.status(404).json({ error: 'Bar não encontrado' });

    const { nome, mensagem_boas_vindas } = req.body;
    const updated = await prisma.bar.update({
      where: { id: bar.id },
      data: {
        limite_pedidos: parseInt(limite_pedidos) || 5,
        tempo_inatividade: parseInt(tempo_inatividade) || 60,
        senha_master,
        aberto: (aberto === true || aberto === 'true'),
        chamar_garcom_ativo: (chamar_garcom_ativo === true || chamar_garcom_ativo === 'true'),
        ...(require_admin_login !== undefined && { require_admin_login: require_admin_login === true || require_admin_login === 'true' }),
        ...(nome !== undefined && { nome }),
        ...(mensagem_boas_vindas !== undefined && { mensagem_boas_vindas }),
      }
    });

    res.json({ success: true, config: updated });
  } catch (error) {
    console.error('Erro ao salvar config:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==========================================
// FIDELIDADE E RECOMPENSAS
// ==========================================

// Listar Recompensas Ativas
app.get('/api/fidelidade/recompensas', async (req, res) => {
  try {
    const rewards = await prisma.recompensa.findMany({ where: { status: 'ativo' } });
    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar recompensas' });
  }
});

// Solicitar Resgate de Pontos
app.post('/api/fidelidade/resgatar', async (req, res) => {
  try {
    const { cliente_id, recompensa_id, sessao_id } = req.body;
    
    const [cliente, recompensa] = await Promise.all([
      prisma.cliente.findUnique({ where: { id: cliente_id } }),
      prisma.recompensa.findUnique({ where: { id: recompensa_id } })
    ]);

    if (!cliente || !recompensa) return res.status(404).json({ error: 'Não encontrado' });
    if (cliente.pontos_fidelidade < recompensa.pontos_custo) {
      return res.status(400).json({ error: 'Saldo de pontos insuficiente' });
    }

    // Processa resgate
    const [resgate] = await prisma.$transaction([
      prisma.resgate.create({
        data: {
          cliente_id,
          recompensa_id,
          sessao_id,
          pontos_gastos: recompensa.pontos_custo,
          status: 'pendente'
        }
      }),
      prisma.cliente.update({
        where: { id: cliente_id },
        data: { pontos_fidelidade: { decrement: recompensa.pontos_custo } }
      })
    ]);

    // Notifica o Admin
    io.emit('resgate_solicitado', { 
      id: resgate.id, 
      cliente: cliente.nome, 
      premio: recompensa.nome,
      pontos: recompensa.pontos_custo
    });

    res.json({ success: true, resgate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro no resgate' });
  }
});

// ==========================================
// ADMIN - ESTATÍSTICAS REAIS (DASHBOARD)
// ==========================================

app.get('/api/admin/stats', async (req, res) => {
  try {
    const hojeStart = new Date(); hojeStart.setHours(0,0,0,0);
    const pedidosHoje = await prisma.pedido.findMany({
      where: { 
        status: 'entregue',
        criado_em: { gte: hojeStart }
      },
      include: { itens_pedido: true }
    });

    let faturamentoHoje = 0;
    const itemSales = {};

    pedidosHoje.forEach(p => {
      p.itens_pedido.forEach(it => {
        const subtotal = it.preco_unitario * it.quantidade;
        faturamentoHoje += subtotal;
        itemSales[it.produto_id] = (itemSales[it.produto_id] || 0) + it.quantidade;
      });
    });

    const mesasOcupadas = await prisma.mesa.count({ where: { status: 'ocupada' } });
    const sessoesHoje = await prisma.sessao.count({ where: { aberta_em: { gte: hojeStart } } });
    
    res.json({
      faturamentoHoje,
      mesasAtivas: mesasOcupadas,
      totalPedidos: pedidosHoje.length,
      appPercentage: sessoesHoje > 0 ? Math.min(100, (pedidosHoje.length / sessoesHoje) * 100).toFixed(0) : 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar stats' });
  }
});

// Endpoint duplicado de dashboard removido (usava dados mock)

// Endpoint de Auditoria Real (Log de Atividades)
app.get('/api/admin/audit', async (req, res) => {
  try {
    const pedidos = await prisma.pedido.findMany({
      take: 10,
      orderBy: { criado_em: 'desc' },
      include: { sessao: { include: { cliente: true, mesa: true } } }
    });

    const resgates = await prisma.resgate.findMany({
      take: 10,
      orderBy: { realizado_em: 'desc' },
      include: { sessao: { include: { cliente: true, mesa: true } }, recompensa: true }
    });

    const logs = [
      ...pedidos.map(p => ({
        user: p.sessao.cliente.nome,
        action: `Novo pedido #${p.id} (Mesa ${p.sessao.mesa.numero})`,
        time: p.criado_em,
        type: 'audit'
      })),
      ...resgates.map(r => ({
        user: r.sessao.cliente.nome,
        action: `Resgatou: ${r.recompensa.nome} (Mesa ${r.sessao.mesa.numero})`,
        time: r.realizado_em,
        type: 'loyalty'
      }))
    ].sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

    res.json(logs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao gerar audit' });
  }
});

// ==========================================
// ADMIN - GESTÃO MUSICAL
// ==========================================
app.get('/api/admin/musica/sugestoes', async (req, res) => {
  try {
    const sugestoes = await prisma.sugestaoMusica.findMany({
      where: { status: 'pendente' },
      orderBy: { criado_em: 'desc' }
    });
    res.json(sugestoes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar sugestões' });
  }
});

app.get('/api/musica/fila', async (req, res) => {
  try {
    const tocando = await prisma.sugestaoMusica.findFirst({
      where: { status: 'playing' },
      orderBy: { atualizado_em: 'desc' }
    });
    
    const proximas = await prisma.sugestaoMusica.findMany({
      where: { status: 'pendente' },
      orderBy: { criado_em: 'asc' },
      take: 5
    });
    
    res.json({ tocando, proximas });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar fila' });
  }
});

app.post('/api/admin/musica/status', async (req, res) => {
  try {
    const { id, status } = req.body; // status: playing, removed
    
    if (status === 'playing') {
      // Desativa a música que estava tocando anteriormente
      await prisma.sugestaoMusica.updateMany({
        where: { status: 'playing' },
        data: { status: 'played' }
      });
    }

    await prisma.sugestaoMusica.update({
      where: { id },
      data: { status }
    });

    // Notifica todos para atualizar a fila visual
    io.emit('music_queue_updated');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar música' });
  }
});

// Listar Pedidos Ativos (Para o SuperApp/Admin)
app.get('/api/admin/pedidos/ativos', async (req, res) => {
  try {
    const pedidos = await prisma.pedido.findMany({
      where: { NOT: { status: 'arquivado' } },
      include: { sessao: { include: { mesa: true, cliente: true } }, itens_pedido: { include: { produto: true } } },
      orderBy: { criado_em: 'desc' }
    });
    const formatados = pedidos.map(p => ({
      id: p.id,
      table: p.sessao.mesa.numero,
      client: p.sessao.cliente.nome,
      status: p.status,
      time: new Date(p.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      items: p.itens_pedido.map(i => ({ qtd: i.quantidade, name: i.produto.nome, preco_unitario: i.preco_unitario }))
    }));
    res.json(formatados);
  } catch (error) { res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

// Configurações do Bar
app.get('/api/admin/config', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst();
    res.json({ limite_pedidos: 3, tempo_inatividade: 60, senha_master: '1234', aberto: bar?.active || true, chamar_garcom_ativo: true });
  } catch (error) { res.status(500).json({ error: 'Erro ao buscar config' }); }
});

app.post('/api/admin/config', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst();
    await prisma.bar.update({ where: { id: bar.id }, data: { active: req.body.aberto } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Erro ao salvar config' }); }
});

// CRUD Produtos (Admin)
app.post('/api/admin/produtos', upload.single('foto'), async (req, res) => {
  try {
    const { nome, preco, categoria, descricao } = req.body;
    let cat = await prisma.produtoCategoria.findFirst({ where: { nome: categoria } });
    if (!cat) cat = await prisma.produtoCategoria.create({ data: { nome: categoria, bar_id: (await prisma.bar.findFirst()).id } });
    const novoProduto = await prisma.produto.create({
      data: { nome, preco: parseFloat(preco), categoria_id: cat.id, descricao, status: 'ativo', foto_url: req.file ? `/uploads/${req.file.filename}` : null }
    });
    res.json(novoProduto);
  } catch (error) { res.status(500).json({ error: 'Erro ao criar produto' }); }
});

app.put('/api/admin/produtos/:id', upload.single('foto'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, preco, categoria, descricao } = req.body;
    const updateData = { nome, preco: parseFloat(preco), descricao };
    if (req.file) updateData.foto_url = `/uploads/${req.file.filename}`;
    const atualizado = await prisma.produto.update({ where: { id }, data: updateData });
    res.json(atualizado);
  } catch (error) { res.status(500).json({ error: 'Erro ao atualizar produto' }); }
});

app.patch('/api/admin/produtos/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await prisma.produto.update({ where: { id }, data: { status } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Erro ao atualizar status' }); }
});

// Deletar Produto
app.delete('/api/admin/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.produto.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao deletar produto:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==========================================
// ADMIN - MURAL INSTAGRAM
// ==========================================

app.get('/api/admin/instagram/feed', async (req, res) => {
  const { hashtag, token, accountId, limit = 12 } = req.query;
  if (!token || !accountId) {
    return res.status(400).json({ error: 'Token e Account ID são obrigatórios' });
  }
  try {
    const tag = String(hashtag).replace('#', '');
    const hashtagRes = await fetch(
      `https://graph.instagram.com/ig_hashtag_search?user_id=${accountId}&query=${encodeURIComponent(tag)}&access_token=${token}`
    );
    const hashtagData = await hashtagRes.json();
    if (!hashtagData.data?.length) {
      return res.status(404).json({ error: `Hashtag #${tag} não encontrada` });
    }
    const hashtagId = hashtagData.data[0].id;

    const mediaRes = await fetch(
      `https://graph.instagram.com/${hashtagId}/recent_media?fields=id,media_type,media_url,like_count,username&limit=${limit}&access_token=${token}`
    );
    const mediaData = await mediaRes.json();
    const photos = (mediaData.data || [])
      .filter(p => p.media_type === 'IMAGE' && p.media_url)
      .map(p => ({ id: p.id, media_url: p.media_url, like_count: p.like_count || 0, username: p.username || '' }));

    res.json({ photos });
  } catch (err) {
    console.error('Erro Instagram feed:', err);
    res.status(500).json({ error: 'Erro ao buscar fotos do Instagram' });
  }
});

const PORT = process.env.PORT || 3334;
// ==========================================
// ADMIN - GESTÃO DE RECOMPENSAS (FIDELIDADE)
// ==========================================

app.get('/api/admin/recompensas', async (req, res) => {
  try {
    const recompensas = await prisma.recompensa.findMany({ orderBy: { pontos_custo: 'asc' } });
    res.json(recompensas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar recompensas' });
  }
});

app.post('/api/admin/recompensas', async (req, res) => {
  try {
    const { nome, descricao, pontos_custo, ativa } = req.body;
    const nova = await prisma.recompensa.create({
      data: { nome, descricao, pontos_custo: parseInt(pontos_custo), ativa: ativa !== false }
    });
    res.json(nova);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar recompensa' });
  }
});

app.put('/api/admin/recompensas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao, pontos_custo, ativa } = req.body;
    const atualizada = await prisma.recompensa.update({
      where: { id },
      data: { nome, descricao, pontos_custo: parseInt(pontos_custo), ativa: ativa !== false }
    });
    res.json(atualizada);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar recompensa' });
  }
});

app.delete('/api/admin/recompensas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.recompensa.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar recompensa' });
  }
});
// ==========================================
// ADMIN - GESTÃO DE RESGATES E CONFIG FIDELIDADE
// ==========================================

// Listar Resgates Pendentes
app.get('/api/admin/resgates/pendentes', async (req, res) => {
  try {
    const pendentes = await prisma.resgate.findMany({
      where: { status: 'pendente' },
      include: { 
        cliente: true, 
        recompensa: true,
        sessao: { include: { mesa: true } }
      },
      orderBy: { criado_em: 'asc' }
    });
    res.json(pendentes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar resgates' });
  }
});

// Confirmar Entrega de Resgate
app.post('/api/admin/resgates/:id/entregar', async (req, res) => {
  try {
    const { id } = req.params;
    const resgate = await prisma.resgate.update({
      where: { id },
      data: { status: 'entregue' },
      include: { recompensa: true, cliente: true }
    });
    
    // Notifica o cliente que o prêmio foi entregue (opcional)
    io.emit('resgate_entregue', { id, cliente_id: resgate.cliente_id });
    io.emit('refresh_data'); // Atualiza o Dashboard do Admin
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao entregar resgate' });
  }
});

// Buscar Configuração de Fidelidade
app.get('/api/admin/fidelidade/config', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst();
    let config = await prisma.configFidelidade.findUnique({ where: { bar_id: bar.id } });
    
    if (!config) {
       config = await prisma.configFidelidade.create({
         data: { bar_id: bar.id, pts_por_real: 1.0, pts_cadastro: 50 }
       });
    }

    res.json({ 
      ...config, 
      fidelidade_ativa: bar.fidelidade_ativa 
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar config' });
  }
});

// Salvar Configuração de Fidelidade
app.post('/api/admin/fidelidade/config', async (req, res) => {
  try {
    const { pts_por_real, pts_cadastro, fidelidade_ativa, pts_musica_tocada, threshold_habitue, threshold_vip } = req.body;
    const bar = await prisma.bar.findFirst();

    await prisma.$transaction([
      prisma.bar.update({
        where: { id: bar.id },
        data: { fidelidade_ativa }
      }),
      prisma.configFidelidade.update({
        where: { bar_id: bar.id },
        data: {
          pts_por_real: parseFloat(pts_por_real),
          pts_cadastro: parseInt(pts_cadastro),
          ...(pts_musica_tocada !== undefined && { pts_musica_tocada: parseInt(pts_musica_tocada) || 10 }),
          ...(threshold_habitue !== undefined && { threshold_habitue: parseInt(threshold_habitue) || 500 }),
          ...(threshold_vip !== undefined && { threshold_vip: parseInt(threshold_vip) || 1500 }),
        }
      })
    ]);

    logAction(bar.id, null, 'ATUALIZAR_FIDELIDADE', req.body);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// Gestão de Promoções (SuperApp)
app.get('/api/admin/promocao', (req, res) => {
  res.json(currentPromo);
});

app.post('/api/admin/promocao', (req, res) => {
  currentPromo = { ...currentPromo, ...req.body };
  io.emit('promo_sync', currentPromo);
  console.log('📢 Promoção Atualizada:', currentPromo.title);
  res.json({ success: true, promo: currentPromo });
});

// Listar Logs de Auditoria
// ==================== RELATÓRIOS & AUDIT ====================

// Helper: calcular range de datas por período
function getDateRange(periodo, de, ate) {
  const now = new Date();
  let start, end = new Date();
  if (periodo === 'custom' && de) {
    start = new Date(de);
    end = ate ? new Date(ate) : new Date();
    end.setHours(23, 59, 59, 999);
  } else if (periodo === 'mes') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (periodo === 'semana') {
    start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);
  } else { // hoje
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

// Audit logs com filtros
app.get('/api/admin/audit-logs', async (req, res) => {
  try {
    const { periodo, tipo, busca } = req.query;
    const where = {};

    if (periodo && periodo !== 'todos') {
      const { start, end } = getDateRange(periodo, req.query.de, req.query.ate);
      where.criado_em = { gte: start, lte: end };
    }
    if (tipo) where.acao = tipo;

    let logs = await prisma.auditLog.findMany({
      where,
      orderBy: { criado_em: 'desc' },
      take: 200
    });

    if (busca) {
      const q = busca.toLowerCase();
      logs = logs.filter(l =>
        l.acao.toLowerCase().includes(q) ||
        (l.detalhes_json && l.detalhes_json.toLowerCase().includes(q))
      );
    }

    res.json(logs);
  } catch (error) {
    console.error('Erro audit-logs:', error);
    res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});

// Relatório resumo com métricas por período
app.get('/api/admin/relatorio/resumo', async (req, res) => {
  try {
    const { periodo, de, ate } = req.query;
    const { start, end } = getDateRange(periodo || 'hoje', de, ate);
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.json({});

    // Pedidos entregues no período
    const pedidos = await prisma.pedido.findMany({
      where: {
        status: 'entregue',
        criado_em: { gte: start, lte: end }
      },
      include: { itens_pedido: { include: { produto: true } } }
    });

    // Sessões no período
    const sessoes = await prisma.sessao.findMany({
      where: { criado_em: { gte: start, lte: end } }
    });

    // Lançamentos de caixa no período
    const lancamentos = await prisma.lancamentoCaixa.findMany({
      where: { criado_em: { gte: start, lte: end }, tipo: 'venda' }
    });

    // Calcular métricas
    let faturamento_bruto = 0;
    const categoriaMap = {};
    const itemMap = {};
    const horaMap = {};

    pedidos.forEach(p => {
      p.itens_pedido.forEach(ip => {
        const val = ip.preco_unitario * ip.quantidade;
        faturamento_bruto += val;

        const cat = ip.produto?.categoria || 'Outros';
        categoriaMap[cat] = (categoriaMap[cat] || { total: 0, qtd: 0 });
        categoriaMap[cat].total += val;
        categoriaMap[cat].qtd += ip.quantidade;

        const nome = ip.produto?.nome || 'Desconhecido';
        itemMap[nome] = itemMap[nome] || { qtd: 0, faturamento: 0 };
        itemMap[nome].qtd += ip.quantidade;
        itemMap[nome].faturamento += val;
      });

      const hora = new Date(p.criado_em).getHours();
      const label = `${hora}h`;
      horaMap[label] = (horaMap[label] || 0) + p.itens_pedido.reduce((a, ip) => a + ip.preco_unitario * ip.quantidade, 0);
    });

    // Métodos de pagamento dos lançamentos
    const metodoMap = {};
    lancamentos.forEach(l => {
      const m = l.metodo_pgto || 'Não informado';
      metodoMap[m] = (metodoMap[m] || 0) + l.valor;
    });

    const mesas_ids = new Set(sessoes.map(s => s.mesa_id));
    const clientes_ids = new Set(sessoes.map(s => s.cliente_id));
    const total_pedidos = pedidos.length;
    const ticket_medio = total_pedidos > 0 ? faturamento_bruto / total_pedidos : 0;

    // Comparativo com período anterior (mesma duração)
    const diff = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - diff);
    const prevEnd = new Date(start);
    const pedidosPrev = await prisma.pedido.findMany({
      where: { status: 'entregue', criado_em: { gte: prevStart, lte: prevEnd } },
      include: { itens_pedido: true }
    });
    let faturamento_anterior = 0;
    pedidosPrev.forEach(p => p.itens_pedido.forEach(ip => { faturamento_anterior += ip.preco_unitario * ip.quantidade; }));
    const variacao_pct = faturamento_anterior > 0 ? ((faturamento_bruto - faturamento_anterior) / faturamento_anterior * 100) : 0;

    res.json({
      faturamento_bruto,
      ticket_medio,
      total_pedidos,
      total_clientes: clientes_ids.size,
      mesas_atendidas: mesas_ids.size,
      vendas_por_categoria: Object.entries(categoriaMap).map(([cat, d]) => ({ categoria: cat, total: d.total, qtd: d.qtd })).sort((a, b) => b.total - a.total),
      vendas_por_hora: Object.entries(horaMap).map(([hora, valor]) => ({ hora, valor })).sort((a, b) => parseInt(a.hora) - parseInt(b.hora)),
      top_itens: Object.entries(itemMap).map(([nome, d]) => ({ nome, qtd: d.qtd, faturamento: d.faturamento })).sort((a, b) => b.qtd - a.qtd).slice(0, 10),
      metodos_pagamento: Object.entries(metodoMap).map(([metodo, total]) => ({ metodo, total })),
      comparativo: { periodo_anterior: faturamento_anterior, variacao_pct: Math.round(variacao_pct * 10) / 10 }
    });
  } catch (error) {
    console.error('Erro relatório:', error);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// Exportação CSV
app.get('/api/admin/relatorio/export/csv', async (req, res) => {
  try {
    const { periodo, de, ate, tipo } = req.query;
    const { start, end } = getDateRange(periodo || 'hoje', de, ate);

    let csv = '';
    if (tipo === 'audit') {
      const logs = await prisma.auditLog.findMany({
        where: { criado_em: { gte: start, lte: end } },
        orderBy: { criado_em: 'desc' }
      });
      csv = 'Data,Hora,Acao,Admin,Detalhes\n';
      logs.forEach(l => {
        const d = new Date(l.criado_em);
        csv += `${d.toLocaleDateString('pt-BR')},${d.toLocaleTimeString('pt-BR')},${l.acao},${l.admin_id},"${(l.detalhes_json || '').replace(/"/g, '""')}"\n`;
      });
    } else if (tipo === 'itens') {
      const pedidos = await prisma.pedido.findMany({
        where: { status: 'entregue', criado_em: { gte: start, lte: end } },
        include: { itens_pedido: { include: { produto: true } } }
      });
      const itemMap = {};
      pedidos.forEach(p => p.itens_pedido.forEach(ip => {
        const nome = ip.produto?.nome || 'Desconhecido';
        itemMap[nome] = itemMap[nome] || { qtd: 0, fat: 0, cat: ip.produto?.categoria || '' };
        itemMap[nome].qtd += ip.quantidade;
        itemMap[nome].fat += ip.preco_unitario * ip.quantidade;
      }));
      csv = 'Produto,Categoria,Quantidade,Faturamento\n';
      Object.entries(itemMap).sort((a, b) => b[1].qtd - a[1].qtd).forEach(([nome, d]) => {
        csv += `"${nome}","${d.cat}",${d.qtd},${d.fat.toFixed(2)}\n`;
      });
    } else { // vendas
      const sessoes = await prisma.sessao.findMany({
        where: { criado_em: { gte: start, lte: end }, fechada_em: { not: null } },
        include: { mesa: true, cliente: true, pedidos: { include: { itens_pedido: true } } }
      });
      csv = 'Data,Mesa,Cliente,Total,Itens\n';
      sessoes.forEach(s => {
        const total = s.pedidos.reduce((a, p) => a + p.itens_pedido.reduce((b, ip) => b + ip.preco_unitario * ip.quantidade, 0), 0);
        const qtdItens = s.pedidos.reduce((a, p) => a + p.itens_pedido.length, 0);
        csv += `${new Date(s.criado_em).toLocaleDateString('pt-BR')},${s.mesa?.numero || '?'},"${s.cliente?.nome || '?'}",${total.toFixed(2)},${qtdItens}\n`;
      });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_${tipo || 'vendas'}_${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Erro export CSV:', error);
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});

// ==================== F1: FECHAMENTO DE CAIXA ====================

// Caixa atual (aberto)
app.get('/api/admin/caixa/atual', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.json(null);
    const caixa = await prisma.caixa.findFirst({
      where: { bar_id: bar.id, status: 'aberto' },
      include: { lancamentos: { orderBy: { criado_em: 'desc' } } }
    });
    res.json(caixa);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar caixa' });
  }
});

// Abrir caixa
app.post('/api/admin/caixa/abrir', async (req, res) => {
  try {
    const { saldo_inicial, aberto_por } = req.body;
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    // Verificar se já existe caixa aberto
    const caixaAberto = await prisma.caixa.findFirst({ where: { bar_id: bar.id, status: 'aberto' } });
    if (caixaAberto) return res.status(400).json({ error: 'Já existe um caixa aberto' });

    const caixa = await prisma.caixa.create({
      data: {
        bar_id: bar.id,
        aberto_por: aberto_por || 'Admin',
        saldo_inicial: parseFloat(saldo_inicial) || 0
      }
    });
    logAction(bar.id, 'admin', 'ABRIR_CAIXA', { caixa_id: caixa.id, saldo_inicial });
    res.json(caixa);
  } catch (error) {
    console.error('Erro ao abrir caixa:', error);
    res.status(500).json({ error: 'Erro ao abrir caixa' });
  }
});

// Fechar caixa — consolida totais
app.post('/api/admin/caixa/fechar', async (req, res) => {
  try {
    const { caixa_id, fechado_por, observacao, metodo_pgto_map } = req.body;
    const caixa = await prisma.caixa.findUnique({
      where: { id: caixa_id },
      include: { lancamentos: true }
    });
    if (!caixa || caixa.status !== 'aberto') return res.status(400).json({ error: 'Caixa não encontrado ou já fechado' });

    // Consolida valores dos lançamentos
    let total_vendas = 0, total_descontos = 0, total_couvert = 0, total_cancelamentos = 0;
    let mesas_set = new Set();

    caixa.lancamentos.forEach(l => {
      if (l.tipo === 'venda') total_vendas += l.valor;
      else if (l.tipo === 'sangria' || l.tipo === 'despesa') total_cancelamentos += Math.abs(l.valor);
      else if (l.tipo === 'reforco') total_vendas += l.valor;
      if (l.sessao_id) mesas_set.add(l.sessao_id);
    });

    const total_liquido = total_vendas - total_descontos - total_cancelamentos + total_couvert;
    const mesas_atendidas = mesas_set.size;
    const ticket_medio = mesas_atendidas > 0 ? total_vendas / mesas_atendidas : 0;

    const caixaFechado = await prisma.caixa.update({
      where: { id: caixa_id },
      data: {
        status: 'fechado',
        fechado_em: new Date(),
        fechado_por: fechado_por || 'Admin',
        total_vendas,
        total_descontos,
        total_couvert,
        total_cancelamentos,
        total_liquido,
        mesas_atendidas,
        ticket_medio,
        observacao: observacao || null
      },
      include: { lancamentos: true }
    });

    const bar = await prisma.bar.findFirst();
    if (bar) logAction(bar.id, 'admin', 'FECHAR_CAIXA', { caixa_id, total_vendas, total_liquido, mesas_atendidas });
    res.json(caixaFechado);
  } catch (error) {
    console.error('Erro ao fechar caixa:', error);
    res.status(500).json({ error: 'Erro ao fechar caixa' });
  }
});

// Lançamento manual no caixa (sangria, reforço, despesa)
app.post('/api/admin/caixa/lancamento', async (req, res) => {
  try {
    const { caixa_id, tipo, valor, descricao, metodo_pgto } = req.body;
    const caixa = await prisma.caixa.findUnique({ where: { id: caixa_id } });
    if (!caixa || caixa.status !== 'aberto') return res.status(400).json({ error: 'Caixa não aberto' });

    const lancamento = await prisma.lancamentoCaixa.create({
      data: {
        caixa_id,
        tipo,
        valor: parseFloat(valor),
        descricao: descricao || null,
        metodo_pgto: metodo_pgto || null
      }
    });
    res.json(lancamento);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar lançamento' });
  }
});

// Histórico de caixas fechados
app.get('/api/admin/caixa/historico', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.json([]);
    const caixas = await prisma.caixa.findMany({
      where: { bar_id: bar.id, status: 'fechado' },
      orderBy: { fechado_em: 'desc' },
      take: 30
    });
    res.json(caixas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Editar lançamento
app.put('/api/admin/caixa/lancamento/:id', async (req, res) => {
  try {
    const { tipo, valor, descricao, metodo_pgto } = req.body;
    const data = {};
    if (tipo !== undefined) data.tipo = tipo;
    if (valor !== undefined) data.valor = parseFloat(valor);
    if (descricao !== undefined) data.descricao = descricao;
    if (metodo_pgto !== undefined) data.metodo_pgto = metodo_pgto || null;
    const l = await prisma.lancamentoCaixa.update({ where: { id: req.params.id }, data });
    res.json(l);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletar lançamento
app.delete('/api/admin/caixa/lancamento/:id', async (req, res) => {
  try {
    await prisma.lancamentoCaixa.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhes de um caixa específico (para relatório/impressão)
app.get('/api/admin/caixa/:id', async (req, res) => {
  try {
    const caixa = await prisma.caixa.findUnique({
      where: { id: req.params.id },
      include: { lancamentos: { orderBy: { criado_em: 'asc' } } }
    });
    if (!caixa) return res.status(404).json({ error: 'Caixa não encontrado' });
    res.json(caixa);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar caixa' });
  }
});

// ==================== F2: NOTA FISCAL / CUPOM ====================

// Emitir cupom de uma sessão
app.post('/api/admin/notas/emitir/:sessaoId', async (req, res) => {
  try {
    const sessao = await prisma.sessao.findUnique({
      where: { id: req.params.sessaoId },
      include: {
        mesa: true,
        cliente: true,
        pedidos: { include: { itens_pedido: { include: { produto: true } } } }
      }
    });
    if (!sessao) return res.status(404).json({ error: 'Sessão não encontrada' });

    // Montar itens
    const itens = [];
    let subtotal = 0;
    sessao.pedidos.forEach(p => {
      p.itens_pedido.forEach(item => {
        const valor = item.preco_unitario * item.quantidade;
        itens.push({
          nome: item.produto.nome,
          quantidade: item.quantidade,
          preco_unitario: item.preco_unitario,
          valor_total: valor,
          opcoes: item.opcoes_escolhidas || ''
        });
        subtotal += valor;
      });
    });

    // Contar notas existentes para gerar número
    const count = await prisma.notaFiscal.count();

    const nota = await prisma.notaFiscal.create({
      data: {
        sessao_id: sessao.id,
        numero: count + 1,
        valor_total: subtotal,
        desconto: parseFloat(req.body.desconto) || 0,
        couvert: parseFloat(req.body.couvert) || 0,
        metodo_pgto: req.body.metodo_pgto || null,
        itens_json: JSON.stringify(itens)
      }
    });

    // Buscar dados do bar para o cupom
    const bar = await prisma.bar.findFirst({ where: { active: true } });

    res.json({
      ...nota,
      sessao,
      bar: bar ? { nome: bar.nome, cnpj: bar.cnpj, endereco: bar.endereco, razao_social: bar.razao_social } : null,
      itens
    });
  } catch (error) {
    console.error('Erro ao emitir nota:', error);
    res.status(500).json({ error: 'Erro ao emitir nota fiscal' });
  }
});

// Buscar nota fiscal por ID
app.get('/api/admin/notas/:id', async (req, res) => {
  try {
    const nota = await prisma.notaFiscal.findUnique({
      where: { id: req.params.id },
      include: { sessao: { include: { mesa: true, cliente: true } } }
    });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    res.json({
      ...nota,
      itens: JSON.parse(nota.itens_json),
      bar: bar ? { nome: bar.nome, cnpj: bar.cnpj, endereco: bar.endereco, razao_social: bar.razao_social } : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar nota' });
  }
});

// Histórico de notas
app.get('/api/admin/notas/historico', async (req, res) => {
  try {
    const notas = await prisma.notaFiscal.findMany({
      include: { sessao: { include: { mesa: true, cliente: true } } },
      orderBy: { emitida_em: 'desc' },
      take: 50
    });
    res.json(notas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar histórico de notas' });
  }
});

// ==================== F6: CRM ====================

// Lista de clientes com filtros
app.get('/api/admin/clientes', async (req, res) => {
  try {
    const { mes, tier, ordem } = req.query;
    const where = {};
    if (mes) {
      where.aniversario_mes = parseInt(mes);
    }

    let clientes = await prisma.cliente.findMany({
      where,
      include: { pontos: true },
      orderBy: { criado_em: 'desc' }
    });

    // Filtrar por tier se especificado
    if (tier) {
      clientes = clientes.filter(c => c.pontos?.tier === tier);
    }

    // Ordenar
    if (ordem === 'gasto') clientes.sort((a, b) => (b.total_gasto || 0) - (a.total_gasto || 0));
    if (ordem === 'visitas') clientes.sort((a, b) => (b.total_visitas || 0) - (a.total_visitas || 0));

    res.json(clientes.map(c => ({
      id: c.id,
      nome: c.nome,
      cpf_ou_telefone: c.cpf_ou_telefone,
      aniversario_dia: c.aniversario_dia,
      aniversario_mes: c.aniversario_mes,
      total_visitas: c.total_visitas || 0,
      total_gasto: c.total_gasto || 0,
      tier: c.pontos?.tier || 'Frequentador',
      pontos: c.pontos?.pontos_total || c.pontos_fidelidade || 0,
      ultimo_acesso: c.ultimo_acesso,
      criado_em: c.criado_em,
      aceite_marketing: c.aceite_marketing
    })));
  } catch (error) {
    console.error('Erro ao listar clientes:', error);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Aniversariantes do mês
app.get('/api/admin/clientes/aniversariantes', async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
    const clientes = await prisma.cliente.findMany({
      where: { aniversario_mes: mes },
      include: { pontos: true }
    });
    res.json(clientes.map(c => ({
      id: c.id, nome: c.nome, cpf_ou_telefone: c.cpf_ou_telefone,
      aniversario_dia: c.aniversario_dia, aniversario_mes: c.aniversario_mes,
      total_gasto: c.total_gasto || 0, tier: c.pontos?.tier || 'Frequentador'
    })));
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar aniversariantes' });
  }
});

// Exportar clientes CSV
app.get('/api/admin/clientes/exportar', async (req, res) => {
  try {
    const clientes = await prisma.cliente.findMany({
      where: { aceite_marketing: true },
      include: { pontos: true }
    });
    let csv = 'Nome,Telefone,Aniversario,Visitas,Gasto Total,Tier,Pontos\n';
    clientes.forEach(c => {
      const aniv = c.aniversario_dia && c.aniversario_mes ? `${c.aniversario_dia}/${c.aniversario_mes}` : '';
      csv += `"${c.nome}","${c.cpf_ou_telefone}","${aniv}",${c.total_visitas || 0},${(c.total_gasto || 0).toFixed(2)},${c.pontos?.tier || 'Frequentador'},${c.pontos?.pontos_total || 0}\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=clientes_aooba.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});

// Editar cliente
app.put('/api/admin/clientes/:id', async (req, res) => {
  try {
    const { nome, cpf_ou_telefone, aniversario_dia, aniversario_mes, aceite_marketing } = req.body;
    const updated = await prisma.cliente.update({
      where: { id: req.params.id },
      data: {
        nome,
        cpf_ou_telefone,
        aniversario_dia: aniversario_dia ? parseInt(aniversario_dia) : null,
        aniversario_mes: aniversario_mes ? parseInt(aniversario_mes) : null,
        aceite_marketing: aceite_marketing === true || aceite_marketing === 'true'
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao editar cliente' });
  }
});

// Excluir cliente
app.delete('/api/admin/clientes/:id', verifyToken, async (req, res) => {
  try {
    // Remove dependências antes de excluir o cliente
    const clienteId = req.params.id;
    await prisma.transacaoPontos.deleteMany({ where: { cliente_id: clienteId } });
    await prisma.clientePontos.deleteMany({ where: { cliente_id: clienteId } });
    await prisma.resgate.deleteMany({ where: { cliente_id: clienteId } });
    // Sessões abertas: fecha primeiro
    await prisma.sessao.updateMany({ where: { cliente_id: clienteId, fechada_em: null }, data: { fechada_em: new Date() } });
    await prisma.cliente.delete({ where: { id: clienteId } });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
});

// Config aniversário
app.get('/api/admin/config/aniversario', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.json(null);
    let config = await prisma.configAniversario.findUnique({ where: { bar_id: bar.id } });
    if (!config) {
      config = await prisma.configAniversario.create({ data: { bar_id: bar.id } });
    }
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar config' });
  }
});

app.put('/api/admin/config/aniversario', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não encontrado' });
    const { ativo, desconto_pct, mensagem } = req.body;
    const config = await prisma.configAniversario.upsert({
      where: { bar_id: bar.id },
      create: { bar_id: bar.id, ativo, desconto_pct: parseFloat(desconto_pct) || 10, mensagem: mensagem || '' },
      update: { ativo, desconto_pct: parseFloat(desconto_pct) || 10, mensagem: mensagem || '' }
    });
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// CRUD Campanhas
app.get('/api/admin/campanhas', async (req, res) => {
  try {
    const campanhas = await prisma.campanhaCRM.findMany({ orderBy: { criado_em: 'desc' } });
    res.json(campanhas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar campanhas' });
  }
});

app.post('/api/admin/campanhas', async (req, res) => {
  try {
    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não encontrado' });
    const { nome, tipo, mensagem, desconto_pct } = req.body;
    const campanha = await prisma.campanhaCRM.create({
      data: { bar_id: bar.id, nome, tipo, mensagem, desconto_pct: desconto_pct ? parseFloat(desconto_pct) : null }
    });
    res.json(campanha);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar campanha' });
  }
});

// ==================== F7: IMPORTAÇÃO NF-e ====================

// Upload e parse XML de NF-e
app.post('/api/admin/nfe/importar', upload.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo XML não enviado' });
    const xmlContent = fs.readFileSync(req.file.path, 'utf-8');
    const result = await xml2js.parseStringPromise(xmlContent, { explicitArray: false });

    // Navegar na estrutura do XML da NF-e
    const nfe = result.nfeProc?.NFe || result.NFe;
    if (!nfe) return res.status(400).json({ error: 'XML não é uma NF-e válida' });

    const infNFe = nfe.infNFe;
    const ide = infNFe?.ide || {};
    const emit = infNFe?.emit || {};
    const det = infNFe?.det;

    // det pode ser array ou objeto (se 1 item)
    const itensNF = Array.isArray(det) ? det : det ? [det] : [];

    const bar = await prisma.bar.findFirst({ where: { active: true } });
    if (!bar) return res.status(400).json({ error: 'Bar não configurado' });

    // Criar registro de importação
    const importacao = await prisma.importacaoNFe.create({
      data: {
        bar_id: bar.id,
        chave_nfe: infNFe?.$?.Id?.replace('NFe', '') || null,
        fornecedor: emit.xNome || emit.xFant || 'Desconhecido',
        numero_nf: ide.nNF || null,
        valor_total: parseFloat(infNFe?.total?.ICMSTot?.vNF) || 0,
        data_emissao: ide.dhEmi ? new Date(ide.dhEmi) : null,
        itens_total: itensNF.length
      }
    });

    // Criar itens
    const itensCriados = [];
    for (const item of itensNF) {
      const prod = item.prod || {};
      // Tentar vincular automaticamente por EAN
      let produto_id = null;
      if (prod.cEAN && prod.cEAN !== 'SEM GTIN') {
        const match = await prisma.produto.findFirst({ where: { codigo_ean: prod.cEAN } });
        if (match) produto_id = match.id;
      }

      const itemCriado = await prisma.itemImportacaoNFe.create({
        data: {
          importacao_id: importacao.id,
          codigo_ean: (prod.cEAN && prod.cEAN !== 'SEM GTIN') ? prod.cEAN : null,
          descricao: prod.xProd || 'Sem descrição',
          quantidade: parseFloat(prod.qCom) || 0,
          valor_unitario: parseFloat(prod.vUnCom) || 0,
          unidade: prod.uCom || null,
          produto_id
        }
      });
      itensCriados.push({ ...itemCriado, auto_match: !!produto_id });
    }

    // Limpar arquivo temporário
    fs.unlinkSync(req.file.path);

    res.json({
      importacao,
      itens: itensCriados,
      fornecedor: emit.xNome || emit.xFant,
      total_itens: itensCriados.length,
      auto_matched: itensCriados.filter(i => i.auto_match).length
    });
  } catch (error) {
    console.error('Erro ao importar NF-e:', error);
    res.status(500).json({ error: 'Erro ao processar XML da NF-e' });
  }
});

// Vincular item da NF a produto e dar entrada no estoque
app.post('/api/admin/nfe/vincular', async (req, res) => {
  try {
    const { item_id, produto_id } = req.body;
    const item = await prisma.itemImportacaoNFe.findUnique({ where: { id: item_id } });
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });

    // Atualizar vínculo
    await prisma.itemImportacaoNFe.update({
      where: { id: item_id },
      data: { produto_id }
    });

    // Dar entrada no estoque
    const produto = await prisma.produto.findUnique({ where: { id: produto_id } });
    if (produto) {
      const qtd = Math.round(item.quantidade);
      const estoque_antes = produto.estoque_atual;
      const estoque_depois = estoque_antes + qtd;

      await prisma.produto.update({
        where: { id: produto_id },
        data: {
          estoque_atual: estoque_depois,
          codigo_ean: item.codigo_ean || produto.codigo_ean,
          preco_custo: item.valor_unitario || produto.preco_custo,
          status: estoque_depois > 0 ? 'ativo' : produto.status
        }
      });

      await prisma.movimentacaoEstoque.create({
        data: {
          produto_id, tipo: 'entrada', quantidade: qtd,
          estoque_antes, estoque_depois, motivo: `Importação NF-e`
        }
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao vincular item:', error);
    res.status(500).json({ error: 'Erro ao vincular item' });
  }
});

// Histórico de importações
app.get('/api/admin/nfe/historico', async (req, res) => {
  try {
    const importacoes = await prisma.importacaoNFe.findMany({
      orderBy: { criado_em: 'desc' },
      take: 20,
      include: { itens: true }
    });
    res.json(importacoes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// ==================== F3: GESTÃO DE ESTOQUE ====================

// Lista estoque completo
app.get('/api/admin/estoque', async (req, res) => {
  try {
    const produtos = await prisma.produto.findMany({
      include: { categoria: true },
      orderBy: { estoque_atual: 'asc' }
    });
    res.json(produtos);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar estoque' });
  }
});

// Alertas de estoque não lidos
app.get('/api/admin/estoque/alertas', async (req, res) => {
  try {
    const alertas = await prisma.alertaEstoque.findMany({
      where: { lido: false },
      include: { produto: true },
      orderBy: { criado_em: 'desc' }
    });
    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar alertas' });
  }
});

// Marcar alerta como lido
app.patch('/api/admin/estoque/alertas/:id/ler', async (req, res) => {
  try {
    const alerta = await prisma.alertaEstoque.update({
      where: { id: req.params.id },
      data: { lido: true }
    });
    res.json(alerta);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao marcar alerta' });
  }
});

// Entrada de estoque
app.post('/api/admin/estoque/entrada', async (req, res) => {
  try {
    const { produto_id, quantidade, motivo } = req.body;
    const produto = await prisma.produto.findUnique({ where: { id: produto_id } });
    if (!produto) return res.status(404).json({ error: 'Produto não encontrado' });

    const estoque_antes = produto.estoque_atual;
    const estoque_depois = estoque_antes + parseInt(quantidade);

    const updatedProduto = await prisma.produto.update({
      where: { id: produto_id },
      data: {
        estoque_atual: estoque_depois,
        status: estoque_antes === 0 && estoque_depois > 0 ? 'ativo' : produto.status
      }
    });

    await prisma.movimentacaoEstoque.create({
      data: {
        produto_id, tipo: 'entrada', quantidade: parseInt(quantidade),
        estoque_antes, estoque_depois, motivo: motivo || 'Entrada de estoque'
      }
    });

    // Se reabasteceu de zero, criar alerta positivo
    if (estoque_antes === 0 && estoque_depois > 0) {
      await prisma.alertaEstoque.create({
        data: { produto_id, tipo: 'reabastecido', mensagem: `${produto.nome} reabastecido (${estoque_depois} un)` }
      });
      io.emit('stock_alert', { type: 'reabastecido', produto: produto.nome, estoque: estoque_depois });
      io.emit('refresh_data');
    }

    const bar = await prisma.bar.findFirst();
    if (bar) logAction(bar.id, 'admin', 'ENTRADA_ESTOQUE', { produto_id, quantidade, estoque_depois });
    res.json(updatedProduto);
  } catch (error) {
    console.error('Erro ao registrar entrada:', error);
    res.status(500).json({ error: 'Erro ao registrar entrada' });
  }
});

// Ajuste manual de estoque
app.post('/api/admin/estoque/ajuste', async (req, res) => {
  try {
    const { produto_id, novo_estoque, motivo } = req.body;
    const produto = await prisma.produto.findUnique({ where: { id: produto_id } });
    if (!produto) return res.status(404).json({ error: 'Produto não encontrado' });

    const estoque_antes = produto.estoque_atual;
    const quantidade = parseInt(novo_estoque) - estoque_antes;
    const novoEstoqueInt = parseInt(novo_estoque);

    const updatedProduto = await prisma.produto.update({
      where: { id: produto_id },
      data: {
        estoque_atual: novoEstoqueInt,
        status: novoEstoqueInt === 0 ? 'esgotado' : (produto.status === 'esgotado' ? 'ativo' : produto.status)
      }
    });

    await prisma.movimentacaoEstoque.create({
      data: {
        produto_id, tipo: 'ajuste', quantidade,
        estoque_antes, estoque_depois: novoEstoqueInt, motivo: motivo || 'Ajuste manual'
      }
    });

    await checkStockAlert(io, produto_id, novoEstoqueInt, produto.estoque_minimo, produto.nome);

    const bar = await prisma.bar.findFirst();
    if (bar) logAction(bar.id, 'admin', 'AJUSTE_ESTOQUE', { produto_id, estoque_antes, novo_estoque: novoEstoqueInt, motivo });
    res.json(updatedProduto);
  } catch (error) {
    console.error('Erro ao ajustar estoque:', error);
    res.status(500).json({ error: 'Erro ao ajustar estoque' });
  }
});

// Histórico de movimentações de um produto
app.get('/api/admin/estoque/historico/:produtoId', async (req, res) => {
  try {
    const movimentacoes = await prisma.movimentacaoEstoque.findMany({
      where: { produto_id: req.params.produtoId },
      orderBy: { criado_em: 'desc' },
      take: 50
    });
    res.json(movimentacoes);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Serve o frontend (superapp) se FRONTEND_DIST_PATH estiver definido
if (process.env.FRONTEND_DIST_PATH && fs.existsSync(process.env.FRONTEND_DIST_PATH)) {
  app.use(express.static(process.env.FRONTEND_DIST_PATH, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
    }
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(process.env.FRONTEND_DIST_PATH, 'index.html'));
  });
  console.log(`🌐 Servindo frontend de: ${process.env.FRONTEND_DIST_PATH}`);
}

// Auto-seed: cria bar padrão se não existir
async function ensureBarExists() {
  try {
    const existing = await prisma.bar.findFirst();
    if (!existing) {
      console.log('🌱 Nenhum bar encontrado, criando dados iniciais...');
      const bar = await prisma.bar.create({
        data: {
          nome: 'AOOBA! BAR',
          slug: 'aooba-bar',
          mensagem_boas_vindas: 'Seja bem-vindo ao bar mais tecnológico da cidade.',
          senha_master: '1234',
          active: true,
          aberto: true,
        }
      });
      // Mesas
      for (let i = 1; i <= 20; i++) {
        await prisma.mesa.create({
          data: { bar_id: bar.id, numero: i, qr_token: `pwd_${i}`, setor: 'interno' }
        });
      }
      // Config fidelidade
      await prisma.configFidelidade.create({
        data: { bar_id: bar.id, pts_por_real: 1.0, pts_cadastro: 50, pts_musica_tocada: 10 }
      });
      console.log('✅ Bar, mesas e config criados com sucesso!');
    } else {
      console.log(`✅ Bar existente: ${existing.nome}`);
    }
  } catch (e) {
    console.error('⚠️ Erro no auto-seed:', e.message);
  }
}

server.listen(PORT, async () => {
  console.log(`🚀 AOOBA! Server running on http://localhost:${PORT}`);
  await ensureBarExists();
});
