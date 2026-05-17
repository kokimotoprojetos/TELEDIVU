const fs = require('fs').promises;
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

// Estrutura inicial do banco de dados
const INITIAL_DATA = {
  accounts: [],
  campaigns: [],
  logs: [],
  settings: {
    defaultApiId: '22839958', // Api ID padrão para facilitar
    defaultApiHash: 'c66c303f2603cd71110023a7c640e34c' // Api Hash correspondente
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
      // Cria a pasta backend se não existir
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
      await fs.writeFile(DB_PATH, JSON.stringify(INITIAL_DATA, null, 2), 'utf-8');
      dataInMemory = JSON.parse(JSON.stringify(INITIAL_DATA));
      return dataInMemory;
    }

    const raw = await fs.readFile(DB_PATH, 'utf-8');
    dataInMemory = JSON.parse(raw);
    
    // Garantir que todas as chaves obrigatórias existem
    if (!dataInMemory.accounts) dataInMemory.accounts = [];
    if (!dataInMemory.campaigns) dataInMemory.campaigns = [];
    if (!dataInMemory.logs) dataInMemory.logs = [];
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
    
    // Processa o próximo da fila
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

// Funções utilitárias de manipulação

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
    const data = await load();
    return data.accounts;
  },
  getAccountByPhone: async (phone) => {
    const data = await load();
    return data.accounts.find(a => a.phone === phone);
  },
  saveAccount: async (account) => {
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
    const data = await load();
    data.accounts = data.accounts.filter(a => a.phone !== phone);
    await save();
  },

  // Campanhas
  getCampaigns: async () => {
    const data = await load();
    return data.campaigns;
  },
  getCampaignById: async (id) => {
    const data = await load();
    return data.campaigns.find(c => c.id === id);
  },
  saveCampaign: async (campaign) => {
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
    const data = await load();
    data.campaigns = data.campaigns.filter(c => c.id !== id);
    await save();
  },

  // Logs
  getLogs: async () => {
    const data = await load();
    return data.logs;
  },
  addLog: async (log) => {
    const data = await load();
    const newLog = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      ...log
    };
    data.logs.unshift(newLog); // Adiciona no início
    
    // Limita o histórico de logs a 1000 itens para não pesar o arquivo
    if (data.logs.length > 1000) {
      data.logs = data.logs.slice(0, 1000);
    }
    
    await save();
    return newLog;
  },
  clearLogs: async () => {
    const data = await load();
    data.logs = [];
    await save();
  }
};

module.exports = db;
