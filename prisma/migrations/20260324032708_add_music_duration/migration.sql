-- CreateTable
CREATE TABLE "Bar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nome" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo_url" TEXT,
    "config_spotify" TEXT,
    "mensagem_boas_vindas" TEXT,
    "limite_pedidos" INTEGER NOT NULL DEFAULT 3,
    "tempo_inatividade" INTEGER NOT NULL DEFAULT 60,
    "senha_master" TEXT DEFAULT '1234',
    "aberto" BOOLEAN NOT NULL DEFAULT true,
    "chamar_garcom_ativo" BOOLEAN NOT NULL DEFAULT false,
    "fidelidade_ativa" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Mesa" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "nome_apelido" TEXT,
    "setor" TEXT,
    "qr_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'livre',
    CONSTRAINT "Mesa_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cpf_ou_telefone" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "pontos_fidelidade" INTEGER NOT NULL DEFAULT 0,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Sessao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mesa_id" TEXT NOT NULL,
    "cliente_id" TEXT NOT NULL,
    "aberta_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechada_em" DATETIME,
    "total" REAL NOT NULL DEFAULT 0,
    "device_id" TEXT,
    CONSTRAINT "Sessao_mesa_id_fkey" FOREIGN KEY ("mesa_id") REFERENCES "Mesa" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Sessao_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "Cliente" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProdutoCategoria" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ProdutoCategoria_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Produto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoria_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "preco" REAL NOT NULL,
    "foto_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ativo',
    "destaque" BOOLEAN NOT NULL DEFAULT false,
    "limite_escolhas" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Produto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "ProdutoCategoria" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProdutoVersao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "produto_id" TEXT NOT NULL,
    "preco" REAL NOT NULL,
    "vigente_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProdutoVersao_produto_id_fkey" FOREIGN KEY ("produto_id") REFERENCES "Produto" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProdutoOpcao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "produto_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "acrescimo" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "ProdutoOpcao_produto_id_fkey" FOREIGN KEY ("produto_id") REFERENCES "Produto" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Pedido" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessao_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recebido',
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Pedido_sessao_id_fkey" FOREIGN KEY ("sessao_id") REFERENCES "Sessao" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemPedido" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pedido_id" TEXT NOT NULL,
    "produto_id" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "preco_unitario" REAL NOT NULL,
    "observacao" TEXT,
    "opcoes_escolhidas" TEXT,
    CONSTRAINT "ItemPedido_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "Pedido" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ItemPedido_produto_id_fkey" FOREIGN KEY ("produto_id") REFERENCES "Produto" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Promocao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "desconto_pct" REAL NOT NULL,
    "inicio" DATETIME NOT NULL,
    "fim" DATETIME NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Promocao_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SugestaoMusica" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessao_id" TEXT NOT NULL,
    "spotify_track_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "artista" TEXT NOT NULL,
    "duracao" TEXT,
    "capa" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "atualizado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SugestaoMusica_sessao_id_fkey" FOREIGN KEY ("sessao_id") REFERENCES "Sessao" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FilaMusica" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "spotify_track_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "artista" TEXT NOT NULL,
    "duracao" TEXT,
    "adicionada_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tocou" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FilaMusica_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminUser_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "detalhes_json" TEXT,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notificacao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tipo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "lida" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MensagemMesa" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mesa_id" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "expira_em" DATETIME NOT NULL,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MensagemMesa_mesa_id_fkey" FOREIGN KEY ("mesa_id") REFERENCES "Mesa" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientePontos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cliente_id" TEXT NOT NULL,
    "bar_id" TEXT NOT NULL,
    "pontos_total" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'Frequentador',
    "atualizado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientePontos_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "Cliente" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransacaoPontos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cliente_id" TEXT NOT NULL,
    "sessao_id" TEXT,
    "tipo" TEXT NOT NULL,
    "pontos" INTEGER NOT NULL,
    "descricao" TEXT,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransacaoPontos_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "Cliente" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransacaoPontos_sessao_id_fkey" FOREIGN KEY ("sessao_id") REFERENCES "Sessao" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConfigFidelidade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bar_id" TEXT NOT NULL,
    "pts_por_real" REAL NOT NULL DEFAULT 1,
    "pts_cadastro" INTEGER NOT NULL DEFAULT 50,
    "pts_musica_tocada" INTEGER NOT NULL DEFAULT 10,
    "threshold_habitue" INTEGER NOT NULL DEFAULT 500,
    "threshold_vip" INTEGER NOT NULL DEFAULT 1500,
    CONSTRAINT "ConfigFidelidade_bar_id_fkey" FOREIGN KEY ("bar_id") REFERENCES "Bar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Recompensa" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "pontos_custo" INTEGER NOT NULL,
    "imagem_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ativo',
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Resgate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cliente_id" TEXT NOT NULL,
    "recompensa_id" TEXT NOT NULL,
    "sessao_id" TEXT,
    "pontos_gastos" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Resgate_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "Cliente" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Resgate_recompensa_id_fkey" FOREIGN KEY ("recompensa_id") REFERENCES "Recompensa" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_ProdutoPromocao" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_ProdutoPromocao_A_fkey" FOREIGN KEY ("A") REFERENCES "Produto" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_ProdutoPromocao_B_fkey" FOREIGN KEY ("B") REFERENCES "Promocao" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Bar_slug_key" ON "Bar"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Mesa_qr_token_key" ON "Mesa"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_cpf_ou_telefone_key" ON "Cliente"("cpf_ou_telefone");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientePontos_cliente_id_key" ON "ClientePontos"("cliente_id");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigFidelidade_bar_id_key" ON "ConfigFidelidade"("bar_id");

-- CreateIndex
CREATE UNIQUE INDEX "_ProdutoPromocao_AB_unique" ON "_ProdutoPromocao"("A", "B");

-- CreateIndex
CREATE INDEX "_ProdutoPromocao_B_index" ON "_ProdutoPromocao"("B");
