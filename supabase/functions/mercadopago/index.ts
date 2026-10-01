// Bingo · Mercado Pago (Supabase Edge Function "mercadopago")
// O Access Token de cada cliente fica na tabela public.mp_contas, que o navegador não consegue ler.
// Só esta função lê o token, com a chave de serviço, para criar o checkout e conferir pagamentos.
//
// Ações do dono do bingo (precisa estar logado): salvar, info, remover, criar, status.
// Ações do participante no site público (sem login): comprar, conferir.
// O Mercado Pago avisa os pagamentos em ?acao=webhook&u=<dono>.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const RESERVA_MINUTOS = 15;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function cleanRef(ref: unknown) {
  return String(ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

function cleanSlug(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
}

async function mp(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch('https://api.mercadopago.com' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function tokenOf(admin: SupabaseClient, userId: string) {
  const { data } = await admin.from('mp_contas').select('access_token').eq('user_id', userId).maybeSingle();
  return data ? data.access_token as string : '';
}

// Marca a compra como paga se o pagamento foi aprovado no valor certo.
async function applyPayment(admin: SupabaseClient, compra: Record<string, unknown>, payment: Record<string, unknown>) {
  if (payment.status !== 'approved') return false;
  if (Number(payment.transaction_amount) + 0.01 < Number(compra.valor)) return false;
  if (compra.status === 'pago') return true;
  await admin.from('compras').update({
    status: 'pago', pagamento_id: String(payment.id || ''), pago_em: new Date().toISOString()
  }).eq('ref', compra.ref as string);
  return true;
}

async function comprar(admin: SupabaseClient, p: Record<string, unknown>) {
  const slug = cleanSlug(p.site);
  const numero = Number(p.numero);
  const nome = String(p.nome || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const telefone = String(p.telefone || '').replace(/\D/g, '').slice(0, 13);
  if (!slug || !Number.isInteger(numero)) return json({ ok: false, erro: 'Cartela inválida.' });
  if (nome.length < 2) return json({ ok: false, erro: 'Escreva o seu nome.' });
  if (telefone.length < 10) return json({ ok: false, erro: 'Escreva o seu WhatsApp com DDD.' });

  const { data: site } = await admin.from('sites').select('user_id, nome, publico').eq('slug', slug).maybeSingle();
  if (!site) return json({ ok: false, erro: 'Site não encontrado.' });
  const estado = site.publico && site.publico.estado;
  if (estado === 'girando' || estado === 'resultado') return json({ ok: false, erro: 'As vendas desta rodada já fecharam.' });

  const { data: config } = await admin.from('bingo_config').select('dados').eq('user_id', site.user_id).maybeSingle();
  const dados = (config && config.dados) || {};
  const valor = Math.round(Number(dados.ticketPrice) * 100) / 100;
  const rodada = Number.isInteger(dados.round) && dados.round > 0 ? dados.round : 1;
  const cartela = (Array.isArray(dados.tickets) ? dados.tickets : []).find((t: { number: number }) => t && t.number === numero);
  if (!(valor > 0)) return json({ ok: false, erro: 'A loja ainda não colocou o valor da cartela.' });
  if (!cartela) return json({ ok: false, erro: 'Essa cartela não existe.' });
  if (String(cartela.name || '').trim()) return json({ ok: false, erro: 'Essa cartela já foi vendida. Escolha outra.' });

  const agora = new Date();
  const { data: outras } = await admin.from('compras').select('status, expira_em')
    .eq('user_id', site.user_id).eq('rodada', rodada).eq('numero', numero).in('status', ['pendente', 'pago']);
  const ocupada = (outras || []).some((c: { status: string; expira_em: string }) => c.status === 'pago' || new Date(c.expira_em) > agora);
  if (ocupada) return json({ ok: false, erro: 'Alguém está pagando essa cartela agora. Escolha outra.' });

  const token = await tokenOf(admin, site.user_id);
  if (!token) return json({ ok: false, erro: 'A loja ainda não ligou o Mercado Pago.' });

  const ref = `BC-${crypto.randomUUID().slice(0, 8).toUpperCase()}-R${rodada}-C${numero}`;
  const expira = new Date(agora.getTime() + RESERVA_MINUTOS * 60000);
  const { error: insertError } = await admin.from('compras').insert({
    ref, user_id: site.user_id, rodada, numero, nome, telefone, valor, expira_em: expira.toISOString()
  });
  if (insertError) throw insertError;

  const corpo: Record<string, unknown> = {
    items: [{
      id: ref,
      title: `${String(site.nome || 'Bingo').slice(0, 60)} · Cartela ${numero} · Rodada ${String(rodada).padStart(2, '0')}`,
      quantity: 1,
      unit_price: valor,
      currency_id: 'BRL'
    }],
    payer: { name: nome },
    external_reference: ref,
    statement_descriptor: 'BINGO',
    notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago?acao=webhook&u=${site.user_id}`,
    expires: true,
    expiration_date_to: expira.toISOString(),
    // Só Pix e cartão: sem boleto e sem lotérica.
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] }
  };
  const voltar = String(p.voltar || '');
  if (/^https:\/\/[^\s]+$/i.test(voltar)) {
    const back = voltar + (voltar.includes('?') ? '&' : '?') + 'compra=' + ref;
    corpo.back_urls = { success: back, pending: back, failure: back };
    corpo.auto_return = 'approved';
  }
  const pref = await mp(token, '/checkout/preferences', { method: 'POST', body: JSON.stringify(corpo) });
  if (!pref.ok) {
    await admin.from('compras').delete().eq('ref', ref);
    return json({ ok: false, erro: pref.data.message || 'O Mercado Pago recusou o pedido.' });
  }
  return json({ ok: true, ref, link: pref.data.init_point, expira: expira.toISOString() });
}

async function conferir(admin: SupabaseClient, p: Record<string, unknown>) {
  const ref = cleanRef(p.ref);
  const { data: compra } = await admin.from('compras').select('*').eq('ref', ref).maybeSingle();
  if (!compra) return json({ ok: false, erro: 'Compra não encontrada.' });
  let status = compra.status;
  if (status !== 'pago') {
    const token = await tokenOf(admin, compra.user_id);
    if (token) {
      const busca = await mp(token, '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(ref));
      const lista = (busca.ok && busca.data.results) || [];
      for (const pagamento of lista) {
        if (await applyPayment(admin, compra, pagamento)) { status = 'pago'; break; }
      }
      if (status !== 'pago' && lista.length) status = lista[0].status === 'rejected' ? 'recusado' : 'pendente';
    }
  }
  return json({ ok: true, ref, status, numero: compra.numero, rodada: compra.rodada });
}

async function webhook(admin: SupabaseClient, url: URL, req: Request) {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const userId = String(url.searchParams.get('u') || '');
  const tipo = url.searchParams.get('type') || url.searchParams.get('topic') || body.type || body.topic || '';
  const id = url.searchParams.get('data.id') || url.searchParams.get('id') || (body.data && body.data.id) || '';
  if (tipo !== 'payment' || !id || !/^[0-9a-f-]{36}$/i.test(userId)) return json({ ok: true });
  const token = await tokenOf(admin, userId);
  if (!token) return json({ ok: true });
  const pagamento = await mp(token, '/v1/payments/' + encodeURIComponent(String(id)));
  if (!pagamento.ok) return json({ ok: true });
  const ref = cleanRef(pagamento.data.external_reference);
  const { data: compra } = await admin.from('compras').select('*').eq('ref', ref).eq('user_id', userId).maybeSingle();
  if (compra) await applyPayment(admin, compra, pagamento.data);
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false }
    });
    const url = new URL(req.url);
    if (url.searchParams.get('acao') === 'webhook') return await webhook(admin, url, req);
    if (req.method !== 'POST') return json({ ok: false, erro: 'Use POST.' }, 405);

    const p = await req.json().catch(() => ({}));
    const acao = String(p.acao || '');
    if (acao === 'comprar') return await comprar(admin, p);
    if (acao === 'conferir') return await conferir(admin, p);

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth, error: authError } = await admin.auth.getUser(jwt);
    const user = auth && auth.user;
    if (authError || !user) return json({ ok: false, erro: 'Entre na sua conta do bingo de novo.' }, 401);

    if (acao === 'salvar') {
      const token = String(p.token || '').trim();
      if (!/^(APP_USR|TEST)-[A-Za-z0-9-]{20,}$/.test(token)) {
        return json({ ok: false, erro: 'Esse não parece um Access Token. Ele começa com APP_USR-.' });
      }
      const me = await mp(token, '/users/me');
      if (!me.ok) return json({ ok: false, erro: 'O Mercado Pago não aceitou esse Access Token. Copie de novo em Credenciais de produção.' });
      const conta = String(me.data.nickname || me.data.email || me.data.id || '').slice(0, 80);
      const final = token.slice(-4);
      const { error } = await admin.from('mp_contas').upsert({
        user_id: user.id, access_token: token, conta, final, atualizado_em: new Date().toISOString()
      });
      if (error) throw error;
      return json({ ok: true, configurado: true, conta, final });
    }

    if (acao === 'remover') {
      const { error } = await admin.from('mp_contas').delete().eq('user_id', user.id);
      if (error) throw error;
      return json({ ok: true, configurado: false });
    }

    const { data: row, error: rowError } = await admin.from('mp_contas')
      .select('access_token, conta, final').eq('user_id', user.id).maybeSingle();
    if (rowError) throw rowError;

    if (acao === 'info') {
      return json({ ok: true, configurado: Boolean(row), conta: row ? row.conta : '', final: row ? row.final : '' });
    }

    if (!row) return json({ ok: false, erro: 'Coloque o Access Token do Mercado Pago nas configurações do bingo.' });
    const token = row.access_token;

    if (acao === 'criar') {
      const valor = Number(p.valor);
      if (!(valor > 0)) return json({ ok: false, erro: 'Valor da cartela inválido.' });
      const ref = cleanRef(p.ref);
      if (!ref) return json({ ok: false, erro: 'Referência da cartela vazia.' });
      const corpo: Record<string, unknown> = {
        items: [{
          id: ref,
          title: String(p.titulo || 'Cartela do bingo').slice(0, 120),
          quantity: 1,
          unit_price: Math.round(valor * 100) / 100,
          currency_id: 'BRL'
        }],
        external_reference: ref,
        statement_descriptor: 'BINGO',
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] }
      };
      if (p.nome) corpo.payer = { name: String(p.nome).slice(0, 60) };
      const pref = await mp(token, '/checkout/preferences', { method: 'POST', body: JSON.stringify(corpo) });
      if (!pref.ok) return json({ ok: false, erro: pref.data.message || 'O Mercado Pago recusou o pedido.' });
      return json({ ok: true, ref, link: pref.data.init_point });
    }

    if (acao === 'status') {
      const ref = cleanRef(p.ref);
      if (!ref) return json({ ok: false, erro: 'Referência da cartela vazia.' });
      const busca = await mp(token, '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(ref));
      if (!busca.ok) return json({ ok: false, erro: busca.data.message || 'Não deu para consultar o pagamento.' });
      const lista = busca.data.results || [];
      const aprovado = lista.find((item: { status: string }) => item.status === 'approved');
      return json({
        ok: true, ref,
        status: aprovado ? 'approved' : (lista.length ? lista[0].status : 'none'),
        valor: aprovado ? aprovado.transaction_amount : null
      });
    }

    return json({ ok: false, erro: 'Ação desconhecida.' }, 400);
  } catch (error) {
    return json({ ok: false, erro: String((error && (error as Error).message) || error) }, 500);
  }
});
