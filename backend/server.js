require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const db = require('./db');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------------------------------------------------
// SEGURANÇA: Headers HTTP, CORS restrito e limite de payload
// -------------------------------------------------------------
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ALLOWED_ORIGINS = [
  'https://teledivu.vercel.app',
  'http://localhost:5173',
  'http://localhost:5000'
];
app.use(cors({
  origin: (origin, callback) => {
    // Permite requisições sem origin (ex: Render health checks, curl)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado pela política de CORS.'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Limite de tamanho de payload: 5MB (suficiente para imagens base64)
app.use(bodyParser.json({ limit: '5mb' }));

// Rate limiting nas rotas de autenticação (C4 / A2)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 15, // máximo 15 tentativas por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.' }
});

// Servir arquivos estáticos do frontend em produção se compilado
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// -------------------------------------------------------------
// SISTEMA DE SEGURANÇA E JWT NATIVO
// -------------------------------------------------------------

// C4: JWT_SECRET obrigatório — impede inicialização sem chave forte
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('\n[FATAL] JWT_SECRET não está definido nas variáveis de ambiente!');
  console.error('[FATAL] Defina JWT_SECRET no arquivo .env ou nas variáveis do Render.');
  console.error('[FATAL] Sugestão: node -e "require(\'crypto\').randomBytes(64).toString(\'hex\') |> console.log"');
  process.exit(1);
}

// C1: Token com expiração de 24 horas
function generateToken(payload) {
  const tokenPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 horas
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    if (!header || !body || !signature) return null;
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    // Comparação segura contra timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // C1: Verificar expiração
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

// C2: bcrypt com salt cost 12 (substituindo SHA-256 sem salt)
function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function verifyPassword(plain, hash) {
  // Suporta hashes bcrypt novos E hashes SHA-256 legados (migração gradual)
  if (hash && hash.startsWith('$2')) {
    return bcrypt.compareSync(plain, hash);
  }
  // Fallback para hashes SHA-256 antigos (legado)
  const legacyHash = crypto.createHash('sha256').update(plain).digest('hex');
  return legacyHash === hash;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido ou inválido.' });
  }
  const token = authHeader.split(' ')[1];
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Sessão expirada. Por favor, faça login novamente.' });
  }
  req.user = user;
  next();
}

// Estado em memória
const activeClients = new Map(); // phone -> TelegramClient
const pendingConnections = new Map(); // sessionId -> PendingConnection

// Helper para normalizar telefones em formato numérico puro
const cleanPhone = (phone) => String(phone || '').replace(/[^\d]/g, '');

// Helper para Defer / Promessas Adiar
class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function getTelegramCredentials(settings) {
  if (settings.useCustomApi && settings.customApiId && settings.customApiHash) {
    return {
      apiId: Number(settings.customApiId),
      apiHash: settings.customApiHash
    };
  }
  // B3: Credenciais padrão lidas das variáveis de ambiente primeiro
  return {
    apiId: Number(process.env.TELEGRAM_API_ID) || 31992404,
    apiHash: process.env.TELEGRAM_API_HASH || '29d0d2dc1ac01f98aefed17f7e017edf'
  };
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
        const creds = getTelegramCredentials(settings);
        const client = new TelegramClient(
          new StringSession(acc.session),
          creds.apiId,
          creds.apiHash,
          {
            connectionRetries: 3,
            autoReconnect: true,
            timeout: 10000
          }
        );
        
        await client.connect();
        const me = await client.getMe();
        
        if (me) {
          activeClients.set(cleanPhone(acc.phone), client);
          console.log(`[Telegram] Conta +${acc.phone} (${me.firstName || 'Sem Nome'}) conectada com sucesso!`);
          
          // Auto-healing / Migration: update name, firstName, lastName and username if they are missing or empty
          const currentName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || 'Sem Nome';
          if (!acc.name || acc.name === 'Sem Nome' || !acc.firstName || acc.firstName === 'Sem Nome') {
            acc.name = currentName;
            acc.firstName = me.firstName || 'Sem Nome';
            acc.lastName = me.lastName || '';
            acc.username = me.username || '';
            await db.saveAccount(acc);
            console.log(`[Telegram] Nome da conta +${acc.phone} atualizado/corrigido para "${currentName}" no banco de dados.`);
          }
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
          error: `Sessão expirou ou foi desconectada pelo Telegram: ${err.message}`,
          userId: acc.userId
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

let isSchedulerRunning = false;

async function runScheduler() {
  if (isSchedulerRunning) {
    console.log('[Agendador] Execução anterior ainda em andamento. Pulando esta rodada...');
    return;
  }
  isSchedulerRunning = true;
  
  try {
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
          if (cmp.loop) {
            cmp.currentTargetIndex = 0;
            
            // Calcula o delay para reiniciar a campanha
            const baseDelayMin = Number(cmp.delay || 1);
            const randomDelayMin = Number(cmp.randomDelay || 0);
            const actualDelayMin = baseDelayMin + (Math.random() * randomDelayMin);
            const finalDelay = Math.max(10000, actualDelayMin * 60 * 1000); // mínimo de 10s de segurança
            
            cmp.nextSendAt = new Date(Date.now() + finalDelay).toISOString();
            await db.saveCampaign(cmp);
            await db.addLog({
              campaignId: cmp.id,
              campaignName: cmp.name,
              accountPhone: 'Sistema',
              target: 'Sistema',
              status: 'success',
              error: 'Todos os alvos contatados. Opção LOOP ativa: reiniciando fila de envios a partir do primeiro alvo.',
              userId: cmp.userId
            });
            continue;
          } else {
            cmp.status = 'completed';
            cmp.nextSendAt = null;
            await db.saveCampaign(cmp);
            await db.addLog({
              campaignId: cmp.id,
              campaignName: cmp.name,
              accountPhone: 'Sistema',
              target: 'Todos',
              status: 'success',
              error: 'Campanha finalizada. Todos os alvos foram contatados!',
              userId: cmp.userId
            });
            continue;
          }
        }
        
        const target = targets[currentIdx];
        
        // Sistema de Round-Robin para selecionar a conta de envio
        const campaignAccounts = cmp.accounts || [];
        let clientToUse = null;
        let phoneToUse = null;
        
        for (const phone of campaignAccounts) {
          const cleanedPhone = cleanPhone(phone);
          if (activeClients.has(cleanedPhone)) {
            clientToUse = activeClients.get(cleanedPhone);
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
            error: 'Campanha pausada: nenhuma das contas selecionadas está conectada no momento.',
            userId: cmp.userId
          });
          continue;
        }
        
        // Envia a mensagem
        try {
          console.log(`[Agendador] Disparando para ${target} usando conta +${phoneToUse}...`);
          
          let rawMessage = cmp.message;
          let mediaBase64 = null;
          
          if (rawMessage && rawMessage.startsWith('{') && rawMessage.endsWith('}')) {
            try {
              const parsed = JSON.parse(rawMessage);
              rawMessage = parsed.text || '';
              mediaBase64 = parsed.image || null;
            } catch (e) {
              // Se falhar o parse, mantém a mensagem como texto puro
            }
          }
          
          // Personaliza a mensagem
          const messageToSend = await parseMessage(clientToUse, target, rawMessage, phoneToUse);
          
          // Dispara no Telegram (com imagem ou texto plano)
          if (mediaBase64) {
            const base64Data = mediaBase64.replace(/^data:image\/\w+;base64,/, "");
            const fileBuffer = Buffer.from(base64Data, 'base64');
            fileBuffer.name = 'image.png'; // Identificador para a biblioteca GramJS
            
            await clientToUse.sendFile(target, {
              file: fileBuffer,
              caption: messageToSend,
              forceDocument: false
            });
          } else {
            await clientToUse.sendMessage(target, { message: messageToSend });
          }
          
          // Atualiza estatísticas de sucesso
          cmp.sentCount = (cmp.sentCount || 0) + 1;
          cmp.currentTargetIndex = currentIdx + 1;
          
          // Calcula próximo envio com delay + variação humana em MINUTOS
          const baseDelayMin = Number(cmp.delay || 1);
          const randomDelayMin = Number(cmp.randomDelay || 0);
          const actualDelayMin = baseDelayMin + (Math.random() * randomDelayMin);
          const finalDelay = Math.max(10000, actualDelayMin * 60 * 1000); // mínimo de 10s de segurança
          
          cmp.nextSendAt = new Date(Date.now() + finalDelay).toISOString();
          await db.saveCampaign(cmp);
          
          await db.addLog({
            campaignId: cmp.id,
            campaignName: cmp.name,
            accountPhone: phoneToUse,
            target: target,
            status: 'success',
            error: null,
            userId: cmp.userId
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
              error: `Bloqueio de envio temporário (Flood Wait) de ${seconds} segundos. O sistema aguardará.`,
              userId: cmp.userId
            });
            
            // Adia a campanha pelo tempo do bloqueio + 30s de segurança
            cmp.nextSendAt = new Date(Date.now() + (seconds + 30) * 1000).toISOString();
            await db.saveCampaign(cmp);
          } else {
            // Outros erros (ex: username inválido ou chat restrito).
            // Avança para o próximo alvo para não travar a campanha inteira!
            cmp.currentTargetIndex = currentIdx + 1;
            
            const delayMs = (cmp.delay || 1) * 60 * 1000;
            cmp.nextSendAt = new Date(Date.now() + delayMs).toISOString();
            await db.saveCampaign(cmp);
            
            await db.addLog({
              campaignId: cmp.id,
              campaignName: cmp.name,
              accountPhone: phoneToUse,
              target: target,
              status: 'failed',
              error: `Erro ao enviar: ${err.message}`,
              userId: cmp.userId
            });
          }
        }
      }
    }
  } catch (schedulerErr) {
    console.error('[Agendador] Erro interno fatal:', schedulerErr);
  } finally {
    isSchedulerRunning = false;
  }
}

// Inicia loop do agendador a cada 10 segundos
setInterval(runScheduler, 10000);

// =============================================================
// ROTAS DE AUTENTICAÇÃO (com rate limiting — A2)
// =============================================================
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, password } = req.body;

  // M3: Validação de entradas
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Usuário deve ter pelo menos 3 caracteres.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const existing = await db.getUserByUsername(username.trim());
    if (existing) {
      return res.status(400).json({ error: 'Este nome de usuário já está em uso.' });
    }

    const newUser = {
      id: uuidv4(),
      username: username.trim().toLowerCase(),
      password: hashPassword(password), // C2: bcrypt
      createdAt: new Date().toISOString()
    };

    await db.saveUser(newUser);
    const token = generateToken({ id: newUser.id, username: newUser.username });
    res.json({ token, user: { id: newUser.id, username: newUser.username } });
  } catch (err) {
    console.error('[Auth] Erro no registro:', err.message); // M4: log apenas no servidor
    res.status(500).json({ error: 'Erro interno ao criar conta. Tente novamente.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;

  // M3: Validação de entradas
  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  try {
    const user = await db.getUserByUsername(username.trim());
    // C2: verifyPassword suporta bcrypt (novo) e SHA-256 (legado)
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    // Migração automática: re-hash com bcrypt se ainda for SHA-256
    if (user.password && !user.password.startsWith('$2')) {
      user.password = hashPassword(password);
      await db.saveUser(user).catch(e => console.error('[Auth] Erro ao migrar hash:', e.message));
    }

    const token = generateToken({ id: user.id, username: user.username });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('[Auth] Erro no login:', err.message); // M4: sem vazamento de detalhes
    res.status(500).json({ error: 'Erro interno ao realizar login. Tente novamente.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

// -------------------------------------------------------------
// ROTAS DE CONFIGURAÇÕES E ESTATÍSTICAS
// -------------------------------------------------------------
app.get('/api/settings', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  res.json(settings);
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { defaultApiId, defaultApiHash, useCustomApi, customApiId, customApiHash } = req.body;
  const saved = await db.saveSettings({ defaultApiId, defaultApiHash, useCustomApi, customApiId, customApiHash });
  res.json(saved);
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const accounts = await db.getAccountsByUserId(userId);
  const campaigns = await db.getCampaignsByUserId(userId);
  const logs = await db.getLogsByUserId(userId);
  
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
app.get('/api/accounts', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const accounts = await db.getAccountsByUserId(userId);
  // Retorna com status de ativação em memória atualizado
  const mapped = accounts.map(acc => ({
    ...acc,
    isOnline: activeClients.has(cleanPhone(acc.phone))
  }));
  res.json(mapped);
});

app.delete('/api/accounts/:phone', requireAuth, async (req, res) => {
  const { phone } = req.params;
  const userId = req.user.id;
  
  const account = await db.getAccountByPhone(phone);
  if (!account || account.userId !== userId) {
    return res.status(403).json({ error: 'Você não tem permissão para desconectar esta conta.' });
  }

  // Desconecta o cliente em memória se houver
  const cleaned = cleanPhone(phone);
  if (activeClients.has(cleaned)) {
    try {
      const client = activeClients.get(cleaned);
      await client.disconnect();
      activeClients.delete(cleaned);
    } catch (e) {
      console.error(e);
    }
  }
  
  await db.deleteAccount(phone);
  res.json({ success: true, message: `Conta +${phone} desconectada e deletada.` });
});

// Buscar todos os grupos, canais, chats de conversa e bots de uma conta ativa
app.get('/api/accounts/:phone/groups', requireAuth, async (req, res) => {
  const { phone } = req.params;
  const userId = req.user.id;

  const account = await db.getAccountByPhone(phone);
  if (!account || account.userId !== userId) {
    return res.status(403).json({ error: 'Você não tem permissão para acessar os grupos desta conta.' });
  }

  const client = activeClients.get(cleanPhone(phone));
  
  if (!client) {
    return res.status(400).json({ error: 'Esta conta do Telegram não está conectada ou ativa no momento.' });
  }
  
  try {
    const dialogs = await client.getDialogs({ limit: 150 });
    const groups = dialogs.map(d => {
      let type = 'chat'; // conversa privada padrão
      if (d.isUser) {
        if (d.entity && d.entity.bot) {
          type = 'bot';
        } else {
          type = 'chat';
        }
      } else if (d.isGroup) {
        type = 'group';
      } else if (d.isChannel) {
        type = 'channel';
      }
      
      let name = 'Sem Nome';
      if (d.isUser) {
        name = `${d.entity?.firstName || ''} ${d.entity?.lastName || ''}`.trim() || 'Conversa Sem Nome';
      } else {
        name = d.title || 'Grupo Sem Nome';
      }

      // Detecção de restrição de envio de mídia (fotos/imagens)
      let restrictsMedia = false;
      if (!d.isUser && d.entity) {
        const entity = d.entity;
        const isAdmin = entity.creator || entity.admin || !!entity.adminRights;
        if (!isAdmin) {
          const hasBannedMedia = entity.bannedRights && entity.bannedRights.sendMedia;
          const hasDefaultBannedMedia = entity.defaultBannedRights && entity.defaultBannedRights.sendMedia;
          if (hasBannedMedia || hasDefaultBannedMedia) {
            restrictsMedia = true;
          }
        }
      }
      
      return {
        id: d.id.toString(),
        name: name,
        title: name, // Compatibilidade com frontend anterior
        username: d.entity && d.entity.username ? d.entity.username : null,
        type: type,
        restrictsMedia: restrictsMedia
      };
    });
      
    res.json(groups);
  } catch (err) {
    console.error(`[Groups] Erro ao buscar chats para +${phone}:`, err.message);
    res.status(500).json({ error: `Erro ao carregar chats: ${err.message}` });
  }
});

// -------------------------------------------------------------
// FLUXO DE LOGIN ASSÍNCRONO POR NÚMERO (SMS)
// -------------------------------------------------------------
app.post('/api/accounts/connect/phone/start', requireAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número de telefone é obrigatório.' });
  
  const settings = await db.getSettings();
  const cleanPhone = phone.replace(/[^\d+]/g, ''); // mantém apenas números e +
  
  const sessionId = uuidv4();
  const stringSession = new StringSession("");
  const creds = getTelegramCredentials(settings);
  const client = new TelegramClient(stringSession, creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    autoReconnect: true
  });
  
  const pendingConn = {
    sessionId,
    type: 'phone',
    client,
    phone: cleanPhone,
    status: 'connecting',
    userId: req.user.id, // Vínculo com o usuário logado
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
    const fullName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || 'Sem Nome';
    
    // Salva no Banco de Dados
    await db.saveAccount({
      phone: me.phone,
      name: fullName,
      firstName: me.firstName || 'Sem Nome',
      lastName: me.lastName || '',
      username: me.username || '',
      session: client.session.save(),
      connectedAt: new Date().toISOString(),
      status: 'connected',
      userId: pendingConn.userId // Vincula a conta ao usuário
    });
    
    // Armazena no cache de conexões ativas
    activeClients.set(cleanPhone(me.phone), client);
    console.log(`[Auth Phone] Conta +${me.phone} autenticada com sucesso!`);
    
    // M8: Limpa a conexão pendente após 5 minutos (com disconnect seguro)
    setTimeout(async () => {
      try { await client.disconnect(); } catch(e) {}
      pendingConnections.delete(sessionId);
    }, 5 * 60 * 1000);
  }).catch(err => {
    console.error(`[Auth Phone Catch Error]:`, err.message);
    pendingConn.status = 'error';
    pendingConn.error = err.message;
    setTimeout(async () => {
      try { await client.disconnect(); } catch(e) {}
      pendingConnections.delete(sessionId);
    }, 5 * 60 * 1000);
  });
  
  res.json({ sessionId, status: 'connecting' });
});

// Envio de código recebido
app.post('/api/accounts/connect/phone/submit-code', requireAuth, async (req, res) => {
  const { sessionId, code } = req.body;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) return res.status(404).json({ error: 'Sessão de conexão expirada ou inválida.' });
  if (conn.userId !== req.user.id) return res.status(403).json({ error: 'Acesso negado.' });
  if (conn.status !== 'awaiting_code') return res.status(400).json({ error: 'A conexão não está aguardando código no momento.' });
  
  conn.phoneCodeDeferred.resolve(code);
  res.json({ success: true, message: 'Código recebido pelo servidor, processando...' });
});

// Envio de senha 2FA recebida
app.post('/api/accounts/connect/phone/submit-password', requireAuth, async (req, res) => {
  const { sessionId, password } = req.body;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) return res.status(404).json({ error: 'Sessão de conexão expirada ou inválida.' });
  if (conn.userId !== req.user.id) return res.status(403).json({ error: 'Acesso negado.' });
  if (conn.status !== 'awaiting_password') return res.status(400).json({ error: 'A conexão não está aguardando senha 2FA no momento.' });
  
  conn.passwordDeferred.resolve(password);
  res.json({ success: true, message: 'Senha 2FA recebida pelo servidor, processando...' });
});

// -------------------------------------------------------------
// FLUXO DE LOGIN ASSÍNCRONO POR QR CODE
// -------------------------------------------------------------
app.post('/api/accounts/connect/qr/start', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  const sessionId = uuidv4();
  const stringSession = new StringSession("");
  const creds = getTelegramCredentials(settings);
  const client = new TelegramClient(stringSession, creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    autoReconnect: true
  });
  
  const pendingConn = {
    sessionId,
    type: 'qr',
    client,
    phone: null,
    status: 'connecting',
    userId: req.user.id, // Vínculo com o usuário logado
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
      { apiId: creds.apiId, apiHash: creds.apiHash },
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
    const fullName = `${me.firstName || ''} ${me.lastName || ''}`.trim() || 'Sem Nome';
    
    // Salva no Banco de Dados
    await db.saveAccount({
      phone: me.phone,
      name: fullName,
      firstName: me.firstName || 'Sem Nome',
      lastName: me.lastName || '',
      username: me.username || '',
      session: client.session.save(),
      connectedAt: new Date().toISOString(),
      status: 'connected',
      userId: pendingConn.userId // Vincula a conta ao usuário
    });
    
    // Armazena no cache de conexões ativas
    activeClients.set(cleanPhone(me.phone), client);
    console.log(`[Auth QR] Conta +${me.phone} autenticada via QR com sucesso!`);
    
    // M8: Limpa a conexão pendente após 5 minutos (com disconnect seguro)
    setTimeout(async () => {
      try { await client.disconnect(); } catch(e) {}
      pendingConnections.delete(sessionId);
    }, 5 * 60 * 1000);
  }).catch(err => {
    console.error(`[Auth QR Catch Error]:`, err.message);
    pendingConn.status = 'error';
    pendingConn.error = err.message;
    setTimeout(async () => {
      try { await client.disconnect(); } catch(e) {}
      pendingConnections.delete(sessionId);
    }, 5 * 60 * 1000);
  });
  
  res.json({ sessionId, status: 'connecting' });
});

// Consulta de status de conexões pendentes (Tanto QR quanto Telefone utilizam esta rota!)
app.get('/api/accounts/connect/status', requireAuth, async (req, res) => {
  const { sessionId } = req.query;
  const conn = pendingConnections.get(sessionId);
  
  if (!conn) {
    return res.status(404).json({ error: 'Sessão expirada ou não encontrada.' });
  }
  
  if (conn.userId !== req.user.id) {
    return res.status(403).json({ error: 'Acesso negado.' });
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
app.get('/api/campaigns', requireAuth, async (req, res) => {
  const campaigns = await db.getCampaignsByUserId(req.user.id);
  res.json(campaigns);
});

app.post('/api/campaigns', requireAuth, async (req, res) => {
  const { id, name, accounts, targetsText, message, delay, randomDelay, loop } = req.body;
  const userId = req.user.id;

  // M3: Validação de entradas obrigatórias
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
  }
  if (!targetsText || typeof targetsText !== 'string') {
    return res.status(400).json({ error: 'Lista de alvos é obrigatória.' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem da campanha é obrigatória.' });
  }
  const parsedDelay = Number(delay);
  if (isNaN(parsedDelay) || parsedDelay < 1) {
    return res.status(400).json({ error: 'Intervalo inválido. Mínimo de 1 minuto.' });
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Selecione pelo menos uma conta de disparo.' });
  }
  
  let existing = null;
  if (id) {
    existing = await db.getCampaignById(id);
    if (!existing || existing.userId !== userId) {
      return res.status(403).json({ error: 'Você não tem permissão para editar esta campanha.' });
    }
  }
  
  // Converte a caixa de texto de alvos em um array limpo
  const targets = targetsText
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0);
    
  const campaign = {
    id: id || uuidv4(),
    name: name.trim(),
    accounts: accounts,
    targets: targets,
    targetsText: targetsText,
    message: message,
    delay: parsedDelay,
    randomDelay: Number(randomDelay) || 0,
    loop: !!loop,
    userId: userId,
    status: existing ? existing.status || 'paused' : 'paused',
    sentCount: existing ? existing.sentCount || 0 : 0,
    failedCount: existing ? existing.failedCount || 0 : 0,
    currentTargetIndex: existing ? existing.currentTargetIndex || 0 : 0,
    createdAt: existing ? existing.createdAt || new Date().toISOString() : new Date().toISOString(),
    nextSendAt: existing ? existing.nextSendAt : null
  };
  
  try {
    const saved = await db.saveCampaign(campaign);
    res.json(saved);
  } catch (err) {
    console.error('[Campanhas] Erro ao salvar:', err.message);
    res.status(500).json({ error: 'Erro interno ao salvar a campanha. Tente novamente.' });
  }
});

app.delete('/api/campaigns/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const cmp = await db.getCampaignById(id);
  if (!cmp || cmp.userId !== userId) {
    return res.status(403).json({ error: 'Você não tem permissão para deletar esta campanha.' });
  }

  await db.deleteCampaign(id);
  res.json({ success: true, message: 'Campanha deletada.' });
});

app.post('/api/campaigns/:id/toggle', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    const cmp = await db.getCampaignById(id);
    
    if (!cmp) return res.status(404).json({ error: 'Campanha não encontrada.' });
    if (cmp.userId !== userId) return res.status(403).json({ error: 'Você não tem permissão para gerenciar esta campanha.' });
    
    if (cmp.status === 'active') {
      cmp.status = 'paused';
      cmp.nextSendAt = null;
    } else {
      // M1: Salvar o status ANTES de sobrescrever para checar se era 'completed'
      const wasCompleted = cmp.status === 'completed';
      cmp.status = 'active';
      if (wasCompleted || cmp.currentTargetIndex >= (cmp.targets || []).length) {
        cmp.currentTargetIndex = 0;
        cmp.sentCount = 0;
        cmp.failedCount = 0;
      }
      cmp.nextSendAt = new Date(Date.now() + 5000).toISOString();
    }
    
    await db.saveCampaign(cmp);
    res.json(cmp);
  } catch (err) {
    console.error('[Toggle] Erro ao alterar status da campanha:', err.message);
    res.status(500).json({ error: 'Erro interno ao alterar status da campanha.' });
  }
});

// -------------------------------------------------------------
// ROTAS DE LOGS
// -------------------------------------------------------------
app.get('/api/logs', requireAuth, async (req, res) => {
  const logs = await db.getLogsByUserId(req.user.id);
  res.json(logs);
});

app.post('/api/logs/clear', requireAuth, async (req, res) => {
  await db.clearLogsByUserId(req.user.id);
  res.json({ success: true });
});

// Servir frontend React em produção (fallback para SPA React Router)
// B7: fs importado no topo do arquivo — não mais require() dentro de handler
app.get('*', (req, res) => {
  const indexHtml = path.join(__dirname, '../frontend/dist/index.html');
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.json({ status: 'online', message: 'DIVUGA Telegram API Server' });
  }
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
