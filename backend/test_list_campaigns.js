require('dotenv').config();
const db = require('./db.js');

async function test() {
  try {
    console.log('Buscando campanhas no Supabase...');
    const campaigns = await db.getCampaigns();
    console.log(`Encontradas ${campaigns.length} campanhas:`);
    
    campaigns.forEach((cmp, index) => {
      console.log(`\n--- [Campanha ${index + 1}] ---`);
      console.log(`ID: ${cmp.id}`);
      console.log(`Nome: "${cmp.name}"`);
      console.log(`Status: "${cmp.status}"`);
      console.log(`Contas Selecionadas:`, cmp.accounts);
      console.log(`Alvos (Targets):`, cmp.targets);
      console.log(`Mensagem (resumo): "${(cmp.textMessage || cmp.message || '').substring(0, 60)}..."`);
      console.log(`Imagem anexada: ${cmp.image ? 'SIM (Base64)' : 'NÃO'}`);
      console.log(`Loop Ativo: ${cmp.loop}`);
      console.log(`Delay: ${cmp.delay}s, RandomDelay: ${cmp.randomDelay}s`);
      console.log(`Progresso: Atual=${cmp.currentTargetIndex}, Sucessos=${cmp.sentCount}, Falhas=${cmp.failedCount}`);
      console.log(`Próximo Disparo: ${cmp.nextSendAt}`);
    });
  } catch (err) {
    console.error('Erro:', err);
  }
}

test();
