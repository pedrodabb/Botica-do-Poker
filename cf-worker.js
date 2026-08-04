/* Botica do Poker — Cloudflare Worker
   Roda a cada 1 minuto (Cron Trigger) e manda push notification quando o
   timer de blinds ao vivo troca de nível, ou quando faltam 2 minutos pro
   próximo nível — mesmo com o app fechado / tela apagada em todo mundo.

   NÃO faz parte do app (index.html continua sendo o app inteiro num
   arquivo só). Isso roda fora, na Cloudflare, e só conversa com o Firebase
   por fora (REST + FCM), sem precisar do plano pago (Blaze) do Firebase.

   ===== Setup (uma vez, no painel da Cloudflare) =====
   1. workers.cloudflare.com → Create Worker → cole este arquivo inteiro.
   2. Settings → Variables → Secrets → adicionar "FIREBASE_SERVICE_ACCOUNT":
      cole o conteúdo INTEIRO do .json baixado em
      Firebase Console → Configurações do projeto → Contas de serviço →
      Gerar nova chave privada. NUNCA cole isso no GitHub.
   3. Settings → Triggers → Cron Triggers → adicionar "* * * * *" (a cada
      minuto).
   4. Pra testar sem esperar o cron: abra a URL do worker no navegador —
      o handler de "fetch" abaixo roda a mesma checagem na hora.
*/

const DATABASE_URL = 'https://home-game-14a59-default-rtdb.firebaseio.com';
const DB_PATH = 'homegame/dados';
const PROJECT_ID = 'home-game-14a59';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checarBlinds(env));
  },
  async fetch(request, env, ctx) {
    try {
      await checarBlinds(env);
      return new Response('ok');
    } catch (e) {
      return new Response('erro: ' + e.message, { status: 500 });
    }
  }
};

async function checarBlinds(env) {
  const accessToken = await getAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  const session = await rtdbGet(accessToken, DB_PATH + '/activeSession');
  if (!session || !session.estruturaBlinds || session.blindTimerPausedAt) return;

  const atual = calcNivelBlindAtual(session);
  if (!atual) return;

  // Mesma lógica do cliente (window._blindTimerUltimoNivel /
  // window._blindTimerAvisoTocado em index.html): nunca alerta na
  // primeira checagem depois do início, e o aviso de 2min dispara só
  // uma vez por nível. O aviso de rebuy dispara junto com a troca de
  // nível — não é baseado em "faltam X minutos" (tempo), e sim em "o
  // nível que acabou de começar é o addonAposNivel" (o último em que o
  // rebuy ainda fica aberto). Bug real corrigido: antes
  // pushAvisoRebuyNotificado nunca resetava (disparava uma vez só por
  // sessão inteira), então se o nível avançasse errado
  // (moverNivelBlind sem querer) e voltasse pro nível do add-on de
  // novo, o push não chegava mais — agora reseta sempre que o nível
  // muda pra fora do add-on, igual pushAvisoNotificado já fazia.
  const primeiraChamada = session.pushUltimoNivelNotificado === undefined;
  const patch = { pushUltimoNivelNotificado: atual.idx };
  const notificacoes = [];

  if (!primeiraChamada && session.pushUltimoNivelNotificado !== atual.idx) {
    patch.pushAvisoNotificado = false;
    notificacoes.push({
      titulo: atual.nivel.simples ? '🔔 Hora de apitar o blind' : '🔔 Nível ' + (atual.idx + 1) + ' — ' + fmtNum(atual.nivel.sb) + '/' + fmtNum(atual.nivel.bb),
      corpo: atual.nivel.simples ? 'Apita a cada ' + atual.duracaoFaseMin + ' min' : (atual.nivel.fase + (atual.nivel.ante ? ' · ante ' + fmtNum(atual.nivel.ante) : ''))
    });

    const eb = session.estruturaBlinds;
    const ehNivelAddon = eb && eb.addonAposNivel && atual.nivel.nivel === eb.addonAposNivel;
    if (ehNivelAddon) {
      if (!session.pushAvisoRebuyNotificado) {
        patch.pushAvisoRebuyNotificado = true;
        notificacoes.push({
          titulo: '⏰ Último nível pra recomprar!',
          corpo: 'O rebuy/add-on fecha no fim deste nível.'
        });
      }
    } else {
      patch.pushAvisoRebuyNotificado = false;
    }
  }

  const avisoJaTocado = notificacoes.length ? false : !!session.pushAvisoNotificado;
  if (!primeiraChamada && !avisoJaTocado && atual.proximo && atual.restanteMin <= 2) {
    patch.pushAvisoNotificado = true;
    notificacoes.push({
      titulo: '⏳ Faltam 2 minutos pro próximo apito',
      corpo: atual.nivel.simples ? 'Prepare o apito' : ('Vai virar pra ' + fmtNum(atual.proximo.sb) + '/' + fmtNum(atual.proximo.bb))
    });
  }

  if (!notificacoes.length) {
    if (session.pushUltimoNivelNotificado !== atual.idx) {
      await rtdbPatch(accessToken, DB_PATH + '/activeSession', patch);
    }
    return;
  }

  const tokensObj = await rtdbGet(accessToken, DB_PATH + '/pushTokens');
  const agora = Date.now();
  const entradas = tokensObj ? Object.entries(tokensObj) : [];
  // Mesma duração de 8h do login (pgm_auth_exp) — token sem expiresAt
  // (registrado antes dessa mudança) é tratado como já expirado, pra
  // não ficar avisando quem nunca mais voltou a usar o app.
  const validas = entradas.filter(([, t]) => t.expiresAt && t.expiresAt > agora);
  const expiradas = entradas.filter(([, t]) => !t.expiresAt || t.expiresAt <= agora);
  const tokenList = validas.map(([, t]) => t.token).filter(Boolean);

  if (expiradas.length) {
    const limpeza = {};
    expiradas.forEach(([chave]) => { limpeza[chave] = null; });
    await rtdbPatch(accessToken, DB_PATH + '/pushTokens', limpeza).catch(() => {});
  }

  if (tokenList.length) {
    await Promise.all(
      notificacoes.flatMap(n => tokenList.map(token => enviarPush(accessToken, token, n.titulo, n.corpo).catch(() => {})))
    );
  }

  await rtdbPatch(accessToken, DB_PATH + '/activeSession', patch);
}

function fmtNum(n) {
  return (n || 0).toLocaleString('pt-BR');
}

/* Idêntico ao calcNivelBlindAtual() do index.html — mesma fórmula, mesmo
   resultado, só que rodando no servidor em vez do navegador. */
function calcNivelBlindAtual(s) {
  var eb = s.estruturaBlinds;
  if (!eb || !s.blindTimerStartedAt) return null;
  var agora = s.blindTimerPausedAt || Date.now();
  var elapsedMin = ((agora - s.blindTimerStartedAt) - (s.blindTimerTotalPaused || 0)) / 60000;
  if (eb.simples) {
    var intervalo = eb.intervaloMin || 15;
    var idxS = Math.floor(Math.max(0, elapsedMin) / intervalo);
    var acumuladoS = idxS * intervalo;
    return {
      idx: idxS, nivel: { simples: true, duracaoMin: intervalo },
      restanteMin: Math.max(0, (acumuladoS + intervalo) - elapsedMin),
      duracaoFaseMin: intervalo,
      proximo: { simples: true }
    };
  }
  if (!eb.niveis || !eb.niveis.length) return null;
  var acumulado = 0;
  for (var i = 0; i < eb.niveis.length; i++) {
    var n = eb.niveis[i];
    if (elapsedMin < acumulado + n.duracaoMin || i === eb.niveis.length - 1) {
      return {
        idx: i, nivel: n,
        restanteMin: Math.max(0, (acumulado + n.duracaoMin) - elapsedMin),
        duracaoFaseMin: n.duracaoMin,
        proximo: eb.niveis[i + 1] || null
      };
    }
    acumulado += n.duracaoMin;
  }
  return null;
}

async function rtdbGet(accessToken, path) {
  const resp = await fetch(DATABASE_URL + '/' + path + '.json', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!resp.ok) throw new Error('Erro ao ler ' + path + ': ' + resp.status);
  return resp.json();
}

async function rtdbPatch(accessToken, path, data) {
  const resp = await fetch(DATABASE_URL + '/' + path + '.json', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error('Erro ao gravar ' + path + ': ' + resp.status);
}

async function enviarPush(accessToken, token, titulo, corpo) {
  const resp = await fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: token,
        data: { title: titulo, body: corpo },
        webpush: { headers: { Urgency: 'high' } }
      }
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Falha ao enviar push:', resp.status, err);
  }
}

/* Autentica como a Service Account do Firebase (assina um JWT com a
   chave privada e troca por um access token do Google) — usado tanto
   pra ler/gravar no Realtime Database quanto pra mandar o push via FCM. */
async function getAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const base64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = base64url(header) + '.' + base64url(claimSet);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + arrayBufferToBase64Url(signature);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Falha ao obter access token: ' + JSON.stringify(data));
  return data.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64Url(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
