const fs = require("fs");
const os = require("os");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const puppeteer = require("puppeteer");

const AUTH_DATA_PATH = "./.wwebjs_auth";
const PUBLIC_DIR = path.resolve("./public");
const QR_FILE_PATH = path.join(PUBLIC_DIR, "whatsapp-qr.txt");
const STATUS_FILE_PATH = path.join(PUBLIC_DIR, "whatsapp-status.json");
const EXPECTED_SENDER_NUMBER = (process.env.WHATSAPP_SENDER_NUMBER ?? "73982065794").replace(/\D/g, "");

function ensurePublicDir() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
}

function writeStatus(status) {
  try {
    ensurePublicDir();
    fs.writeFileSync(STATUS_FILE_PATH, JSON.stringify(status, null, 2));
  } catch (error) {
    console.error("❌ Erro ao salvar status do WhatsApp:", error);
  }
}

function saveQrCode(qr) {
  try {
    ensurePublicDir();
    fs.writeFileSync(QR_FILE_PATH, qr);
    console.clear();
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📱 Escaneie o QR Code abaixo com o WhatsApp da Donna Patty:");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    qrcode.generate(qr, { small: true });
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ QR salvo em:", QR_FILE_PATH);
  } catch (error) {
    console.error("❌ Erro ao salvar QR:", error);
  }
}

function clearQrCode() {
  try {
    if (fs.existsSync(QR_FILE_PATH)) {
      fs.unlinkSync(QR_FILE_PATH);
    }
  } catch (error) {
    console.error("❌ Erro ao remover QR antigo:", error);
  }
}

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

let readyDeferred = createDeferred();
let initializing = false;
let client;
let executablePathPromise;

function pathExists(candidate) {
  return Boolean(candidate && fs.existsSync(candidate));
}

function collectEnvExecutables() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
  ];

  const paths = [];
  for (const candidate of envCandidates) {
    if (!candidate) continue;
    const segments = candidate.split(path.delimiter);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed) {
        paths.push(trimmed);
      }
    }
  }

  return paths;
}

function commonSystemExecutables() {
  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

    return [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ];
}

async function ensureChromiumExecutable() {
  if (!executablePathPromise) {
    executablePathPromise = (async () => {
      const envPaths = collectEnvExecutables();
      for (const candidate of envPaths) {
        if (pathExists(candidate)) {
          console.log(`⚙️ Usando navegador definido via variável de ambiente: ${candidate}`);
          return candidate;
        }
      }

      const bundledPath = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : null;
      if (pathExists(bundledPath)) {
        return bundledPath;
      }

      try {
        const { downloadBrowsers } = require("puppeteer/lib/cjs/puppeteer/node/install.js");
        console.log("⬇️ Baixando Chromium necessário para o bot do WhatsApp...");
        await downloadBrowsers();
        const downloadedPath = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : null;
        if (pathExists(downloadedPath)) {
          return downloadedPath;
        }
      } catch (error) {
        console.error("❌ Falha ao baixar Chromium automaticamente:", error);
      }

      const commonPaths = commonSystemExecutables();
      for (const candidate of commonPaths) {
        if (pathExists(candidate)) {
          console.log(`⚙️ Usando navegador detectado no sistema: ${candidate}`);
          return candidate;
        }
      }

      throw new Error(
        "Não foi possível localizar o executável do Chrome/Chromium. Instale o Google Chrome ou execute `pnpm exec puppeteer browsers install chrome` e tente novamente.",
      );
    })();
  }

  return executablePathPromise;
}

async function getClient() {
  if (client) {
    return client;
  }

  const executablePath = await ensureChromiumExecutable();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
    puppeteer: {
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });

  client.on("qr", (qr) => {
    saveQrCode(qr);
    writeStatus({ connected: false, awaitingScan: true });
  });

  client.on("ready", () => {
    clearQrCode();

    const connectedNumber = client.info?.wid?.user ?? "";
    writeStatus({ connected: true, number: connectedNumber });

    if (EXPECTED_SENDER_NUMBER && connectedNumber && connectedNumber !== EXPECTED_SENDER_NUMBER) {
      console.error(
        "⚠️ WhatsApp conectado em um número diferente do esperado.",
        `Esperado: ${EXPECTED_SENDER_NUMBER} | Recebido: ${connectedNumber}`,
      );
    } else {
      console.log(`✅ WhatsApp conectado ao número: ${connectedNumber || "(desconhecido)"}`);
    }

    readyDeferred.resolve?.();
  });

  client.on("auth_failure", (message) => {
    console.error("❌ Falha de autenticação do WhatsApp:", message);
    readyDeferred.reject?.(new Error("Falha de autenticação do WhatsApp"));
  });

  client.on("disconnected", (reason) => {
    console.log("⚠️ WhatsApp desconectado:", reason);
    writeStatus({ connected: false, reason });
    readyDeferred.reject?.(new Error(`WhatsApp desconectado: ${reason}`));
    readyDeferred = createDeferred();
    initializing = false;
    void startClient();
  });

  return client;
}

async function startClient() {
  const instance = await getClient();
  if (initializing) {
    return;
  }
  initializing = true;

  instance
    .initialize()
    .catch((error) => {
      console.error("❌ Erro ao inicializar cliente WhatsApp:", error);
      readyDeferred.reject?.(error);
    })
    .finally(() => {
      initializing = false;
    });
}

void startClient();

async function ensureClientReady() {
  try {
    await readyDeferred.promise;
  } catch (error) {
    console.error("❌ Cliente WhatsApp indisponível:", error);
    throw new Error(
      "Cliente WhatsApp indisponível. Verifique a sessão no WhatsApp Web e tente novamente.",
    );
  }
}

async function sendWhatsAppMessage(to, message) {
  await ensureClientReady();
  const instance = await getClient();

  if (!instance.info) {
    throw new Error("Cliente WhatsApp não está conectado.");
  }

  let formatted = String(to ?? "").trim();
  if (!formatted) {
    throw new Error("Número de destino vazio para WhatsApp.");
  }

  if (!formatted.endsWith("@c.us")) {
    formatted = formatted.replace(/\D/g, "");

    if (!formatted) {
      throw new Error("Número de destino inválido para WhatsApp.");
    }

    if (!formatted.startsWith("55")) {
      formatted = `55${formatted}`;
    }

    formatted = `${formatted}@c.us`;
  }

  await instance.sendMessage(formatted, message);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nMensagem enviada via WhatsApp:\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nPara: ${formatted}\n----------------------------------------\n${message}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function getWhatsAppStatus() {
  try {
    ensurePublicDir();

    if (!fs.existsSync(STATUS_FILE_PATH)) {
      return { connected: false };
    }

    const raw = fs.readFileSync(STATUS_FILE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error("❌ Erro ao ler status do WhatsApp:", error);
    return { connected: false };
  }
}

module.exports = {
  sendWhatsAppMessage,
  getWhatsAppStatus,
};

if (require.main === module) {
  console.log("🤖 Bot WhatsApp em execução. Aguarde o QR Code para autenticar.");
  readyDeferred.promise.catch(() => {
    // Evita rejeição não tratada quando o processo está rodando no modo CLI.
  });
}
