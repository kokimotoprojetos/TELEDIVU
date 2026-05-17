const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Servir arquivos estáticos do frontend em produção se compilado
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Estado em memória
const activeClients = new Map(); // phone -> TelegramClient
const pendingConnections = new Map(); // sessionId -> PendingConnection

// Helper para Defer / Promessas Adiar
class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

// -------------------------------------------------------------
// INICIALIZAÇÃO DE CONTAS SALVAS
// -------------------------------------------------------------
async function initializeSavedAccounts() {
  const accounts = await db.getAccounts();
  const settings = await db.getSettings();
  
  console.log(`[Sistema] Inicializando ${accounts.length} contas salvas no banco...`);
  
  for (const acc of accounts) {
    if (acc.status === 'connected') {
      try {
        console.log(`[Telegram] Reconectando conta +${acc.phone}...`);
        const client = new TelegramClient(
          new StringSession(acc.session),
          Number(settings.defaultApiId),
          settings.defaultApiHash,
          {
            connectionRetries: 3,
            autoReconnect: true,
            timeout: 10000
          }
        );
        
        await client.connect();
        const me = await client.getMe();
        
        if (me) {
          activeClients.set(acc.phone, client);
          console.log(`[Telegram] Conta +${acc.phone} (${me.firstName || 'Sem Nome'}) conectada com sucesso!`);
        } else {
          throw new Error('Falha ao obter dados do usuário');
        }
      } catch (err) {
        console.error(`[Telegram] Erro ao reconectar conta +${acc.phone}:`, err.message);
        acc.status = 'disconnected';
        await db.saveAccount(acc);
        await db.addLog({
          campaignId: 'system',
          campaignName: 'Sistema',
          accountPhone: acc.phone,
          target: 'Sistema',
          status: 'failed',
          error: `Sessão expirou ou foi desconectada pelo Telegram: ${err.message}`
        });
      }
    }
  }
}

// -------------------------------------------------------------
// AGENDADOR DE MENSAGENS AUTOMÁTICAS (BACKGROUND SCHEDULER)
// -------------------------------------------------------------
const EMOJIS = ['😊', '👍', '🚀', '🔥', '✨', '👋', '🎉', '💡', '✅', '💬'];

async function parseMessage(client, target, messageTemplate, accountPhone) {
  let parsed = messageTemplate;
  
  // Lista de emojis aleatórios
  const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  parsed = parsed.replace(/{random_emoji}/g, randomEmoji);
  parsed = parsed.replace(/{account_phone}/g, `+${accountPhone}`);

  try {
    // Tenta carregar informações da entidade destino para personalização
    const entity = await client.getEntity(target);
    if (entity) {
      const firstName = entity.firstName || entity.title || 'Membro';
      const lastName = entity.lastName || '';
      const username = entity.username ? `@${entity.username}` : 'Membro';
      const chatTitle = entity.title || entity.firstName || 'Chat';
      
      parsed = parsed.replace(/{first_name}/g, firstName);
      parsed = parsed.replace(/{last_name}/g, lastName);
      parsed = parsed.replace(/{username}/g, username);
      parsed = parsed.replace(/{chat_title}/g, chatTitle);
    }
  } catch (err) {
    // Em caso de falha (ex: rate limit ou username inválido), substitui por fallbacks básicos
    parsed = parsed.replace(/{first_name}/g, 'Amigo(a)');
    parsed = parsed.replace(/{last_name}/g, '');
    parsed = parsed.replace(/{username}/g, target);
    parsed = parsed.replace(/{chat_title}/g, 'Grupo');
  }
  
  return parsed;
}

async function runScheduler() {
  const campaigns = await db.getCampaigns();
  
  for (const cmp of campaigns) {
    if (cmp.status !== 'active') continue;
    
    const now = new Date();
    const nextSend = cmp.nextSendAt ? new Date(cmp.nextSendAt) : null;
    
    // Verifica se já passou a hora do próximo envio
    if (!nextSend || now >= nextSend) {
      const targets = cmp.targets || [];
      const currentIdx = cmp.currentTargetIndex || 0;
      
      // Se já percorremos todos os alvos
      if (currentIdx >= targets.length) {
        cmp.status = 'completed';
        cmp.nextSendAt = null;
        await db.saveCampaign(cmp);
        await db.addLog({
          campaignId: cmp.id,
          campaignName: cmp.name,
          accountPhone: 'Sistema',
          target: 'Todos',
          status: 'success',
          error: 'Campanha finalizada. Todos os alvos foram contatados!'
        });
        continue;
      }
      
      const target = targets[currentIdx];
      
      // Sistema de Round-Robin para selecionar a conta de envio
      const campaignAccounts = cmp.accounts || [];
      let clientToUse = null;
      let phoneToUse = null;
      
      for (const phone of campaignAccounts) {
        if (activeClients.has(phone)) {
          clientToUse = activeClients.get(phone);
          phoneToUse = phone;
          // Rotaciona a conta: remove a conta usada e joga pro final do array da campanha
          // para o próximo disparo usar outra conta
          const index = campaignAccounts.indexOf(phone);
          if (index > -1) {
            campaignAccounts.splice(index, 1);
            campaignAccounts.push(phone);
            cmp.accounts = campaignAccounts;
          }
          break;
        }
      }
      
      if (!clientToUse) {
        console.warn(`[Agendador] Nenhuma conta conectada disponível para a campanha "${cmp.name}".`);
        cmp.status = 'paused';
        await db.saveCampaign(cmp);
        await db.addLog({
          campaignId: cmp.id,
          campaignName: cmp.name,
          accountPhone: 'Sistema',
          target: target,
          status: 'failed',
          error: 'Campanha pausada: nenhuma das contas selecionadas está conectada no momento.'
        });
        continue;
      }
      
      // Envia a mensagem
      try {
        console.log(`[Agendador] Disparando para ${target} usando conta +${phoneToUse}...`);
        
        // Personaliza a mensagem
        const messageToSend = await parseMessage(clientToUse, target, cmp.message, phoneToUse);
        
        // Dispara no Telegram
        await clientToUse.sendMessage(target, { message: messageToSend });
        
        // Atualiza estatísticas de sucesso
        cmp.sentCount = (cmp.sentCount || 0) + 1;
        cmp.currentTargetIndex = currentIdx + 1;
        
        // Calcula próximo envio com delay + variação humana
        const delayMs = (cmp.delay || 60) * 1000;
        const randomMs = ((cmp.randomDelay || 10) * Math.random() * 2000) - ((cmp.randomDelay || 10) * 1000);
        const finalDelay = Math.max(10000, delayMs + randomMs); // mínimo de 10s de segurança
        
        cmp.nextSendAt = new Date(Date.now() + finalDelay).toISOString();
        await db.saveCampaign(cmp);
        
        await db.addLog({
          campaignId: cmp.id,
          campaignName: cmp.name,
          accountPhone: phoneToUse,
          target: target,
          status: 'success',
          error: null
        });
        
        console.log(`[Agendador] Sucesso no envio para ${target}. Próximo disparo em ${Math.round(finalDelay/1000)} segundos.`);
      } catch (err) {
        console.error(`[Agendador] Erro ao enviar para ${target}:`, err.message);
        
        cmp.failedCount = (cmp.failedCount || 0) + 1;
        
        // Trata FloodWaitError (bloqueio temporário do Telegram)
        if (err.message.includes('FLOOD_WAIT') || err.name === 'FloodWaitError') {
          // Extrai o tempo de bloqueio se houver
          const seconds = parseInt(err.message.match(/\d+/)?.[0] || '60', 10);
          console.warn(`[Agendador] Conta +${phoneToUse} recebeu FLOOD_WAIT de ${seconds}s.`);
          
          await db.addLog({
            campaignId: cmp.id,
            campaignName: cmp.name,
            accountPhone: phoneToUse,
            target: target,
            status: 'failed',
            error: `Bloqueio de envio temporário (Flood Wait) de ${seconds} segundos. O sistema aguardará.`
          });
          
          // Adia a campanha pelo tempo do bloqueio + 30s de segurança
          cmp.nextSendAt = new Date(Date.now() + (seconds + 30) * 1000).toISOString();
          await db.saveCampaign(cmp);
        } else {
          // Outros erros (ex: username inválido ou chat restrito).
          // Avança para o próximo alvo para não travar a campanha inteira!
          cmp.currentTargetIndex = currentIdx + 1;
          
          const delayMs = (cmp.delay || 60) * 1000;
          cmp.nextSendAt = new Date(Date.now() + delayMs).toISOString();
          await db.saveCampaign(cmp);
          
          await db.addLog({
            campaignId: cmp.id,
            campaignName: cmp.name,
            accountPhone: phoneToUse,
            target: target,
            status: 'failed',
            error: `Erro ao enviar: ${err.message}`
          });
        }
      }
    }
  }
}

// Inicia loop do agendador a cada 10 segundos
setInterval(runScheduler, 10000);

// -------------------------------------------------------------
// ROTAS DE CONFIGURAÇÕES E ESTATÍSTICAS
// -------------------------------------------------------------
app.get('/api/settings', async (req, res) => {
  const settings = await db.getSettings();
  res.json(settings);
});

app.post('/api/settings', async (req, res) => {
  const { defaultApiId, defaultApiHash } = req.body;
  const saved = await db.saveSettings({ defaultApiId, defaultApiHash });
  res.json(saved);
});

app.get('/api/stats', async (req, res) => {
  const accounts = await db.getAccounts();
  const campaigns = await db.getCampaigns();
  const logs = await db.getLogs();
  
  const connectedCount = accounts.filter(a => a.status === 'connected').length;
  const activeCampaigns = campaigns.filter(c => c.status === 'active').length;
  const totalSent = logs.filter(l => l.status === 'success' && l.campaignId !== 'system').length;
  const totalFailed = logs.filter(l => l.status === 'failed').length;
  
  res.json({
    totalAccounts: accounts.length,
    connectedAccounts: connectedCount,
    totalCampaigns: campaigns.length,
    activeCampaigns,
    totalSent,
    totalFailed
  });
});

// -------------------------------------------------------------
// ROTAS DE CONTAS DO TELEGRAM
// -------------------------------------------------------------
app.get('/api/accounts', async (req, res) => {
  const accounts = await db.getAccounts();
  // Retorna com status de ativação em memória atualizado
  const mapped = accounts.map(acc => ({
    ...acc,
    isOnline: activeClients.has(acc.phone)
  }));
  res.json(mapped);
});

app.delete('/api/accounts/:phone', async (req, res) => {
  const { phone } = req.params;
  
  // Desconecta o cliente em memória se houver
  if (activeClients.has(phone)) {
    try {
      const client = activeClients.get(phone);
      await client.disconnect();
      activeClients.delete(phone);
    } catch (e) {
      console.error(e);
    }
  }
  
  await db.deleteAccount(phone);
  res.json({ success: true, message: `Conta +${phone} desconectada e deletada.` });
});

// -------------------------------------------------------------
// FLUXO DE LOGIN ASSÍNCRONO POR NÚMERO (SMS)
// -------------------------------------------------------------
app.post('/api/accounts/connect/phone/start', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número de telefone é obrigatório.' });
  
  const settings = await db.getSettings();
  const cleanPhone = phone.replace(/[^\d+]/g, ''); // mantém apenas números e +
  
  const sessionId = uuidv4();
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, Number(settings.defaultApiId), settings.defaultApiHash, {
    connectionRetries: 3,
    autoReconnect: true
  });
  
  const pendingConn = {
    sessionId,
    type: 'phone',
    client,
    phone: cleanPhone,
    status: 'connecting',
    phoneCodeDeferred: new Deferred(),
    passwordDeferred: new Deferred(),
    error: null
  };
  
  pendingConnections.set(sessionId, pendingConn);
  
  // Inicia o processo em background
  client.connect().then(() => {
    pendingConn.status = 'awaiting_code';
    
    return client.start({
      phoneNumber: async () => pendingConn.phone,
      phoneCode: async () => {
        // Bloqueia e aguarda o frontend enviar o código via submit-code
        pendingConn.status = 'awaiting_code';
        console.log(`[Pending] Aguardando código SMS para +${pendingConn.phone}...`);
        return await pendingConn.phoneCodeDeferred.promise;
      },
      password: async (hint) => {
        // Bloqueia e aguarda o frontend enviar a senha 2FA se necessário
        pendingConn.status = 'awaiting_password';
        console.log(`[Pending] Aguardando senha 2FA para +${pendingConn.phone} (Dica: ${hint})...`);
        return await pendingConn.passwordDeferred.promise;
      },
      onError: (err) => {
        console.error(`[Telegram Client Auth Error]:`, err.message);
        pendingConn.status = 'error';
        pendingConn.error = err.message;
      }
    });
  }).then(async () => {
    // Sucesso!
    pendingConn.status = 'success';
    const me = await client.getMe();
    
    // Salva no Banco de Dados
    await db.saveAccount({
      phone: me.phone,
      firstName: me.firstName || 'Sem Nome',
      lastName: me.lastName || '',
      username: me.username || '',
      session: client.session.save(),
      connectedAt: new Date().toISOString(),
      status: 'connected'
    });
    
    // Armazena no cache de conexões ativas
    activeClients.set(me.phone, client);
    console.log(`[Auth Phone] Conta +${me.phone} autenticada com sucesso!`);
    
    // Limpa a conexão pendente após alguns minutos de segurança
    setTimeout(() => pendingConnections.delete(sessionId), 60000);
  }).catch(err => {
    console.error(`[Auth Phone Catch Error]:`, err.message);
    pendingConn.status = 'error';
    pendingConn.error = err.message;
    setTimeout(() => pendingConnections.delete(sessionId), 60000);
  });
  
  res.json({ sessionId, status: 'connecting' });
});

// Envio de código recebido
app.post('/api/accounts/connect/phone/submit-code', async (req, res) => {
  const { sessionId, code } = req.body;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) return res.status(404).json({ error: 'Sessão de conexão expirada ou inválida.' });
  if (conn.status !== 'awaiting_code') return res.status(400).json({ error: 'A conexão não está aguardando código no momento.' });
  
  conn.phoneCodeDeferred.resolve(code);
  res.json({ success: true, message: 'Código recebido pelo servidor, processando...' });
});

// Envio de senha 2FA recebida
app.post('/api/accounts/connect/phone/submit-password', async (req, res) => {
  const { sessionId, password } = req.body;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) return res.status(404).json({ error: 'Sessão de conexão expirada ou inválida.' });
  if (conn.status !== 'awaiting_password') return res.status(400).json({ error: 'A conexão não está aguardando senha 2FA no momento.' });
  
  conn.passwordDeferred.resolve(password);
  res.json({ success: true, message: 'Senha 2FA recebida pelo servidor, processando...' });
});

// -------------------------------------------------------------
// FLUXO DE LOGIN ASSÍNCRONO POR QR CODE
// -------------------------------------------------------------
app.post('/api/accounts/connect/qr/start', async (req, res) => {
  const settings = await db.getSettings();
  const sessionId = uuidv4();
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, Number(settings.defaultApiId), settings.defaultApiHash, {
    connectionRetries: 3,
    autoReconnect: true
  });
  
  const pendingConn = {
    sessionId,
    type: 'qr',
    client,
    phone: null,
    status: 'connecting',
    qrLink: null,
    qrImage: null, // base64 do QR code
    passwordDeferred: new Deferred(),
    error: null
  };
  
  pendingConnections.set(sessionId, pendingConn);
  
  // Inicia o processo em background
  client.connect().then(() => {
    pendingConn.status = 'awaiting_scan';
    
    return client.signInUserWithQrCode(
      { apiId: Number(settings.defaultApiId), apiHash: settings.defaultApiHash },
      {
        qrCode: async (code) => {
          pendingConn.status = 'awaiting_scan';
          const base64UrlToken = code.token.toString('base64url');
          pendingConn.qrLink = `tg://login?token=${base64UrlToken}`;
          
          // Gera imagem QR Code em base64 no próprio backend
          try {
            pendingConn.qrImage = await qrcode.toDataURL(pendingConn.qrLink, {
              margin: 2,
              width: 300,
              color: {
                dark: '#000000',
                light: '#ffffff'
              }
            });
          } catch (qrErr) {
            console.error('Erro ao gerar QR em base64:', qrErr);
          }
          
          console.log(`[Pending QR] QR Code Token gerado. Aguardando escaneamento...`);
        },
        password: async (hint) => {
          pendingConn.status = 'awaiting_password';
          console.log(`[Pending QR] QR escaneado, mas exige senha 2FA (Dica: ${hint})...`);
          return await pendingConn.passwordDeferred.promise;
        },
        onError: (err) => {
          console.error(`[Telegram Client QR Auth Error]:`, err.message);
          pendingConn.status = 'error';
          pendingConn.error = err.message;
        }
      }
    );
  }).then(async (user) => {
    // Sucesso!
    pendingConn.status = 'success';
    const me = await client.getMe();
    
    // Salva no Banco de Dados
    await db.saveAccount({
      phone: me.phone,
      firstName: me.firstName || 'Sem Nome',
      lastName: me.lastName || '',
      username: me.username || '',
      session: client.session.save(),
      connectedAt: new Date().toISOString(),
      status: 'connected'
    });
    
    // Armazena no cache de conexões ativas
    activeClients.set(me.phone, client);
    console.log(`[Auth QR] Conta +${me.phone} autenticada via QR com sucesso!`);
    
    // Limpa a conexão pendente após alguns minutos de segurança
    setTimeout(() => pendingConnections.delete(sessionId), 60000);
  }).catch(err => {
    console.error(`[Auth QR Catch Error]:`, err.message);
    pendingConn.status = 'error';
    pendingConn.error = err.message;
    setTimeout(() => pendingConnections.delete(sessionId), 60000);
  });
  
  res.json({ sessionId, status: 'connecting' });
});

// Consulta de status de conexões pendentes (Tanto QR quanto Telefone utilizam esta rota!)
app.get('/api/accounts/connect/status', async (req, res) => {
  const { sessionId } = req.query;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) {
    return res.status(404).json({ error: 'Sessão expirada ou não encontrada.' });
  }
  
  res.json({
    status: conn.status,
    type: conn.type,
    phone: conn.phone,
    qrImage: conn.qrImage, // apenas para login QR
    error: conn.error
  });
});

// -------------------------------------------------------------
// ROTAS DE CAMPANHAS DE AUTOMACÃO
// -------------------------------------------------------------
app.get('/api/campaigns', async (req, res) => {
  const campaigns = await db.getCampaigns();
  res.json(campaigns);
});

app.post('/api/campaigns', async (req, res) => {
  const { id, name, accounts, targetsText, message, delay, randomDelay } = req.body;
  
  // Converte a caixa de texto de alvos em um array limpo
  const targets = targetsText
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0);
    
  const campaign = {
    id: id || uuidv4(),
    name: name || 'Nova Campanha',
    accounts: accounts || [],
    targets: targets,
    targetsText: targetsText, // guarda o texto original para edição
    message: message || '',
    delay: Number(delay) || 60,
    randomDelay: Number(randomDelay) || 10,
    status: id ? (await db.getCampaignById(id))?.status || 'paused' : 'paused',
    sentCount: id ? (await db.getCampaignById(id))?.sentCount || 0 : 0,
    failedCount: id ? (await db.getCampaignById(id))?.failedCount || 0 : 0,
    currentTargetIndex: id ? (await db.getCampaignById(id))?.currentTargetIndex || 0 : 0,
    createdAt: id ? (await db.getCampaignById(id))?.createdAt || new Date().toISOString() : new Date().toISOString(),
    nextSendAt: null
  };
  
  const saved = await db.saveCampaign(campaign);
  res.json(saved);
});

app.delete('/api/campaigns/:id', async (req, res) => {
  const { id } = req.params;
  await db.deleteCampaign(id);
  res.json({ success: true, message: 'Campanha deletada.' });
});

app.post('/api/campaigns/:id/toggle', async (req, res) => {
  const { id } = req.params;
  const cmp = await db.getCampaignById(id);
  
  if (!cmp) return res.status(404).json({ error: 'Campanha não encontrada.' });
  
  if (cmp.status === 'active') {
    cmp.status = 'paused';
    cmp.nextSendAt = null;
  } else {
    cmp.status = 'active';
    // Se estava completado e o usuário reativar, zera o índice para começar de novo
    if (cmp.status === 'completed' || cmp.currentTargetIndex >= cmp.targets.length) {
      cmp.currentTargetIndex = 0;
      cmp.sentCount = 0;
      cmp.failedCount = 0;
    }
    // Dispara o primeiro envio após 5 segundos da ativação
    cmp.nextSendAt = new Date(Date.now() + 5000).toISOString();
  }
  
  await db.saveCampaign(cmp);
  res.json(cmp);
});

// -------------------------------------------------------------
// ROTAS DE LOGS
// -------------------------------------------------------------
app.get('/api/logs', async (req, res) => {
  const logs = await db.getLogs();
  res.json(logs);
});

app.post('/api/logs/clear', async (req, res) => {
  await db.clearLogs();
  res.json({ success: true });
});

// Servir frontend React em produção (fallback para SPA React Router)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// -------------------------------------------------------------
// INICIALIZAÇÃO E START
// -------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`[Servidor] Rodando na porta ${PORT}`);
  try {
    await initializeSavedAccounts();
  } catch (err) {
    console.error('[Sistema] Erro fatal ao carregar contas salvas:', err);
  }
});
