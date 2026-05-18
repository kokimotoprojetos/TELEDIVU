require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DB_PATH = path.join(__dirname, 'db.json');

// Estrutura inicial do banco de dados local
const INITIAL_DATA = {
  accounts: [],
  campaigns: [],
  logs: [],
  users: [],
  settings: {
    defaultApiId: '31992404',
    defaultApiHash: '29d0d2dc1ac01f98aefed17f7e017edf',
    useCustomApi: false,
    customApiId: '',
    customApiHash: ''
  }
};

let dataInMemory = null;
let isWriting = false;
let writeQueue = [];

async function load() {
  if (dataInMemory) return dataInMemory;
  try {
    const fileExists = await fs.access(DB_PATH).then(() => true).catch(() => false);
    if (!fileExists) {
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
      await fs.writeFile(DB_PATH, JSON.stringify(INITIAL_DATA, null, 2), 'utf-8');
      dataInMemory = JSON.parse(JSON.stringify(INITIAL_DATA));
      return dataInMemory;
    }
    const raw = await fs.readFile(DB_PATH, 'utf-8');
    dataInMemory = JSON.parse(raw);
    if (!dataInMemory.accounts) dataInMemory.accounts = [];
    if (!dataInMemory.campaigns) dataInMemory.campaigns = [];
    if (!dataInMemory.logs) dataInMemory.logs = [];
    if (!dataInMemory.users) dataInMemory.users = [];
    if (!dataInMemory.settings) dataInMemory.settings = { ...INITIAL_DATA.settings };
    return dataInMemory;
  } catch (err) {
    console.error('Erro ao carregar banco de dados JSON, reiniciando...', err);
    dataInMemory = JSON.parse(JSON.stringify(INITIAL_DATA));
    return dataInMemory;
  }
}

async function save() {
  if (!dataInMemory) return;
  if (isWriting) {
    return new Promise((resolve, reject) => {
      writeQueue.push({ resolve, reject });
    });
  }
  isWriting = true;
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(dataInMemory, null, 2), 'utf-8');
    isWriting = false;
    if (writeQueue.length > 0) {
      const next = writeQueue.shift();
      save().then(next.resolve).catch(next.reject);
    }
  } catch (err) {
    isWriting = false;
    console.error('Erro ao salvar no arquivo db.json', err);
    if (writeQueue.length > 0) {
      const next = writeQueue.shift();
      next.reject(err);
    }
    throw err;
  }
}

// Configuração Supabase com Fallback
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey && !supabaseUrl.includes('sua-url-do-supabase')) {
  console.log('[Supabase] Credenciais detectadas. Inicializando cliente Supabase...');
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn('[Supabase] Credenciais ausentes ou não configuradas em .env. Usando db.json local como fallback.');
}

function deserializeCampaign(c) {
  if (!c) return null;
  let text = c.message || '';
  let image = null;
  let loop = false;
  let randomDelay = 0;
  let sentCount = 0;
  let failedCount = 0;
  let currentTargetIndex = 0;
  let nextSendAt = null;
  
  if (c.message && c.message.startsWith('{') && c.message.endsWith('}')) {
    try {
      const parsed = JSON.parse(c.message);
      text = parsed.text || '';
      image = parsed.image || null;
      loop = parsed.loop !== undefined ? !!parsed.loop : false;
      randomDelay = parsed.randomDelay !== undefined ? Number(parsed.randomDelay) : 0;
      sentCount = parsed.sentCount !== undefined ? Number(parsed.sentCount) : 0;
      failedCount = parsed.failedCount !== undefined ? Number(parsed.failedCount) : 0;
      currentTargetIndex = parsed.currentTargetIndex !== undefined ? Number(parsed.currentTargetIndex) : 0;
      nextSendAt = parsed.nextSendAt !== undefined ? parsed.nextSendAt : null;
    } catch (e) {
      // mantém como texto plano
    }
  }
  
  const groupsList = c.groups || [];
  
  return {
    ...c,
    message: c.message,
    textMessage: text,
    image: image,
    loop: loop,
    randomDelay: randomDelay,
    sentCount: sentCount,
    failedCount: failedCount,
    currentTargetIndex: currentTargetIndex,
    nextSendAt: nextSendAt,
    targets: groupsList,
    targetsText: groupsList.join('\n'),
    delay: c.interval || 60
  };
}

const db = {
  // Configurações
  getSettings: async () => {
    const data = await load();
    return {
      // CORRIGIDO: não expor credenciais padrão do Telegram nas configurações retornadas.
      // As credenciais padrão são resolvidas internamente em getTelegramCredentials().
      defaultApiId: data.settings.defaultApiId || '',
      defaultApiHash: '', // nunca retornar o hash padrão via API
      useCustomApi: !!data.settings.useCustomApi,
      customApiId: data.settings.customApiId || '',
      customApiHash: data.settings.customApiHash || ''
    };
  },
  saveSettings: async (settings) => {
    const data = await load();
    data.settings = { ...data.settings, ...settings };
    await save();
    return {
      defaultApiId: process.env.TELEGRAM_API_ID || data.settings.defaultApiId || '31992404',
      defaultApiHash: process.env.TELEGRAM_API_HASH || data.settings.defaultApiHash || '29d0d2dc1ac01f98aefed17f7e017edf',
      useCustomApi: !!data.settings.useCustomApi,
      customApiId: data.settings.customApiId || '',
      customApiHash: data.settings.customApiHash || ''
    };
  },

  // Contas
  getAccounts: async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('accounts').select('*');
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar contas:', err.message);
        throw err;
      }
    }
    const data = await load();
    return data.accounts;
  },
  getAccountByPhone: async (phone) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('accounts').select('*').eq('phone', phone).maybeSingle();
        if (error) throw error;
        return data || null;
      } catch (err) {
        console.error('[Supabase] Erro ao buscar conta por telefone:', err.message);
        throw err;
      }
    }
    const data = await load();
    return data.accounts.find(a => a.phone === phone);
  },
  saveAccount: async (account) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('accounts').upsert({
          phone: account.phone,
          session: account.session,
          userId: account.userId,
          apiId: account.apiId,
          apiHash: account.apiHash,
          status: account.status,
          name: account.name,
          username: account.username,
          createdAt: account.createdAt || new Date().toISOString()
        }).select().single();
        if (error) throw error;
        return data;
      } catch (err) {
        console.error('[Supabase] Erro ao salvar conta:', err.message);
        throw err;
      }
    }
    const data = await load();
    const idx = data.accounts.findIndex(a => a.phone === account.phone);
    if (idx >= 0) {
      data.accounts[idx] = { ...data.accounts[idx], ...account };
    } else {
      data.accounts.push(account);
    }
    await save();
    return account;
  },
  deleteAccount: async (phone) => {
    if (supabase) {
      try {
        const { error } = await supabase.from('accounts').delete().eq('phone', phone);
        if (error) throw error;
        return;
      } catch (err) {
        console.error('[Supabase] Erro ao excluir conta:', err.message);
        throw err;
      }
    }
    const data = await load();
    data.accounts = data.accounts.filter(a => a.phone !== phone);
    await save();
  },

  // Campanhas
  getCampaigns: async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').select('*').order('createdAt', { ascending: true });
        if (error) throw error;
        return (data || []).map(deserializeCampaign);
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanhas:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.campaigns || []).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },
  getCampaignById: async (id) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return deserializeCampaign(data);
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanha por ID:', err.message);
        throw err;
      }
    }
    const data = await load();
    return data.campaigns.find(c => c.id === id);
  },
  saveCampaign: async (campaign) => {
    if (supabase) {
      try {
        const intervalValue = Number(campaign.interval || campaign.delay || 60);
        const groupsValue = campaign.groups || campaign.targets || [];
        
        let textValue = campaign.message || '';
        let imageValue = campaign.image || null;
        
        if (campaign.message && campaign.message.startsWith('{') && campaign.message.endsWith('}')) {
          try {
            const parsedMsg = JSON.parse(campaign.message);
            textValue = parsedMsg.text || textValue;
            imageValue = parsedMsg.image || imageValue;
          } catch (e) {
            // mantém
          }
        }
        
        let msgObj = {
          text: textValue,
          image: imageValue,
          loop: !!campaign.loop,
          randomDelay: Number(campaign.randomDelay || 0),
          sentCount: Number(campaign.sentCount || 0),
          failedCount: Number(campaign.failedCount || 0),
          currentTargetIndex: Number(campaign.currentTargetIndex || 0),
          nextSendAt: campaign.nextSendAt || null
        };
        
        const serializedMessage = JSON.stringify(msgObj);
        
        const { data, error } = await supabase.from('campaigns').upsert({
          id: campaign.id,
          name: campaign.name,
          userId: campaign.userId,
          status: campaign.status,
          message: serializedMessage,
          interval: intervalValue,
          groups: typeof groupsValue === 'string' ? JSON.parse(groupsValue) : groupsValue,
          accounts: typeof campaign.accounts === 'string' ? JSON.parse(campaign.accounts) : campaign.accounts,
          createdAt: campaign.createdAt || new Date().toISOString(),
          lastRun: campaign.lastRun
        }).select().single();
        if (error) throw error;
        return deserializeCampaign(data);
      } catch (err) {
        console.error('[Supabase] Erro ao salvar campanha:', err.message);
        throw err;
      }
    }
    const data = await load();
    const idx = data.campaigns.findIndex(c => c.id === campaign.id);
    if (idx >= 0) {
      data.campaigns[idx] = { ...data.campaigns[idx], ...campaign };
    } else {
      data.campaigns.push(campaign);
    }
    await save();
    return campaign;
  },
  deleteCampaign: async (id) => {
    if (supabase) {
      try {
        const { error } = await supabase.from('campaigns').delete().eq('id', id);
        if (error) throw error;
        return;
      } catch (err) {
        console.error('[Supabase] Erro ao excluir campanha:', err.message);
        throw err;
      }
    }
    const data = await load();
    data.campaigns = data.campaigns.filter(c => c.id !== id);
    await save();
  },

  // Logs
  getLogs: async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('logs').select('*').order('timestamp', { ascending: false });
        if (error) throw error;
        return (data || []).map(l => {
          const isSys = l.campaignId === 'system' || l.campaignName === 'Sistema';
          return {
            ...l,
            accountPhone: l.phone || (isSys ? 'Sistema' : 'Desconhecido'),
            target: l.group || (isSys ? 'Sistema' : 'Desconhecido')
          };
        });
      } catch (err) {
        console.error('[Supabase] Erro ao buscar logs:', err.message);
        throw err;
      }
    }
    const data = await load();
    return data.logs;
  },
  addLog: async (log) => {
    // CORRIGIDO: Math.random() não é criptograficamente seguro para IDs.
    // Colissões são possíveis com ~50k registros. Usando crypto.randomUUID().
    const id = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const timestamp = new Date().toISOString();
    
    const isSys = log.campaignId === 'system' || log.campaignName === 'Sistema';
    const phoneValue = log.phone || log.accountPhone || (isSys ? 'Sistema' : 'Desconhecido');
    const groupValue = log.group || log.target || (isSys ? 'Sistema' : 'Desconhecido');
    
    const newLog = {
      id,
      timestamp,
      ...log,
      phone: phoneValue,
      group: groupValue,
      accountPhone: phoneValue,
      target: groupValue
    };

    if (supabase) {
      try {
        const { data, error } = await supabase.from('logs').insert({
          id: newLog.id,
          userId: newLog.userId,
          campaignId: newLog.campaignId,
          phone: phoneValue,
          group: groupValue,
          status: newLog.status,
          message: newLog.message || '',
          error: newLog.error,
          timestamp: newLog.timestamp
        }).select().single();
        if (error) throw error;
        return {
          ...data,
          accountPhone: data.phone,
          target: data.group
        };
      } catch (err) {
        console.error('[Supabase] Erro ao adicionar log:', err.message);
        throw err;
      }
    }

    const data = await load();
    data.logs.unshift(newLog);
    if (data.logs.length > 1000) {
      data.logs = data.logs.slice(0, 1000);
    }
    await save();
    return newLog;
  },
  clearLogs: async () => {
    if (supabase) {
      try {
        const { error } = await supabase.from('logs').delete().neq('id', '');
        if (error) throw error;
        return;
      } catch (err) {
        console.error('[Supabase] Erro ao limpar logs:', err.message);
        throw err;
      }
    }
    const data = await load();
    data.logs = [];
    await save();
  },
  clearLogsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { error } = await supabase.from('logs').delete().eq('userId', userId);
        if (error) throw error;
        return;
      } catch (err) {
        console.error('[Supabase] Erro ao limpar logs por usuário:', err.message);
        throw err;
      }
    }
    const data = await load();
    data.logs = data.logs.filter(l => l.userId !== userId);
    await save();
  },

  // Usuários
  getUsers: async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('users').select('*');
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar usuários:', err.message);
        throw err;
      }
    }
    const data = await load();
    return data.users || [];
  },
  getUserByUsername: async (username) => {
    if (supabase) {
      try {
        // CORRIGIDO: ilike faz match case-insensitive no PostgreSQL, mas não garante
        // consistência com o .toLowerCase() usado no registro. Usar .eq() com o
        // username já normalizado (em minúsculo) garante comportamento previsível.
        const normalizedUsername = username.toLowerCase();
        const { data, error } = await supabase.from('users').select('*').eq('username', normalizedUsername).maybeSingle();
        if (error) throw error;
        return data || null;
      } catch (err) {
        console.error('[Supabase] Erro ao buscar usuário por username:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
  },
  getUserById: async (id) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return data || null;
      } catch (err) {
        console.error('[Supabase] Erro ao buscar usuário por ID:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.users || []).find(u => u.id === id);
  },
  saveUser: async (user) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('users').upsert({
          id: user.id,
          username: user.username,
          password: user.password,
          createdAt: user.createdAt
        }).select().single();
        if (error) throw error;
        console.log(`[Supabase] Usuário ${user.username} registrado com sucesso no Supabase.`);
        return data;
      } catch (err) {
        console.error('[Supabase] Erro ao salvar usuário no Supabase:', err.message);
        throw err;
      }
    }
    const data = await load();
    if (!data.users) data.users = [];
    const idx = data.users.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      data.users[idx] = { ...data.users[idx], ...user };
    } else {
      data.users.push(user);
    }
    await save();
    return user;
  },

  // Busca Filtrada por Usuário
  getAccountsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('accounts').select('*').eq('userId', userId);
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar contas por usuário:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.accounts || []).filter(a => a.userId === userId);
  },
  getCampaignsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').select('*').eq('userId', userId).order('createdAt', { ascending: true });
        if (error) throw error;
        return (data || []).map(deserializeCampaign);
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanhas por usuário:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.campaigns || [])
      .filter(c => c.userId === userId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },
  getLogsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('logs').select('*').eq('userId', userId).order('timestamp', { ascending: false });
        if (error) throw error;
        return (data || []).map(l => {
          const isSys = l.campaignId === 'system' || l.campaignName === 'Sistema';
          return {
            ...l,
            accountPhone: l.phone || (isSys ? 'Sistema' : 'Desconhecido'),
            target: l.group || (isSys ? 'Sistema' : 'Desconhecido')
          };
        });
      } catch (err) {
        console.error('[Supabase] Erro ao buscar logs por usuário:', err.message);
        throw err;
      }
    }
    const data = await load();
    return (data.logs || []).filter(l => l.userId === userId);
  }
};

module.exports = db;
