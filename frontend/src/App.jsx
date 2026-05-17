import React, { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
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
  const [settings, setSettings] = useState({ defaultApiId: '', defaultApiHash: '' });

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
    delay: 60,
    randomDelay: 10
  });

  const pollIntervalRef = useRef(null);
  const dataPollIntervalRef = useRef(null);

  // -------------------------------------------------------------
  // CARREGAMENTO E SINC DE DADOS
  // -------------------------------------------------------------
  const fetchData = async () => {
    try {
      const statsRes = await fetch(`${API_BASE}/stats`);
      const statsData = await statsRes.json();
      setStats(statsData);

      const accountsRes = await fetch(`${API_BASE}/accounts`);
      const accountsData = await accountsRes.json();
      setAccounts(accountsData);

      const campaignsRes = await fetch(`${API_BASE}/campaigns`);
      const campaignsData = await campaignsRes.json();
      setCampaigns(campaignsData);

      const logsRes = await fetch(`${API_BASE}/logs`);
      const logsData = await logsRes.json();
      setLogs(logsData);
    } catch (err) {
      console.error('Erro ao buscar dados do backend:', err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      const data = await res.json();
      setSettings(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();
    fetchSettings();

    // Polling contínuo dos dados do Dashboard a cada 4 segundos
    dataPollIntervalRef.current = setInterval(fetchData, 4000);

    return () => {
      if (dataPollIntervalRef.current) clearInterval(dataPollIntervalRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // -------------------------------------------------------------
  // FLUXO DE CONEXÃO E AUTENTICAÇÃO (TELEGRAM)
  // -------------------------------------------------------------
  const startQrConnection = async () => {
    setConnectionError(null);
    setConnectionStatus('connecting');
    setQrImage(null);
    try {
      const res = await fetch(`${API_BASE}/accounts/connect/qr/start`, { method: 'POST' });
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
      const res = await fetch(`${API_BASE}/accounts/connect/phone/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      await fetch(`${API_BASE}/accounts/connect/phone/submit-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: connectionSessionId, code: smsCodeInput })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const submitPassword2fa = async () => {
    if (!password2faInput) return;
    try {
      await fetch(`${API_BASE}/accounts/connect/phone/submit-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: connectionSessionId, password: password2faInput })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const startStatusPolling = (sessionId) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/accounts/connect/status?sessionId=${sessionId}`);
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
    }, 1500);
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
        await fetch(`${API_BASE}/accounts/${phone}`, { method: 'DELETE' });
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
      setCampaignForm({
        name: campaign.name,
        accounts: campaign.accounts,
        targetsText: campaign.targetsText || campaign.targets.join('\n'),
        message: campaign.message,
        delay: campaign.delay,
        randomDelay: campaign.randomDelay
      });
    } else {
      setEditingCampaign(null);
      setCampaignForm({
        name: '',
        accounts: [],
        targetsText: '',
        message: '',
        delay: 60,
        randomDelay: 10
      });
    }
    setIsCampaignModalOpen(true);
  };

  const closeCampaignModal = () => {
    setIsCampaignModalOpen(false);
    setEditingCampaign(null);
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

  const saveCampaign = async (e) => {
    e.preventDefault();
    if (!campaignForm.name) return alert('Por favor, informe o nome da campanha.');
    if (campaignForm.accounts.length === 0) return alert('Selecione pelo menos uma conta de disparo.');
    if (!campaignForm.targetsText) return alert('Insira pelo menos um alvo (username ou ID).');
    if (!campaignForm.message) return alert('Escreva a mensagem da campanha.');

    try {
      const res = await fetch(`${API_BASE}/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingCampaign ? editingCampaign.id : undefined,
          ...campaignForm
        })
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
      await fetch(`${API_BASE}/campaigns/${id}/toggle`, { method: 'POST' });
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteCampaign = async (id) => {
    if (window.confirm('Excluir esta campanha permanentemente?')) {
      try {
        await fetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE' });
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
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    if (window.confirm('Limpar todos os registros de disparos da tela?')) {
      try {
        await fetch(`${API_BASE}/logs/clear`, { method: 'POST' });
        fetchData();
      } catch (e) {
        console.error(e);
      }
    }
  };

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
                      <strong>{cmp.name}</strong>
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
          {accounts.map(acc => (
            <div key={acc.phone} className="account-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div className="account-avatar">
                  {acc.firstName ? acc.firstName[0].toUpperCase() : 'T'}
                </div>
                <div className="account-details">
                  <h4>{acc.firstName} {acc.lastName}</h4>
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
          ))}
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
                    <h3>{cmp.name}</h3>
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
                    <span className="campaign-stat-label">Delay Padrão</span>
                    <span className="campaign-stat-val">{cmp.delay}s (±{cmp.randomDelay}s)</span>
                  </div>
                  {cmp.status === 'active' && cmp.nextSendAt && (
                    <div className="campaign-stat-item" style={{ marginLeft: 'auto' }}>
                      <span className="campaign-stat-label">Próximo envio em</span>
                      <span className="campaign-stat-val" style={{ color: 'var(--color-indigo)', fontSize: '15px' }}>
                        {new Date(cmp.nextSendAt).toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span>Mensagem modelo:</span>
                    <span style={{ color: 'var(--text-muted)' }}>{cmp.message.substring(0, 80)}...</span>
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
        <div className="settings-grid">
          <div className="form-group">
            <label className="form-label">Telegram API ID</label>
            <input className="form-input" type="text" value={settings.defaultApiId} onChange={e => setSettings({ ...settings, defaultApiId: e.target.value })} required />
          </div>

          <div className="form-group">
            <label className="form-label">Telegram API Hash</label>
            <input className="form-input" type="text" value={settings.defaultApiHash} onChange={e => setSettings({ ...settings, defaultApiHash: e.target.value })} required />
          </div>
        </div>

        <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 'var(--radius-md)', padding: '16px', margin: '20px 0', fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '4px' }}>💡 Dica Importante sobre as Credenciais:</strong>
          As credenciais configuradas acima são as credenciais padrão do aplicativo Telegram. Caso deseje criar suas próprias chaves de autenticação customizadas, você pode gerá-las gratuitamente acessando o site oficial <a href="https://my.telegram.org" target="_blank" rel="noreferrer" style={{ color: 'var(--color-indigo)', fontWeight: 'bold' }}>my.telegram.org</a> sob a seção "API Development Tools".
        </div>

        <button className="btn btn-primary" type="submit">Salvar Credenciais</button>
      </form>
    </div>
  );

  // -------------------------------------------------------------
  // RENDER COMPLETO DO COMPONENTE
  // -------------------------------------------------------------
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
          <div className={`nav-item ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <span className="material-icons-round">terminal</span>
            Logs de Envio
          </div>
          <div className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
            <span className="material-icons-round">settings</span>
            Configurações
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
                        {acc.firstName} (+{acc.phone})
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
                <span className="form-hint">Paste os usernames (com @) ou links/IDs dos alvos. O sistema disparará rotacionando as contas conectadas.</span>
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

              {/* Configurações de Delays */}
              <div className="settings-grid" style={{ marginTop: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Intervalo entre disparos (segundos)</label>
                  <input className="form-input" type="number" min="10" value={campaignForm.delay} onChange={e => setCampaignForm({ ...campaignForm, delay: e.target.value })} required />
                  <span className="form-hint">Mínimo sugerido de 30-60 segundos para evitar punições do Telegram.</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Variação Humana Aleatória (segundos)</label>
                  <input className="form-input" type="number" min="0" value={campaignForm.randomDelay} onChange={e => setCampaignForm({ ...campaignForm, randomDelay: e.target.value })} required />
                  <span className="form-hint">Será somado ou subtraído um tempo aleatório para parecer digitação humana.</span>
                </div>
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
