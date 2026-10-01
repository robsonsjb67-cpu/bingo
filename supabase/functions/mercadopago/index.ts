// Bingo · Mercado Pago (Supabase Edge Function "mercadopago")
// O Access Token de cada cliente fica na tabela public.mp_contas, que o navegador não consegue ler.
// Só esta função lê o token, com a chave de serviço, para criar o checkout e conferir pagamentos.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function cleanRef(ref: unknown) {
  return String(ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

async function mp(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch('https://api.mercadopago.com' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, erro: 'Use POST.' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false }
    });
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth, error: authError } = await admin.auth.getUser(jwt);
    const user = auth && auth.user;
    if (authError || !user) return json({ ok: false, erro: 'Entre na sua conta do bingo de novo.' }, 401);

    const p = await req.json().catch(() => ({}));
    const acao = String(p.acao || '');

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
        // Só Pix e cartão: sem boleto e sem lotérica.
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
