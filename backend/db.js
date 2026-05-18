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
    defaultApiId: '22839958',
    defaultApiHash: 'c66c303f2603cd71110023a7c640e34c'
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

const db = {
  // Configurações
  getSettings: async () => {
    const data = await load();
    return {
      defaultApiId: process.env.TELEGRAM_API_ID || data.settings.defaultApiId,
      defaultApiHash: process.env.TELEGRAM_API_HASH || data.settings.defaultApiHash
    };
  },
  saveSettings: async (settings) => {
    const data = await load();
    data.settings = { ...data.settings, ...settings };
    await save();
    return {
      defaultApiId: process.env.TELEGRAM_API_ID || data.settings.defaultApiId,
      defaultApiHash: process.env.TELEGRAM_API_HASH || data.settings.defaultApiHash
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
        const { data, error } = await supabase.from('campaigns').select('*');
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanhas:', err.message);
      }
    }
    const data = await load();
    return data.campaigns;
  },
  getCampaignById: async (id) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return data || null;
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanha por ID:', err.message);
      }
    }
    const data = await load();
    return data.campaigns.find(c => c.id === id);
  },
  saveCampaign: async (campaign) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').upsert({
          id: campaign.id,
          name: campaign.name,
          userId: campaign.userId,
          status: campaign.status,
          message: campaign.message,
          interval: campaign.interval,
          groups: typeof campaign.groups === 'string' ? JSON.parse(campaign.groups) : campaign.groups,
          accounts: typeof campaign.accounts === 'string' ? JSON.parse(campaign.accounts) : campaign.accounts,
          createdAt: campaign.createdAt || new Date().toISOString(),
          lastRun: campaign.lastRun
        }).select().single();
        if (error) throw error;
        return data;
      } catch (err) {
        console.error('[Supabase] Erro ao salvar campanha:', err.message);
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
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar logs:', err.message);
      }
    }
    const data = await load();
    return data.logs;
  },
  addLog: async (log) => {
    const id = Math.random().toString(36).substr(2, 9);
    const timestamp = new Date().toISOString();
    const newLog = {
      id,
      timestamp,
      ...log
    };

    if (supabase) {
      try {
        const { data, error } = await supabase.from('logs').insert({
          id: newLog.id,
          userId: newLog.userId,
          campaignId: newLog.campaignId,
          phone: newLog.phone,
          group: newLog.group,
          status: newLog.status,
          message: newLog.message,
          error: newLog.error,
          timestamp: newLog.timestamp
        }).select().single();
        if (error) throw error;
        return data;
      } catch (err) {
        console.error('[Supabase] Erro ao adicionar log:', err.message);
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
      }
    }
    const data = await load();
    return data.users || [];
  },
  getUserByUsername: async (username) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('users').select('*').ilike('username', username).maybeSingle();
        if (error) throw error;
        return data || null;
      } catch (err) {
        console.error('[Supabase] Erro ao buscar usuário por username:', err.message);
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
      }
    }
    const data = await load();
    return (data.accounts || []).filter(a => a.userId === userId);
  },
  getCampaignsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('campaigns').select('*').eq('userId', userId);
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar campanhas por usuário:', err.message);
      }
    }
    const data = await load();
    return (data.campaigns || []).filter(c => c.userId === userId);
  },
  getLogsByUserId: async (userId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('logs').select('*').eq('userId', userId).order('timestamp', { ascending: false });
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error('[Supabase] Erro ao buscar logs por usuário:', err.message);
      }
    }
    const data = await load();
    return (data.logs || []).filter(l => l.userId === userId);
  }
};

module.exports = db;
