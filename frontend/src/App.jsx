import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000/api'
    : 'https://teledivu.onrender.com/api');

// Helper de requisições autenticadas com controle automático de 401
const authenticatedFetch = async (url, options = {}) => {
  const token = localStorage.getItem('divuga_token');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers
  });
  
  if (response.status === 401) {
    localStorage.removeItem('divuga_token');
    localStorage.removeItem('divuga_user');
    window.location.reload();
    throw new Error('Sessão expirada. Por favor, faça login novamente.');
  }
  
  return response;
};

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Controle de Sessão de Usuário
  const [token, setToken] = useState(localStorage.getItem('divuga_token') || '');
  const [currentUser, setCurrentUser] = useState(JSON.parse(localStorage.getItem('divuga_user') || 'null'));
  const [showRegister, setShowRegister] = useState(false);
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [stats, setStats] = useState({
    totalAccounts: 0,
    connectedAccounts: 0,
    totalCampaigns: 0,
    activeCampaigns: 0,
    totalSent: 0,
    totalFailed: 0
  });
  const [accounts, setAccounts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({
    defaultApiId: '',
    defaultApiHash: '',
    useCustomApi: false,
    customApiId: '',
    customApiHash: ''
  });

  // Modais
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [connectType, setConnectType] = useState('qr'); // 'qr' ou 'phone'
  const [isCampaignModalOpen, setIsCampaignModalOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);

  // Estados de Conexão de Conta
  const [phoneInput, setPhoneInput] = useState('');
  const [smsCodeInput, setSmsCodeInput] = useState('');
  const [password2faInput, setPassword2faInput] = useState('');
  const [connectionSessionId, setConnectionSessionId] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState(null); // 'connecting' | 'awaiting_scan' | 'awaiting_code' | 'awaiting_password' | 'success' | 'error'
  const [connectionError, setConnectionError] = useState(null);
  const [qrImage, setQrImage] = useState(null);

  // Formulário de Campanhas
  const [campaignForm, setCampaignForm] = useState({
    name: '',
    accounts: [],
    targetsText: '',
    message: '',
    image: null,
    delay: 60,
    randomDelay: 10,
    loop: false
  });

  const [availableGroups, setAvailableGroups] = useState([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [chatFilters, setChatFilters] = useState({
    group: true,
    channel: true,
    chat: false,
    bot: false
  });

  const [extractForm, setExtractForm] = useState({
    accountPhone: '',
    sourceGroup: '',
    targetGroup: '',
    limitMessages: 500,
    minInteractions: 1
  });
  const [extractGroups, setExtractGroups] = useState([]);
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const [extractError, setExtractError] = useState(null);

  const pollIntervalRef = useRef(null);
  const dataPollIntervalRef = useRef(null);

  useEffect(() => {
    if (extractForm.accountPhone) {
      const fetchExtractGroups = async (phone) => {
        try {
          const res = await authenticatedFetch(`${API_BASE}/accounts/${phone}/groups`);
          if (res.ok) {
            const data = await res.json();
            setExtractGroups(data);
          }
        } catch (err) {
          console.error(err);
        }
      };
      fetchExtractGroups(extractForm.accountPhone);
    } else {
      setExtractGroups([]);
    }
  }, [extractForm.accountPhone]);

  const handleExtractSubmit = async (e) => {
    e.preventDefault();
    setExtractError(null);
    setExtractResult(null);
    setExtractLoading(true);

    try {
      const res = await authenticatedFetch(`${API_BASE}/tools/extract-members`, {
        method: 'POST',
        body: JSON.stringify(extractForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro na extração.');
      setExtractResult(data);
    } catch (err) {
      setExtractError(err.message);
    } finally {
      setExtractLoading(false);
    }
  };

  // -------------------------------------------------------------
  // LÓGICA DE AUTENTICAÇÃO (SISTEMA DE LOGIN E REGISTRO)
  // -------------------------------------------------------------
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    const endpoint = showRegister ? 'register' : 'login';
    try {
      const res = await fetch(`${API_BASE}/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao realizar autenticação.');
      }
      
      localStorage.setItem('divuga_token', data.token);
      localStorage.setItem('divuga_user', JSON.stringify(data.user));
      setToken(data.token);
      setCurrentUser(data.user);
      setAuthForm({ username: '', password: '' });
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('divuga_token');
    localStorage.removeItem('divuga_user');
    setToken('');
    setCurrentUser(null);
    window.location.reload();
  };

  // -------------------------------------------------------------
  // CARREGAMENTO E SINC DE DADOS
  // -------------------------------------------------------------
  const fetchData = async () => {
    if (!localStorage.getItem('divuga_token')) return;
    try {
      const [statsRes, accountsRes, campaignsRes, logsRes] = await Promise.all([
        authenticatedFetch(`${API_BASE}/stats`),
        authenticatedFetch(`${API_BASE}/accounts`),
        authenticatedFetch(`${API_BASE}/campaigns`),
        authenticatedFetch(`${API_BASE}/logs`)
      ]);
      
      const statsData = await statsRes.json();
      setStats(statsData);

      const accountsData = await accountsRes.json();
      setAccounts(accountsData);

      const campaignsData = await campaignsRes.json();
      setCampaigns(campaignsData);

      const logsData = await logsRes.json();
      setLogs(logsData);
    } catch (err) {
      console.error('Erro ao buscar dados do backend:', err);
    }
  };

  const fetchSettings = async () => {
    if (!localStorage.getItem('divuga_token')) return;
    try {
      const res = await authenticatedFetch(`${API_BASE}/settings`);
      const data = await res.json();
      setSettings(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (token) {
      fetchData();
      fetchSettings();
      // Polling contínuo dos dados do Dashboard a cada 4 segundos
      dataPollIntervalRef.current = setInterval(fetchData, 4000);
    }

    return () => {
      if (dataPollIntervalRef.current) clearInterval(dataPollIntervalRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [token]);

  // Buscar grupos e canais das contas selecionadas para a campanha
  const fetchGroupsForAccounts = async (selectedPhones) => {
    // CORRIGIDO: removido console.log que expunha números de telefone no console do browser
    if (!selectedPhones || selectedPhones.length === 0) {
      setAvailableGroups([]);
      return;
    }
    
    setIsLoadingGroups(true);
    try {
      const fetchedGroups = [];
      const seenGroupIds = new Set();
      
      for (const phone of selectedPhones) {
        try {
          const url = `${API_BASE}/accounts/${phone}/groups`;
          console.log(`[TELEDIVU] Fazendo requisição para obter grupos da conta +${phone} na URL: ${url}`);
          const res = await authenticatedFetch(url);
          console.log(`[TELEDIVU] Resposta da API para +${phone} - Status: ${res.status}`);
          
          if (res.ok) {
            const data = await res.json();
            console.log(`[TELEDIVU] Grupos retornados para +${phone}:`, data.length, data);
            data.forEach(g => {
              const uniqueKey = g.username ? `@${g.username}` : g.id;
              if (!seenGroupIds.has(uniqueKey)) {
                seenGroupIds.add(uniqueKey);
                fetchedGroups.push(g);
              }
            });
          } else {
            const errData = await res.json().catch(() => ({}));
            console.error(`[TELEDIVU] Erro ao buscar grupos para +${phone}:`, errData);
          }
        } catch (err) {
          console.error(`[TELEDIVU] Falha de conexão ao buscar grupos para +${phone}:`, err);
        }
      }
      setAvailableGroups(fetchedGroups);
    } catch (err) {
      console.error('Erro ao processar busca de grupos:', err);
    } finally {
      setIsLoadingGroups(false);
    }
  };

  // Alterna a seleção de um grupo no textarea de alvos
  const handleGroupClick = (group) => {
    const targetValue = group.username ? `@${group.username}` : group.id;
    const currentTargets = campaignForm.targetsText
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);
      
    if (currentTargets.includes(targetValue)) {
      const updated = currentTargets.filter(t => t !== targetValue).join('\n');
      setCampaignForm({ ...campaignForm, targetsText: updated });
    } else {
      const updated = [...currentTargets, targetValue].join('\n');
      setCampaignForm({ ...campaignForm, targetsText: updated });
    }
  };

  useEffect(() => {
    if (isCampaignModalOpen && token) {
      fetchGroupsForAccounts(campaignForm.accounts);
    } else {
      setAvailableGroups([]);
    }
  }, [campaignForm.accounts, isCampaignModalOpen, token]);

  // -------------------------------------------------------------
  // FLUXO DE CONEXÃO E AUTENTICAÇÃO (TELEGRAM)
  // -------------------------------------------------------------
  const startQrConnection = async () => {
    setConnectionError(null);
    setConnectionStatus('connecting');
    setQrImage(null);
    try {
      const res = await authenticatedFetch(`${API_BASE}/accounts/connect/qr/start`, { method: 'POST' });
      const data = await res.json();
      setConnectionSessionId(data.sessionId);
      startStatusPolling(data.sessionId);
    } catch (err) {
      setConnectionStatus('error');
      setConnectionError('Não foi possível iniciar o login por QR Code.');
    }
  };

  const startPhoneConnection = async () => {
    if (!phoneInput) return alert('Por favor, digite o número do telefone.');
    setConnectionError(null);
    setConnectionStatus('connecting');
    try {
      const res = await authenticatedFetch(`${API_BASE}/accounts/connect/phone/start`, {
        method: 'POST',
        body: JSON.stringify({ phone: phoneInput })
      });
      const data = await res.json();
      setConnectionSessionId(data.sessionId);
      startStatusPolling(data.sessionId);
    } catch (err) {
      setConnectionStatus('error');
      setConnectionError('Não foi possível iniciar o login por número.');
    }
  };

  const submitSmsCode = async () => {
    if (!smsCodeInput) return;
    try {
      await authenticatedFetch(`${API_BASE}/accounts/connect/phone/submit-code`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: connectionSessionId, code: smsCodeInput })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const submitPassword2fa = async () => {
    if (!password2faInput) return;
    const passwordToSend = password2faInput;
    setPassword2faInput(''); // M7: Limpar campo imediatamente antes de enviar
    try {
      await authenticatedFetch(`${API_BASE}/accounts/connect/phone/submit-password`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: connectionSessionId, password: passwordToSend })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const startStatusPolling = (sessionId) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        // CORRIGIDO: sessionId movido para o corpo da requisição (POST) para não
        // aparecer nos logs de acesso do servidor (URL query params são logados).
        const res = await authenticatedFetch(`${API_BASE}/accounts/connect/status`, {
          method: 'POST',
          body: JSON.stringify({ sessionId })
        });
        const data = await res.json();
        
        setConnectionStatus(data.status);
        if (data.qrImage) setQrImage(data.qrImage);
        if (data.error) setConnectionError(data.error);

        if (data.status === 'success') {
          clearInterval(pollIntervalRef.current);
          fetchData();
          setTimeout(() => {
            closeConnectModal();
          }, 2000);
        }

        if (data.status === 'error') {
          clearInterval(pollIntervalRef.current);
        }
      } catch (err) {
        console.error(err);
      }
    }, 2500); // CORRIGIDO: reduzido de 1500ms para 2500ms (menos carga no servidor)
  };

  const closeConnectModal = () => {
    setIsConnectModalOpen(false);
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setConnectionSessionId(null);
    setConnectionStatus(null);
    setConnectionError(null);
    setPhoneInput('');
    setSmsCodeInput('');
    setPassword2faInput('');
    setQrImage(null);
  };

  const deleteAccount = async (phone) => {
    if (window.confirm(`Deseja realmente desconectar e remover a conta +${phone}?`)) {
      try {
        await authenticatedFetch(`${API_BASE}/accounts/${phone}`, { method: 'DELETE' });
        fetchData();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // -------------------------------------------------------------
  // CONTROLE DE CAMPANHAS
  // -------------------------------------------------------------
  const openCampaignModal = (campaign = null) => {
    if (campaign) {
      setEditingCampaign(campaign);
      
      let msgText = campaign.message || '';
      let msgImage = null;
      if (msgText.startsWith('{') && msgText.endsWith('}')) {
        try {
          const parsed = JSON.parse(msgText);
          msgText = parsed.text || '';
          msgImage = parsed.image || null;
        } catch (e) {
          // Mantém mensagem original se falhar
        }
      }
      
      setCampaignForm({
        name: campaign.name,
        accounts: campaign.accounts,
        targetsText: campaign.targetsText || campaign.targets.join('\n'),
        message: msgText,
        image: msgImage,
        delay: campaign.delay,
        randomDelay: campaign.randomDelay,
        loop: campaign.loop || false
      });
    } else {
      setEditingCampaign(null);
      setCampaignForm({
        name: '',
        accounts: [],
        targetsText: '',
        message: '',
        image: null,
        delay: 60,
        randomDelay: 10,
        loop: false
      });
    }
    setIsCampaignModalOpen(true);
  };

  const closeCampaignModal = () => {
    setIsCampaignModalOpen(false);
    setEditingCampaign(null);
    setGroupSearch('');
  };

  const handleCampaignAccountToggle = (phone) => {
    const accs = [...campaignForm.accounts];
    const idx = accs.indexOf(phone);
    if (idx > -1) {
      accs.splice(idx, 1);
    } else {
      accs.push(phone);
    }
    setCampaignForm({ ...campaignForm, accounts: accs });
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // A4: Validar tipo de arquivo via MIME type (não apenas extensão)
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!ALLOWED_TYPES.includes(file.type)) {
      alert('Tipo de arquivo não permitido. Use JPG, PNG, GIF ou WebP.');
      e.target.value = ''; // Limpar input
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert('A imagem selecionada é muito grande! Por favor, escolha uma imagem com menos de 2MB para garantir a performance de envio.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setCampaignForm({ ...campaignForm, image: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const saveCampaign = async (e) => {
    e.preventDefault();
    if (!campaignForm.name) return alert('Por favor, informe o nome da campanha.');
    if (campaignForm.accounts.length === 0) return alert('Selecione pelo menos uma conta de disparo.');
    if (!campaignForm.targetsText) return alert('Insira pelo menos um alvo (username ou ID).');
    if (!campaignForm.message) return alert('Escreva a mensagem da campanha.');

    let finalMessage = campaignForm.message;
    if (campaignForm.image) {
      finalMessage = JSON.stringify({
        text: campaignForm.message,
        image: campaignForm.image
      });
    }

    try {
      const payload = {
        id: editingCampaign ? editingCampaign.id : undefined,
        name: campaignForm.name,
        accounts: campaignForm.accounts,
        targetsText: campaignForm.targetsText,
        message: finalMessage,
        delay: campaignForm.delay,
        randomDelay: campaignForm.randomDelay,
        loop: campaignForm.loop
      };

      const res = await authenticatedFetch(`${API_BASE}/campaigns`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        closeCampaignModal();
        fetchData();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const toggleCampaign = async (id) => {
    try {
      await authenticatedFetch(`${API_BASE}/campaigns/${id}/toggle`, { method: 'POST' });
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteCampaign = async (id) => {
    if (window.confirm('Excluir esta campanha permanentemente?')) {
      try {
        await authenticatedFetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE' });
        fetchData();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // -------------------------------------------------------------
  // CONFIGURAÇÕES E LOGS
  // -------------------------------------------------------------
  const saveSettings = async (e) => {
    e.preventDefault();
    try {
      const res = await authenticatedFetch(`${API_BASE}/settings`, {
        method: 'POST',
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert('Configurações salvas com sucesso!');
        fetchSettings();
      }
    } catch (err) {
      alert('Erro ao salvar configurações.');
    }
  };

  const clearLogs = async () => {
    if (window.confirm('Limpar todos os registros de disparos? Esta ação não pode ser desfeita.')) {
      try {
        await authenticatedFetch(`${API_BASE}/logs/clear`, { method: 'POST' });
        fetchData();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // -------------------------------------------------------------
  // RENDER EXTRACTOR (Extrator de Membros)
  // -------------------------------------------------------------
  const renderExtractor = () => (
    <div className="extractor-view fadeIn">
      <div className="section-header">
        <h2>Extrator de Membros</h2>
        <p>Mova membros ativos de um grupo para o seu (Ignora Admins e Bots).</p>
      </div>

      <div className="card">
        <form onSubmit={handleExtractSubmit} className="form-grid">
          <div className="form-group">
            <label>Conta a ser usada</label>
            <select 
              value={extractForm.accountPhone}
              onChange={e => setExtractForm({...extractForm, accountPhone: e.target.value})}
              required
            >
              <option value="">Selecione uma conta...</option>
              {accounts.filter(a => a.status === 'connected').map(acc => (
                <option key={acc.phone} value={acc.phone}>
                  {acc.name} (+{acc.phone})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Grupo de Origem (De onde extrair)</label>
            <select
              value={extractForm.sourceGroup}
              onChange={e => setExtractForm({...extractForm, sourceGroup: e.target.value})}
              required
              disabled={!extractForm.accountPhone}
            >
              <option value="">Selecione um grupo de origem...</option>
              {extractGroups.map(g => (
                <option key={`src-${g.id}`} value={g.username ? `@${g.username}` : g.id}>
                  {g.title} {g.username ? `(@${g.username})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Grupo de Destino (Para onde adicionar)</label>
            <select
              value={extractForm.targetGroup}
              onChange={e => setExtractForm({...extractForm, targetGroup: e.target.value})}
              required
              disabled={!extractForm.accountPhone}
            >
              <option value="">Selecione um grupo de destino...</option>
              {extractGroups.map(g => (
                <option key={`tgt-${g.id}`} value={g.username ? `@${g.username}` : g.id}>
                  {g.title} {g.username ? `(@${g.username})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Qtd. de Mensagens a Analisar (Ex: 500)</label>
            <input
              type="number"
              min="10"
              max="5000"
              value={extractForm.limitMessages}
              onChange={e => setExtractForm({...extractForm, limitMessages: Number(e.target.value)})}
              required
            />
            <small>Lê as mensagens mais recentes para achar quem interagiu.</small>
          </div>

          <div className="form-group">
            <label>Mínimo de Interações (Ex: 2)</label>
            <input
              type="number"
              min="1"
              max="100"
              value={extractForm.minInteractions}
              onChange={e => setExtractForm({...extractForm, minInteractions: Number(e.target.value)})}
              required
            />
            <small>Exigir que o membro tenha enviado pelo menos este número de mensagens para ser considerado ativo.</small>
          </div>

          <div className="form-actions full-width" style={{ marginTop: '20px' }}>
            <button type="submit" className="btn-primary" disabled={extractLoading}>
              {extractLoading ? 'Extraindo e Adicionando...' : 'Iniciar Extração'}
            </button>
          </div>
        </form>

        {extractError && (
          <div className="error-alert" style={{ marginTop: '20px' }}>
            <strong>Erro:</strong> {extractError}
          </div>
        )}

        {extractResult && (
          <div className="success-alert" style={{ marginTop: '20px', backgroundColor: '#2e3b32', borderLeft: '4px solid #4ade80', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ color: '#4ade80', margin: '0 0 10px 0' }}>✅ {extractResult.message}</h3>
            <ul style={{ margin: 0, paddingLeft: '20px', color: '#e2e8f0' }}>
              <li><strong>Mensagens analisadas:</strong> {extractResult.totalAnalyzed}</li>
              <li><strong>Membros ativos encontrados (não-admins):</strong> {extractResult.activeFound}</li>
              <li><strong>Já estavam no grupo de destino:</strong> {extractResult.alreadyInGroup}</li>
              <li><strong>Membros adicionados com sucesso:</strong> {extractResult.successfullyAdded}</li>
              <li><strong>Falhas ao adicionar (ex: privacidade):</strong> {extractResult.failedToAdd}</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );

  // -------------------------------------------------------------
  // RENDERIZAÇÃO DE SUBVIEWS
  // -------------------------------------------------------------
  const renderDashboard = () => (
    <div>
      {/* Grid de Métricas Principais */}
      <div className="dashboard-grid">
        <div className="card metric-card">
          <div className="metric-icon-box">
            <span className="material-icons-round">account_circle</span>
          </div>
          <div className="metric-info">
            <h3>Contas Telegram</h3>
            <div className="value">{stats.connectedAccounts} <span style={{ fontSize: '14px', fontWeight: 'normal', color: 'var(--text-muted)' }}>/ {stats.totalAccounts}</span></div>
          </div>
        </div>

        <div className="card metric-card warning">
          <div className="metric-icon-box">
            <span className="material-icons-round">campaign</span>
          </div>
          <div className="metric-info">
            <h3>Campanhas Ativas</h3>
            <div className="value">{stats.activeCampaigns} <span style={{ fontSize: '14px', fontWeight: 'normal', color: 'var(--text-muted)' }}>/ {stats.totalCampaigns}</span></div>
          </div>
        </div>

        <div className="card metric-card success">
          <div className="metric-icon-box">
            <span className="material-icons-round">done_all</span>
          </div>
          <div className="metric-info">
            <h3>Mensagens Enviadas</h3>
            <div className="value">{stats.totalSent}</div>
          </div>
        </div>

        <div className="card metric-card error">
          <div className="metric-icon-box">
            <span className="material-icons-round">error_outline</span>
          </div>
          <div className="metric-info">
            <h3>Falhas de Envio</h3>
            <div className="value">{stats.totalFailed}</div>
          </div>
        </div>
      </div>

      <div className="layout-split">
        {/* Painel de Campanhas Recentes */}
        <div className="card">
          <div className="panel-title">
            <span className="material-icons-round">insights</span>
            Resumo das Campanhas
          </div>
          {campaigns.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)' }}>
              Nenhuma campanha ativa cadastrada. Vá até o menu <strong>Campanhas</strong> para criar uma!
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {campaigns.map(cmp => {
                const total = cmp.targets.length;
                const done = cmp.currentTargetIndex;
                const percent = total > 0 ? Math.round((done / total) * 100) : 0;
                
                return (
                  <div key={cmp.id} style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--glass-border)', padding: '16px', borderRadius: 'var(--radius-md)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <strong>{cmp.name}</strong>
                        {cmp.loop && (
                          <span className="material-icons-round" style={{ fontSize: '14px', color: 'var(--color-indigo)' }} title="Campanha em Loop Infinito">sync</span>
                        )}
                      </div>
                      <span className={`campaign-status-pill ${cmp.status}`}>{cmp.status === 'active' ? 'Ativa' : cmp.status === 'paused' ? 'Pausada' : 'Completa'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)' }}>
                      <span>Progresso: {done}/{total} alvos ({percent}%)</span>
                      <span>Sucessos: {cmp.sentCount} | Falhas: {cmp.failedCount}</span>
                    </div>
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: `${percent}%` }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Live Logs do Terminal */}
        <div className="card">
          <div className="panel-title" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="material-icons-round">terminal</span>
              Logs de Envio
            </div>
            <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={clearLogs}>Limpar</button>
          </div>
          
          <div className="terminal-container" style={{ height: '310px' }}>
            {logs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '10px' }}>Aguardando eventos...</div>
            ) : (
              logs.slice(0, 50).map(log => (
                <div key={log.id} className="terminal-line">
                  <span className="terminal-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span className={`terminal-badge ${log.status}`}>
                    {log.status === 'success' ? 'SUCESSO' : 'FALHA'}
                  </span>
                  <span className="terminal-msg">
                    {log.status === 'success' 
                      ? `Enviado para ${log.target} via +${log.accountPhone}`
                      : `${log.error} (${log.target})`
                    }
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderAccounts = () => (
    <div className="card">
      <div className="panel-title" style={{ justifyContent: 'space-between', marginBottom: '30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="material-icons-round">contact_phone</span>
          Minhas Contas Telegram
        </div>
        <button className="btn btn-primary" onClick={() => { setIsConnectModalOpen(true); startQrConnection(); }}>
          <span className="material-icons-round">add</span>
          Conectar Conta
        </button>
      </div>

      {accounts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)' }}>
          <span className="material-icons-round" style={{ fontSize: '48px', color: 'var(--text-muted)', marginBottom: '16px' }}>no_accounts</span>
          <p style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}>Nenhuma conta Telegram conectada.</p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto 20px' }}>
            Conecte suas contas pessoais via QR Code ou Número para começar a disparar mensagens automáticas personalizadas.
          </p>
          <button className="btn btn-primary" onClick={() => { setIsConnectModalOpen(true); startQrConnection(); }}>Conectar Primeira Conta</button>
        </div>
      ) : (
        <div className="accounts-grid">
          {accounts.map(acc => {
            const displayName = acc.name || `${acc.firstName || ''} ${acc.lastName || ''}`.trim() || 'Sem Nome';
            return (
              <div key={acc.phone} className="account-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div className="account-avatar">
                    {displayName[0].toUpperCase()}
                  </div>
                  <div className="account-details">
                    <h4>{displayName}</h4>
                    <p>+{acc.phone}</p>
                    {acc.username && <p style={{ fontSize: '12px', color: 'var(--color-indigo)' }}>@{acc.username}</p>}
                    <span className={`account-status-badge ${acc.isOnline ? 'online' : 'offline'}`}>
                      <span className="status-dot" style={{ width: '6px', height: '6px', boxShadow: 'none' }}></span>
                      {acc.isOnline ? 'Conectado' : 'Desconectado'}
                    </span>
                  </div>
                </div>
                
                <button className="btn-icon-only" style={{ color: 'var(--color-rose)', borderColor: 'rgba(244,63,94,0.1)' }} onClick={() => deleteAccount(acc.phone)}>
                  <span className="material-icons-round">logout</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderCampaigns = () => (
    <div className="card">
      <div className="panel-title" style={{ justifyContent: 'space-between', marginBottom: '30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="material-icons-round">campaign</span>
          Minhas Campanhas de Automação
        </div>
        <button className="btn btn-primary" onClick={() => openCampaignModal()}>
          <span className="material-icons-round">add</span>
          Criar Campanha
        </button>
      </div>

      {campaigns.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)' }}>
          <span className="material-icons-round" style={{ fontSize: '48px', color: 'var(--text-muted)', marginBottom: '16px' }}>schedule_send</span>
          <p style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}>Nenhuma campanha de envio cadastrada.</p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto 20px' }}>
            Crie campanhas personalizadas especificando a lista de grupos/contatos, as mensagens com variáveis e o tempo de delay ideal.
          </p>
          <button className="btn btn-primary" onClick={() => openCampaignModal()}>Criar Primeira Campanha</button>
        </div>
      ) : (
        <div>
          {campaigns.map(cmp => {
            const total = cmp.targets.length;
            const done = cmp.currentTargetIndex;
            const percent = total > 0 ? Math.round((done / total) * 100) : 0;
            
            return (
              <div key={cmp.id} className="campaign-card">
                <div className="campaign-header">
                  <div className="campaign-title">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <h3>{cmp.name}</h3>
                      {cmp.loop && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'rgba(99,102,241,0.15)', color: 'var(--color-indigo)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>
                          <span className="material-icons-round" style={{ fontSize: '12px' }}>sync</span>
                          Loop Infinito
                        </span>
                      )}
                    </div>
                    <div className="campaign-meta">
                      <span>Criado em: {new Date(cmp.createdAt).toLocaleDateString()}</span>
                      <span>Contas associadas: {cmp.accounts.length}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className={`campaign-status-pill ${cmp.status}`}>
                      {cmp.status === 'active' ? 'Ativa' : cmp.status === 'paused' ? 'Pausada' : 'Concluída'}
                    </span>
                    
                    <button className={`btn ${cmp.status === 'active' ? 'btn-secondary' : 'btn-primary'}`} style={{ padding: '8px 16px', fontSize: '13px' }} onClick={() => toggleCampaign(cmp.id)}>
                      <span className="material-icons-round">{cmp.status === 'active' ? 'pause' : 'play_arrow'}</span>
                      {cmp.status === 'active' ? 'Pausar' : 'Iniciar'}
                    </button>

                    <button className="btn btn-secondary" style={{ padding: '8px 12px' }} onClick={() => openCampaignModal(cmp)}>
                      <span className="material-icons-round">edit</span>
                    </button>

                    <button className="btn btn-secondary" style={{ padding: '8px 12px', color: 'var(--color-rose)' }} onClick={() => deleteCampaign(cmp.id)}>
                      <span className="material-icons-round">delete</span>
                    </button>
                  </div>
                </div>

                <div className="campaign-stats-row">
                  <div className="campaign-stat-item">
                    <span className="campaign-stat-label">Total Alvos</span>
                    <span className="campaign-stat-val">{total}</span>
                  </div>
                  <div className="campaign-stat-item">
                    <span className="campaign-stat-label">Progresso</span>
                    <span className="campaign-stat-val">{done} / {total}</span>
                  </div>
                  <div className="campaign-stat-item">
                    <span className="campaign-stat-label">Sucessos</span>
                    <span className="campaign-stat-val" style={{ color: 'var(--color-emerald)' }}>{cmp.sentCount}</span>
                  </div>
                  <div className="campaign-stat-item">
                    <span className="campaign-stat-label">Falhas</span>
                    <span className="campaign-stat-val" style={{ color: 'var(--color-rose)' }}>{cmp.failedCount}</span>
                  </div>
                  <div className="campaign-stat-item">
                    <span className="campaign-stat-label">Intervalo</span>
                    <span className="campaign-stat-val">
                      {Number(cmp.randomDelay) > 0 
                        ? `${cmp.delay}m a ${Number(cmp.delay) + Number(cmp.randomDelay)}m` 
                        : `${cmp.delay}m`}
                    </span>
                  </div>
                  {cmp.status === 'active' && cmp.nextSendAt && (
                    <div className="campaign-stat-item" style={{ marginLeft: 'auto' }}>
                      <span className="campaign-stat-label">Próximo envio às</span>
                      <span className="campaign-stat-val" style={{ color: 'var(--color-indigo)', fontSize: '15px' }}>
                        {new Date(cmp.nextSendAt).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
                    <span>Mensagem modelo:</span>
                    <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {(() => {
                        let text = cmp.message || '';
                        let hasImage = false;
                        if (text.startsWith('{') && text.endsWith('}')) {
                          try {
                            const parsed = JSON.parse(text);
                            text = parsed.text || '';
                            hasImage = !!parsed.image;
                          } catch (e) {}
                        }
                        return (
                          <>
                            {hasImage && (
                              <span className="material-icons-round" style={{ fontSize: '14px', color: 'var(--color-indigo)' }} title="Mensagem com imagem">image</span>
                            )}
                            {text.substring(0, 80)}{text.length > 80 ? '...' : ''}
                          </>
                        );
                      })()}
                    </span>
                  </div>
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${percent}%` }}></div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderLogsTab = () => (
    <div className="card">
      <div className="panel-title" style={{ justifyContent: 'space-between', marginBottom: '30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="material-icons-round">terminal</span>
          Terminal de Eventos do Sistema
        </div>
        <button className="btn btn-secondary" onClick={clearLogs}>Limpar Histórico</button>
      </div>

      <div className="terminal-container" style={{ height: '500px' }}>
        {logs.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic', padding: '10px' }}>Nenhum log disponível... Os disparos automáticos preencherão esta tela!</div>
        ) : (
          logs.map(log => (
            <div key={log.id} className="terminal-line">
              <span className="terminal-time">[{new Date(log.timestamp).toLocaleString()}]</span>
              <span className={`terminal-badge ${log.status}`}>
                {log.status === 'success' ? 'SUCESSO' : 'FALHA'}
              </span>
              <span className="terminal-msg">
                <strong>[{log.campaignName}]</strong>{' '}
                {log.status === 'success' 
                  ? `Mensagem enviada com sucesso para ${log.target} usando conta +${log.accountPhone}`
                  : `Falha ao tentar disparar para ${log.target} via +${log.accountPhone}: ${log.error}`
                }
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="card" style={{ maxWidth: '800px' }}>
      <div className="panel-title" style={{ marginBottom: '30px' }}>
        <span className="material-icons-round">settings</span>
        Configurações da API do Telegram
      </div>

      <form onSubmit={saveSettings}>
        {/* Toggle Switch */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '20px'
        }}>
          <div>
            <span style={{ fontSize: '14px', fontWeight: '600', color: '#fff', display: 'block' }}>API Personalizada</span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Ative para inserir suas próprias chaves de API (API ID e API Hash)</span>
          </div>
          <label className="switch" style={{ position: 'relative', display: 'inline-block', width: '42px', height: '24px' }}>
            <input 
              type="checkbox" 
              checked={settings.useCustomApi || false} 
              onChange={e => setSettings({ ...settings, useCustomApi: e.target.checked })} 
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: 'absolute',
              cursor: 'pointer',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: settings.useCustomApi ? 'var(--color-indigo)' : 'rgba(255,255,255,0.1)',
              transition: '.3s',
              borderRadius: '24px'
            }}>
              <span style={{
                position: 'absolute',
                content: '""',
                height: '18px', width: '18px',
                left: settings.useCustomApi ? '21px' : '3px',
                bottom: '3px',
                backgroundColor: '#fff',
                transition: '.3s',
                borderRadius: '50%'
              }}></span>
            </span>
          </label>
        </div>

        {!settings.useCustomApi ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '16px',
            background: 'rgba(16,185,129,0.06)',
            border: '1px solid rgba(16,185,129,0.15)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '20px',
            fontSize: '13px',
            color: 'var(--color-emerald)'
          }}>
            <span className="material-icons-round" style={{ fontSize: '18px' }}>check_circle</span>
            <span>Usando a API Padrão e Oculta (Conexão Segura - Recomendado)</span>
          </div>
        ) : (
          <div className="settings-grid" style={{ marginBottom: '20px' }}>
            <div className="form-group">
              <label className="form-label">Telegram API ID Personalizado</label>
              <input 
                className="form-input" 
                type="text" 
                placeholder="Ex: 31992404" 
                value={settings.customApiId || ''} 
                onChange={e => setSettings({ ...settings, customApiId: e.target.value })} 
                required 
              />
            </div>

            <div className="form-group">
              <label className="form-label">Telegram API Hash Personalizado</label>
              <input 
                className="form-input" 
                type="text" 
                placeholder="Ex: 29d0d2dc1ac01f98aefed17f7e017edf" 
                value={settings.customApiHash || ''} 
                onChange={e => setSettings({ ...settings, customApiHash: e.target.value })} 
                required 
              />
            </div>
          </div>
        )}

        <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 'var(--radius-md)', padding: '16px', margin: '20px 0', fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '4px' }}>💡 Dica sobre as Credenciais:</strong>
          Ao ativar a **API Personalizada**, você precisará configurar suas próprias chaves de autenticação, que podem ser criadas gratuitamente acessando o site oficial <a href="https://my.telegram.org" target="_blank" rel="noreferrer" style={{ color: 'var(--color-indigo)', fontWeight: 'bold' }}>my.telegram.org</a>. Desative para ocultar os dados e usar a API padrão do aplicativo com estabilidade.
        </div>

        <button className="btn btn-primary" type="submit">Salvar Configurações</button>
      </form>
    </div>
  );

  // -------------------------------------------------------------
  // RENDER COMPLETO DO COMPONENTE
  // -------------------------------------------------------------
  if (!token) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 30% 30%, rgba(99, 102, 241, 0.15) 0%, transparent 40%), radial-gradient(circle at 70% 70%, rgba(139, 92, 246, 0.15) 0%, transparent 40%), var(--bg-primary)',
        padding: '20px',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Animated Background Orbs */}
        <div style={{
          position: 'absolute',
          width: '500px',
          height: '500px',
          borderRadius: '50%',
          background: 'rgba(99, 102, 241, 0.05)',
          filter: 'blur(80px)',
          top: '-10%',
          left: '-10%',
          pointerEvents: 'none'
        }} />
        <div style={{
          position: 'absolute',
          width: '600px',
          height: '600px',
          borderRadius: '50%',
          background: 'rgba(139, 92, 246, 0.05)',
          filter: 'blur(100px)',
          bottom: '-10%',
          right: '-10%',
          pointerEvents: 'none'
        }} />

        <div className="card" style={{
          width: '100%',
          maxWidth: '440px',
          padding: '40px',
          background: 'var(--glass-bg)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3), var(--shadow-neon)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          position: 'relative',
          zIndex: 1
        }}>
          {/* Logo / Title Header */}
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: 'var(--grad-primary)',
              marginBottom: '16px',
              boxShadow: '0 8px 24px rgba(99, 102, 241, 0.3)'
            }}>
              <span className="material-icons-round" style={{ fontSize: '32px', color: '#fff' }}>rocket_launch</span>
            </div>
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '28px',
              fontWeight: '800',
              letterSpacing: '-0.5px',
              background: 'linear-gradient(135deg, #fff 0%, #a5b4fc 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginBottom: '6px'
            }}>
              TELEDIVU
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {showRegister ? 'Crie sua conta para começar a divulgar' : 'Faça login para gerenciar suas conexões e campanhas'}
            </p>
          </div>

          {authError && (
            <div style={{
              background: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid rgba(244, 63, 94, 0.2)',
              borderRadius: '10px',
              padding: '12px 16px',
              fontSize: '13px',
              color: 'var(--color-rose)',
              marginBottom: '24px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span className="material-icons-round" style={{ fontSize: '18px' }}>error_outline</span>
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleAuthSubmit}>
            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label className="form-label" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '700' }}>Usuário</label>
              <div style={{ position: 'relative' }}>
                <span className="material-icons-round" style={{
                  position: 'absolute',
                  left: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                  fontSize: '20px'
                }}>person</span>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Nome de usuário"
                  value={authForm.username}
                  onChange={e => setAuthForm({ ...authForm, username: e.target.value })}
                  style={{ paddingLeft: '44px' }}
                  required
                />
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: '28px' }}>
              <label className="form-label" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '700' }}>Senha</label>
              <div style={{ position: 'relative' }}>
                <span className="material-icons-round" style={{
                  position: 'absolute',
                  left: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                  fontSize: '20px'
                }}>lock</span>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Sua senha secreta"
                  value={authForm.password}
                  onChange={e => setAuthForm({ ...authForm, password: e.target.value })}
                  style={{ paddingLeft: '44px' }}
                  required
                />
              </div>
            </div>

            <button className="btn btn-primary" type="submit" style={{ width: '100%', padding: '14px', borderRadius: '12px', fontWeight: '700', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} disabled={authLoading}>
              {authLoading ? (
                <>
                  <span className="material-icons-round spinning" style={{ fontSize: '18px' }}>sync</span>
                  {showRegister ? 'Criando Conta...' : 'Entrando...'}
                </>
              ) : (
                <>
                  <span className="material-icons-round" style={{ fontSize: '18px' }}>{showRegister ? 'person_add' : 'login'}</span>
                  {showRegister ? 'Registrar Nova Conta' : 'Entrar no Sistema'}
                </>
              )}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: '24px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {showRegister ? 'Já possui uma conta?' : 'Ainda não tem conta?'}
            </span>
            <button
              onClick={() => {
                setShowRegister(!showRegister);
                setAuthError('');
                setAuthForm({ username: '', password: '' });
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-indigo)',
                fontSize: '13px',
                fontWeight: '700',
                marginLeft: '6px',
                cursor: 'pointer',
                textDecoration: 'underline'
              }}
            >
              {showRegister ? 'Faça Login' : 'Cadastre-se'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* 1. Sidebar de Navegação */}
      <aside className="sidebar">
        <div className="brand-section">
          <div className="brand-logo">DIVUGA</div>
          <span className="brand-badge">V1.0</span>
        </div>

        <nav className="nav-menu">
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            <span className="material-icons-round">dashboard</span>
            Dashboard
          </div>
          <div className={`nav-item ${activeTab === 'accounts' ? 'active' : ''}`} onClick={() => setActiveTab('accounts')}>
            <span className="material-icons-round">contact_phone</span>
            Contas Telegram
          </div>
          <div className={`nav-item ${activeTab === 'campaigns' ? 'active' : ''}`} onClick={() => setActiveTab('campaigns')}>
            <span className="material-icons-round">campaign</span>
            Campanhas
          </div>
          <div className={`nav-item ${activeTab === 'extractor' ? 'active' : ''}`} onClick={() => setActiveTab('extractor')}>
            <span className="material-icons-round">group_add</span>
            Extrator
          </div>
          <div className={`nav-item ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <span className="material-icons-round">terminal</span>
            Logs de Envio
          </div>
          <div className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
            <span className="material-icons-round">settings</span>
            Configurações
          </div>

          <div style={{ height: '1px', background: 'var(--glass-border)', margin: '16px 0 8px' }} />

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderRadius: '10px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--glass-border)',
            marginTop: '8px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
              <span className="material-icons-round" style={{ color: 'var(--color-indigo)', fontSize: '20px' }}>account_circle</span>
              <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentUser?.username}
              </span>
            </div>
            <button onClick={handleLogout} style={{
              background: 'rgba(244, 63, 94, 0.1)',
              border: 'none',
              borderRadius: '6px',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--color-rose)',
              transition: 'var(--transition-fast)'
            }} title="Sair do Sistema">
              <span className="material-icons-round" style={{ fontSize: '18px' }}>logout</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="system-status">
            <span className="status-dot pulse"></span>
            <span>Servidor Ativo</span>
          </div>
        </div>
      </aside>

      {/* 2. Conteúdo Principal */}
      <main className="main-content">
        <header className="top-header">
          <h2 className="page-title">
            {activeTab === 'dashboard' && 'Visão Geral do Painel'}
            {activeTab === 'accounts' && 'Gerenciamento de Contas'}
            {activeTab === 'campaigns' && 'Central de Campanhas'}
            {activeTab === 'extractor' && 'Extrator de Membros'}
            {activeTab === 'logs' && 'Histórico de Logs'}
            {activeTab === 'settings' && 'Parâmetros de Conexão'}
          </h2>

          <div className="header-actions">
            <div className="stats-pill">
              <span className="material-icons-round icon">account_circle</span>
              Contas: <strong>{stats.connectedAccounts} conectadas</strong>
            </div>
            <div className="stats-pill">
              <span className="material-icons-round icon" style={{ color: 'var(--color-emerald)' }}>done</span>
              Total Sucessos: <strong>{stats.totalSent}</strong>
            </div>
          </div>
        </header>

        <div className="content-body">
          {activeTab === 'dashboard' && renderDashboard()}
          {activeTab === 'accounts' && renderAccounts()}
          {activeTab === 'campaigns' && renderCampaigns()}
          {activeTab === 'extractor' && renderExtractor()}
          {activeTab === 'logs' && renderLogsTab()}
          {activeTab === 'settings' && renderSettings()}
        </div>
      </main>

      {/* MODAL 1: CONECTAR CONTA TELEGRAM */}
      {isConnectModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="panel-title" style={{ margin: 0 }}>
                <span className="material-icons-round">add_to_queue</span>
                Conectar Nova Conta
              </h3>
              <button className="modal-close" onClick={closeConnectModal}>&times;</button>
            </div>

            {/* Alternador de Tipo de Login */}
            {!connectionSessionId && (
              <div className="switch-tabs">
                <div className={`switch-tab ${connectType === 'qr' ? 'active' : ''}`} onClick={() => setConnectType('qr')}>QR Code</div>
                <div className={`switch-tab ${connectType === 'phone' ? 'active' : ''}`} onClick={() => setConnectType('phone')}>Número de Telefone</div>
              </div>
            )}

            {/* FLUXO POR QR CODE */}
            {connectType === 'qr' && (
              <div>
                {!connectionSessionId && (
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
                      Clique no botão abaixo para gerar um QR Code seguro do Telegram.
                    </p>
                    <button className="btn btn-primary" onClick={startQrConnection}>Gerar QR Code</button>
                  </div>
                )}

                {connectionSessionId && (
                  <div className="qr-container">
                    {connectionStatus === 'connecting' && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <div className="loader-spinner" style={{ width: '40px', height: '40px' }}></div>
                        <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Estabelecendo canal seguro com Telegram...</span>
                      </div>
                    )}

                    {connectionStatus === 'awaiting_scan' && qrImage && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <div className="qr-box">
                          <img src={qrImage} alt="QR Code Telegram" />
                          <div className="qr-scan-line"></div>
                          <div className="qr-pulse-ring"></div>
                        </div>
                        <div style={{ textAlign: 'center', maxWidth: '350px' }}>
                          <p style={{ fontSize: '15px', fontWeight: 'bold', marginBottom: '4px' }}>Escaneie para Conectar</p>
                          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                            Abra seu Telegram no celular, vá em <strong>Configurações &gt; Dispositivos &gt; Conectar dispositivo desktop</strong> e aponte para a tela.
                          </p>
                        </div>
                      </div>
                    )}

                    {connectionStatus === 'awaiting_password' && (
                      <div style={{ width: '100%' }}>
                        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px', textAlign: 'center' }}>
                          Sua conta possui <strong>Verificação em Duas Etapas (2FA)</strong> ativa. Digite sua senha em nuvem abaixo para completar a conexão:
                        </p>
                        <div className="form-group">
                          <label className="form-label">Senha Adicional (2FA)</label>
                          <input className="form-input" type="password" placeholder="Digite sua senha de 2FA" value={password2faInput} onChange={e => setPassword2faInput(e.target.value)} />
                        </div>
                        <button className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }} onClick={submitPassword2fa}>Confirmar Senha</button>
                      </div>
                    )}

                    {connectionStatus === 'success' && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '20px 0', position: 'relative' }}>
                        {/* Confetes em CSS */}
                        {[...Array(12)].map((_, i) => (
                          <div key={i} className="success-confetti-particle" style={{
                            backgroundColor: ['var(--color-indigo)', 'var(--color-cyan)', 'var(--color-emerald)', '#fcd34d'][i % 4],
                            left: `${5 + (i * 8)}%`,
                            animationDelay: `${i * 0.15}s`
                          }}></div>
                        ))}
                        <span className="material-icons-round" style={{ fontSize: '64px', color: 'var(--color-emerald)' }}>check_circle</span>
                        <h4 style={{ fontSize: '18px', fontWeight: 'bold' }}>Conta Conectada!</h4>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>A lista de contas será atualizada em instantes.</p>
                      </div>
                    )}

                    {connectionStatus === 'error' && (
                      <div style={{ textAlign: 'center', padding: '20px 0' }}>
                        <span className="material-icons-round" style={{ fontSize: '48px', color: 'var(--color-rose)' }}>error</span>
                        <h4 style={{ fontSize: '16px', fontWeight: 'bold', margin: '12px 0 6px' }}>Falha na Conexão</h4>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>{connectionError || 'Código expirou ou foi cancelado.'}</p>
                        <button className="btn btn-primary" onClick={startQrConnection}>Tentar Novamente</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* FLUXO POR NÚMERO DE TELEFONE */}
            {connectType === 'phone' && (
              <div>
                {/* ETAPA 1: DIGITAR NÚMERO */}
                {connectionStatus === null && (
                  <div>
                    <div className="form-group">
                      <label className="form-label">Número de Telefone (Com DDI e DDD)</label>
                      <input className="form-input" type="text" placeholder="Ex: +5511999998888" value={phoneInput} onChange={e => setPhoneInput(e.target.value)} />
                      <span className="form-hint">Digite no formato internacional contendo o código do país (+55 para Brasil).</span>
                    </div>
                    <button className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }} onClick={startPhoneConnection}>Solicitar Código SMS</button>
                  </div>
                )}

                {connectionStatus === 'connecting' && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '20px 0' }}>
                    <div className="loader-spinner" style={{ width: '40px', height: '40px' }}></div>
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Solicitando SMS/Código ao Telegram...</span>
                  </div>
                )}

                {/* ETAPA 2: DIGITAR CÓDIGO SMS/APP */}
                {connectionStatus === 'awaiting_code' && (
                  <div>
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px', textAlign: 'center' }}>
                      Um código de login foi enviado para o seu Telegram/SMS da conta <strong>{phoneInput}</strong>. Digite-o abaixo:
                    </p>
                    <div className="form-group">
                      <label className="form-label">Código de Autenticação</label>
                      <input className="form-input" type="text" placeholder="Digite o código" value={smsCodeInput} onChange={e => setSmsCodeInput(e.target.value)} />
                    </div>
                    <button className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }} onClick={submitSmsCode}>Verificar Código</button>
                  </div>
                )}

                {/* ETAPA 3: DIGITAR SENHA 2FA */}
                {connectionStatus === 'awaiting_password' && (
                  <div>
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px', textAlign: 'center' }}>
                      Sua conta possui <strong>Verificação em Duas Etapas (2FA)</strong> ativa. Digite sua senha em nuvem abaixo para completar a conexão:
                    </p>
                    <div className="form-group">
                      <label className="form-label">Senha Adicional (2FA)</label>
                      <input className="form-input" type="password" placeholder="Digite sua senha de 2FA" value={password2faInput} onChange={e => setPassword2faInput(e.target.value)} />
                    </div>
                    <button className="btn btn-primary" style={{ width: '100%', marginTop: '10px' }} onClick={submitPassword2fa}>Confirmar Senha</button>
                  </div>
                )}

                {/* SUCESSO OU ERRO */}
                {connectionStatus === 'success' && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '20px 0', position: 'relative' }}>
                    {[...Array(12)].map((_, i) => (
                      <div key={i} className="success-confetti-particle" style={{
                        backgroundColor: ['var(--color-indigo)', 'var(--color-cyan)', 'var(--color-emerald)', '#fcd34d'][i % 4],
                        left: `${5 + (i * 8)}%`,
                        animationDelay: `${i * 0.15}s`
                      }}></div>
                    ))}
                    <span className="material-icons-round" style={{ fontSize: '64px', color: 'var(--color-emerald)' }}>check_circle</span>
                    <h4 style={{ fontSize: '18px', fontWeight: 'bold' }}>Conta Conectada!</h4>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>A lista de contas será atualizada em instantes.</p>
                  </div>
                )}

                {connectionStatus === 'error' && (
                  <div style={{ textAlign: 'center', padding: '20px 0' }}>
                    <span className="material-icons-round" style={{ fontSize: '48px', color: 'var(--color-rose)' }}>error</span>
                    <h4 style={{ fontSize: '16px', fontWeight: 'bold', margin: '12px 0 6px' }}>Falha na Conexão</h4>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>{connectionError || 'Código ou senha inválidos/expirados.'}</p>
                    <button className="btn btn-primary" onClick={() => setConnectionStatus(null)}>Tentar Novamente</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 2: CRIAR / EDITAR CAMPANHA DE DISPARO */}
      {isCampaignModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: '650px', maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="modal-header">
              <h3 className="panel-title" style={{ margin: 0 }}>
                <span className="material-icons-round">edit_calendar</span>
                {editingCampaign ? 'Editar Campanha' : 'Criar Nova Campanha'}
              </h3>
              <button className="modal-close" onClick={closeCampaignModal}>&times;</button>
            </div>

            <form onSubmit={saveCampaign}>
              <div className="form-group">
                <label className="form-label">Nome da Campanha</label>
                <input className="form-input" type="text" placeholder="Ex: Divulgação Mentoria VIP" value={campaignForm.name} onChange={e => setCampaignForm({ ...campaignForm, name: e.target.value })} required />
              </div>

              {/* Contas que participarão */}
              <div className="form-group">
                <label className="form-label">Contas Remetentes (Multi-Account Round Robin)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '6px' }}>
                  {accounts.filter(a => a.isOnline).map(acc => {
                    const isChecked = campaignForm.accounts.includes(acc.phone);
                    const displayName = acc.name || `${acc.firstName || ''} ${acc.lastName || ''}`.trim() || 'Sem Nome';
                    return (
                      <div key={acc.phone} onClick={() => handleCampaignAccountToggle(acc.phone)} style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: `1px solid ${isChecked ? 'var(--color-indigo)' : 'var(--glass-border)'}`,
                        background: isChecked ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.02)',
                        color: isChecked ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontSize: '13px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'var(--transition-fast)'
                      }}>
                        <span className="material-icons-round" style={{ fontSize: '16px', color: isChecked ? 'var(--color-indigo)' : 'var(--text-muted)' }}>
                          {isChecked ? 'check_box' : 'check_box_outline_blank'}
                        </span>
                        {displayName} (+{acc.phone})
                      </div>
                    );
                  })}
                  {accounts.filter(a => a.isOnline).length === 0 && (
                    <span style={{ fontSize: '13px', color: 'var(--color-rose)', fontStyle: 'italic' }}>
                      Nenhuma conta de Telegram ativa disponível! Conecte ou ative suas contas primeiro.
                    </span>
                  )}
                </div>
              </div>

              {/* Lista de Alvos */}
              <div className="form-group">
                <label className="form-label">Grupos ou Usuários de Destino (Um por linha)</label>
                <textarea className="form-textarea" placeholder="Ex:&#10;@grupo_marketing&#10;@usuario_contato&#10;@meu_canal_vendas" value={campaignForm.targetsText} onChange={e => setCampaignForm({ ...campaignForm, targetsText: e.target.value })} required></textarea>
                
                {/* Seleção Interativa de Grupos das Contas Conectadas */}
                <div style={{
                  marginTop: '10px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '8px',
                  padding: '12px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-light)' }}>
                      Contatos e Chats Detectados ({availableGroups.filter(g => chatFilters[g.type]).length})
                    </span>
                    {availableGroups.length > 0 && (
                      <input 
                        type="text" 
                        placeholder="Buscar chat..." 
                        value={groupSearch} 
                        onChange={e => setGroupSearch(e.target.value)}
                        style={{
                          background: 'rgba(0,0,0,0.2)',
                          border: '1px solid var(--glass-border)',
                          borderRadius: '4px',
                          color: '#fff',
                          fontSize: '11px',
                          padding: '3px 8px',
                          outline: 'none',
                          width: '120px'
                        }}
                      />
                    )}
                  </div>

                  {/* Filtros de Tipos de Chat */}
                  {availableGroups.length > 0 && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                      {[
                        { key: 'group', label: 'Grupos', icon: 'groups', color: 'var(--color-emerald)' },
                        { key: 'channel', label: 'Canais', icon: 'campaign', color: 'var(--color-cyan)' },
                        { key: 'chat', label: 'Conversas', icon: 'chat', color: 'var(--color-indigo)' },
                        { key: 'bot', label: 'Bots', icon: 'smart_toy', color: '#fcd34d' }
                      ].map(filter => {
                        const isActive = chatFilters[filter.key];
                        return (
                          <div
                            key={filter.key}
                            onClick={() => setChatFilters({ ...chatFilters, [filter.key]: !isActive })}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              borderRadius: '20px',
                              fontSize: '11px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              border: `1px solid ${isActive ? filter.color : 'var(--glass-border)'}`,
                              background: isActive ? `rgba(${filter.key === 'bot' ? '252,211,77' : filter.key === 'group' ? '16,185,129' : filter.key === 'channel' ? '6,182,212' : '99,102,241'}, 0.15)` : 'transparent',
                              color: isActive ? '#fff' : 'var(--text-secondary)',
                              transition: 'all 0.2s'
                            }}
                          >
                            <span className="material-icons-round" style={{ fontSize: '12px', color: isActive ? filter.color : 'var(--text-muted)' }}>
                              {filter.icon}
                            </span>
                            {filter.label}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {isLoadingGroups ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 0', color: 'var(--color-cyan)', fontSize: '12px' }}>
                      <span className="material-icons-round spinning" style={{ fontSize: '18px' }}>sync</span>
                      Buscando chats e contatos das contas selecionadas...
                    </div>
                  ) : campaignForm.accounts.length === 0 ? (
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Selecione uma ou mais contas de envio acima para listar seus chats.
                    </span>
                  ) : availableGroups.length === 0 ? (
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Nenhum chat ou contato encontrado nas contas selecionadas.
                    </span>
                  ) : (
                    <div style={{
                      maxHeight: '130px',
                      overflowY: 'auto',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: '6px',
                      paddingRight: '4px'
                    }} className="custom-scrollbar">
                      {availableGroups
                        .filter(g => {
                          // Filtra pelo tipo selecionado
                          if (!chatFilters[g.type]) return false;
                          
                          // Filtra pelo termo de busca
                          if (!groupSearch) return true;
                          const term = groupSearch.toLowerCase();
                          return g.title.toLowerCase().includes(term) || (g.username && g.username.toLowerCase().includes(term));
                        })
                        .map(g => {
                          const value = g.username ? `@${g.username}` : g.id;
                          const isSelected = campaignForm.targetsText
                            .split('\n')
                            .map(t => t.trim())
                            .includes(value);

                          return (
                            <div
                              key={g.id}
                              onClick={() => handleGroupClick(g)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '6px 8px',
                                background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                                border: `1px solid ${isSelected ? 'var(--color-indigo)' : 'var(--glass-border)'}`,
                                borderRadius: '6px',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                                userSelect: 'none'
                              }}
                              className="group-pill"
                            >
                              <span 
                                className="material-icons-round" 
                                style={{ 
                                  fontSize: '16px', 
                                  color: isSelected ? 'var(--color-indigo)' : (g.type === 'channel' ? 'var(--color-cyan)' : g.type === 'bot' ? '#fcd34d' : g.type === 'chat' ? 'var(--color-indigo)' : 'var(--color-emerald)') 
                                }}
                              >
                                {isSelected ? 'check_circle' : (g.type === 'channel' ? 'campaign' : g.type === 'bot' ? 'smart_toy' : g.type === 'chat' ? 'chat' : 'groups')}
                              </span>
                              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                <div style={{ fontSize: '11px', fontWeight: '500', color: isSelected ? '#fff' : 'var(--text-light)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {g.title}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                                  {g.username ? `@${g.username}` : g.id}
                                </div>
                              </div>
                              {g.restrictsMedia && (
                                <span 
                                  className="material-icons-round" 
                                  style={{ fontSize: '14px', color: 'var(--color-rose)', marginLeft: 'auto' }} 
                                  title="Este grupo/canal restringe o envio de imagens/mídias para membros!"
                                >
                                  no_photography
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>

                <span className="form-hint" style={{ marginTop: '6px', display: 'block' }}>
                  Digite os usernames/IDs manualmente (um por linha) ou clique nos grupos acima para adicioná-los/removê-los da lista.
                </span>
              </div>

              {/* Conteúdo da Mensagem */}
              <div className="form-group">
                <label className="form-label">Mensagem Personalizada</label>
                <textarea className="form-textarea" placeholder="Olá {first_name}! Conheça nosso produto... {random_emoji}" value={campaignForm.message} onChange={e => setCampaignForm({ ...campaignForm, message: e.target.value })} required></textarea>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
                  {['{first_name}', '{last_name}', '{username}', '{chat_title}', '{random_emoji}', '{account_phone}'].map(tag => (
                    <span key={tag} onClick={() => setCampaignForm({ ...campaignForm, message: campaignForm.message + ' ' + tag })} style={{
                      padding: '2px 8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--glass-border)',
                      borderRadius: '4px',
                      fontSize: '11px',
                      color: 'var(--color-cyan)',
                      cursor: 'pointer',
                      fontFamily: 'monospace'
                    }} title="Clique para inserir no texto">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Imagem Opcional */}
              <div className="form-group" style={{ marginTop: '16px' }}>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="material-icons-round" style={{ fontSize: '18px', color: 'var(--color-indigo)' }}>image</span>
                  Imagem da Mensagem (Opcional)
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
                  {campaignForm.image && (
                    <div style={{ position: 'relative', width: 'fit-content' }}>
                      <img src={campaignForm.image} alt="Preview" style={{ maxWidth: '200px', maxHeight: '150px', borderRadius: '8px', border: '1px solid var(--glass-border)', objectFit: 'contain' }} />
                      <button type="button" onClick={() => setCampaignForm({ ...campaignForm, image: null })} style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-8px',
                        background: 'var(--color-rose)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '50%',
                        width: '20px',
                        height: '20px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        fontWeight: 'bold',
                        boxShadow: '0 2px 5px rgba(0,0,0,0.5)'
                      }}>×</button>
                    </div>
                  )}
                  <input type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} id="campaign-image-input" />
                  <label htmlFor="campaign-image-input" className="btn btn-secondary" style={{ width: 'fit-content', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '6px', fontSize: '13px' }}>
                    <span className="material-icons-round" style={{ fontSize: '16px' }}>photo_library</span>
                    {campaignForm.image ? 'Alterar Imagem' : 'Adicionar Imagem'}
                  </label>
                </div>
              </div>

              {/* Configurações de Delays */}
              <div className="settings-grid" style={{ marginTop: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Intervalo entre disparos (minutos)</label>
                  <input className="form-input" type="number" min="1" value={campaignForm.delay} onChange={e => setCampaignForm({ ...campaignForm, delay: e.target.value })} required />
                  <span className="form-hint">Mínimo de 1 minuto. O sistema aguardará este tempo antes de disparar para o próximo grupo.</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Variação Humana Aleatória (minutos)</label>
                  <input className="form-input" type="number" min="0" value={campaignForm.randomDelay} onChange={e => setCampaignForm({ ...campaignForm, randomDelay: e.target.value })} required />
                  <span className="form-hint">Adiciona um tempo aleatório ao intervalo base. Ex: 30 min + Variação de 30 min fará o disparo ocorrer aleatoriamente entre 30 e 60 minutos.</span>
                </div>
              </div>

              {/* Loop Opção */}
              <div className="form-group" style={{ marginTop: '20px', background: 'rgba(99,102,241,0.04)', border: '1px dashed rgba(99,102,241,0.2)', padding: '12px', borderRadius: '8px' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none', margin: 0 }}>
                  <input 
                    type="checkbox" 
                    checked={campaignForm.loop} 
                    onChange={e => setCampaignForm({ ...campaignForm, loop: e.target.checked })}
                    style={{
                      width: '18px',
                      height: '18px',
                      accentColor: 'var(--color-indigo)',
                      cursor: 'pointer',
                      marginTop: '2px'
                    }}
                  />
                  <div>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-light)', display: 'block' }}>
                      Repetir Campanha em Loop (Envio Infinito)
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4', display: 'block', marginTop: '2px' }}>
                      Ao enviar para todos os alvos cadastrados, a campanha reiniciará automaticamente do primeiro alvo da lista e continuará indefinidamente até ser pausada manualmente.
                    </span>
                  </div>
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '24px' }}>
                <button className="btn btn-secondary" type="button" onClick={closeCampaignModal}>Cancelar</button>
                <button className="btn btn-primary" type="submit">Salvar Campanha</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
