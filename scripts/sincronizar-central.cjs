
"use strict";

const admin = require("firebase-admin");

const ORIGEM_ID = "gaming-pro-4325c";
const CENTRAL_ID = "central-adm-f9b27";

function carregarCredencial(nome, projetoEsperado) {
  const valor = process.env[nome];

  if (!valor) {
    throw new Error("Secret ausente: " + nome);
  }

  let dados;

  try {
    dados = JSON.parse(valor);
  } catch {
    throw new Error("JSON inválido no secret " + nome);
  }

  if (dados.project_id !== projetoEsperado) {
    throw new Error(
      nome + ": projeto incorreto. Esperado: " +
      projetoEsperado
    );
  }

  if (!dados.client_email || !dados.private_key) {
    throw new Error("Credencial incompleta: " + nome);
  }

  return admin.credential.cert(dados);
}

const gaming = admin.initializeApp({
  credential: carregarCredencial(
    "FIREBASE_GAMING_ADMIN",
    ORIGEM_ID
  ),
  projectId: ORIGEM_ID
}, "gaming");

const central = admin.initializeApp({
  credential: carregarCredencial(
    "FIREBASE_CENTRAL_ADMIN",
    CENTRAL_ID
  ),
  projectId: CENTRAL_ID
}, "central");

const authGaming = gaming.auth();
const dbCentral = central.firestore();

const timestamp = () =>
  admin.firestore.FieldValue.serverTimestamp();

function converterData(valor) {
  if (!valor) return null;

  const data = new Date(valor);

  return Number.isNaN(data.getTime())
    ? null
    : admin.firestore.Timestamp.fromDate(data);
}

async function sincronizarUsuarios() {
  let proximaPagina;
  let total = 0;
  let lote = dbCentral.batch();
  let operacoes = 0;

  async function confirmar() {
    if (!operacoes) return;

    await lote.commit();

    lote = dbCentral.batch();
    operacoes = 0;
  }

  do {
    const pagina = await authGaming.listUsers(
      1000,
      proximaPagina
    );

    for (const usuario of pagina.users) {
      const referencia = dbCentral
        .collection("portalUsers")
        .doc("gaming_" + usuario.uid);

      const provedores = usuario.providerData
        .map(p => p.providerId)
        .filter(Boolean);

      lote.set(referencia, {
        portal: "gaming",
        sourceUid: usuario.uid,
        displayName: usuario.displayName || "",
        email: usuario.email || "",
        provider: provedores.join(", ") || "firebase",
        disabled: usuario.disabled === true,
        createdAt: converterData(
          usuario.metadata.creationTime
        ),
        lastLoginAt: converterData(
          usuario.metadata.lastSignInTime
        ),
        syncedAt: timestamp()
      }, {
        merge: true
      });

      total++;
      operacoes++;

      if (operacoes >= 400) {
        await confirmar();
      }
    }

    proximaPagina = pagina.pageToken;

  } while (proximaPagina);

  await confirmar();

  return total;
}

async function executar() {
  console.log("=================================");
  console.log("GAMING PRO → CENTRAL ADM PRO");
  console.log("=================================");

  console.log("Origem:", ORIGEM_ID);
  console.log("Destino:", CENTRAL_ID);

  console.log("Buscando usuários do Firebase Auth...");

  const totalUsuarios = await sincronizarUsuarios();

  console.log("Usuários sincronizados:", totalUsuarios);

  await dbCentral
    .collection("settings")
    .doc("gamingSync")
    .set({
      portal: "gaming",
      status: "connected",
      sourceProject: ORIGEM_ID,
      usersCount: totalUsuarios,
      syncType: "firebase_auth",
      paymentsSynced: false,
      lastSync: timestamp()
    }, {
      merge: true
    });

  console.log("=================================");
  console.log("SINCRONIZAÇÃO CONCLUÍDA");
  console.log("GAMING PRO: CONECTADO");
  console.log("Usuários:", totalUsuarios);
  console.log("=================================");
}

executar()
  .then(() => process.exit(0))
  .catch(erro => {
    console.error("FALHA NA SINCRONIZAÇÃO");
    console.error(erro);
    process.exitCode = 1;
  });
